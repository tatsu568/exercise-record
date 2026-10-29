(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-history.js") : root.RecordHistory,
    commonJS ? require("./measurement-attention.js") : root.MeasurementAttention,
    commonJS ? require("./attention-acknowledgements.js") : root.AttentionAcknowledgements,
    commonJS ? require("./app-settings.js") : root.AppSettings);
  if (commonJS) module.exports = api;
  else {
    root.BodyGraphView = api;
    let locks;
    try { locks = root.navigator?.locks; } catch { /* Read-only acknowledgement UI. */ }
    root.RecordGraphView = api.mount({ document, window, storage: localStorage, navigation: root.RecordAppNavigation,
      getTargets: () => root.RecordSettings.getTargets(), getTargetStatus: () => root.RecordSettings.read("goals").error,
      getAttentionSettings: () => root.RecordSettings.getAttention(),
      acknowledgementStore: root.AttentionAcknowledgements.createStore({ storage: localStorage, locks, isSecureContext: window.isSecureContext }) });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, history, attention, acknowledgements, settings) {
  "use strict";
  const KEY = "exercise-record.entries.v1";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const FIELDS = ["weight", "bodyFat"];
  const TITLES = { weight: "体重", bodyFat: "体脂肪率" };
  const INITIAL_TARGETS = Object.freeze({ weight: Object.freeze({ min: 56, max: 56.9 }), bodyFat: Object.freeze({ min: 16, max: 16.9 }) });
  const dateText = (date) => { const { year, month, day } = model.parseDate(date); return `${year}/${month}/${day}`; };
  const axisText = (value) => value !== 0 && (value >= 100000 || value < 0.01) ? value.toExponential(1) : String(value);

  // Hit-testing is separate from SVG event handling. Coordinates are plot-local.
  function nearestPoint(points, x, y, radius = 24) {
    if (![x, y, radius].every(Number.isFinite) || radius <= 0) return null;
    let nearest = null, distance = radius * radius;
    for (const point of points) {
      const squared = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (squared <= distance && (nearest === null || squared < distance)) { nearest = point; distance = squared; }
    }
    return nearest;
  }

  function averagePath(points) {
    const slopes = points.slice(1).map((point, index) => (point.y - points[index].y) / (point.x - points[index].x));
    const tangents = points.map((point, index) => {
      if (!index) return slopes[0];
      if (index === points.length - 1) return slopes[index - 1];
      const before = slopes[index - 1], after = slopes[index];
      return Math.sign(before) === Math.sign(after) ? Math.sign(before) * Math.min(Math.abs(before), Math.abs(after)) : 0;
    });
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], third = (b.x - a.x) / 3;
      // Limited tangents keep both Bezier controls within the endpoint values:
      // smooth joins without overshoot or invented extrema between averages.
      path += ` C ${a.x + third} ${a.y + tangents[index - 1] * third} ${b.x - third} ${b.y - tangents[index] * third} ${b.x} ${b.y}`;
    }
    return path;
  }

  function mount({ document, window, storage, navigation, today = () => model.localDateString(new Date()), getTargets = () => INITIAL_TARGETS, getTargetStatus = () => "",
    getAttentionSettings = () => ({ values: settings.DEFAULTS.attention, error: "" }),
    acknowledgementStore = acknowledgements.createStore({ storage, locks: window.navigator?.locks, isSecureContext: window.isSecureContext }) }) {
    const get = (id) => document.querySelector(`#${id}`);
    const node = (tag, text, className) => {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    };
    const svgNode = (tag, attrs, text) => {
      const item = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("グラフ座標が不正です");
        item.setAttribute(name, String(value));
      }
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const state = { open: false, mode: "all", anchor: null, offset: 0, custom: null, range: null, showMovingAverage: true,
      records: {}, measurements: { weight: [], bodyFat: [], excluded: [] }, selectedDate: null, error: false,
      attention: null, acknowledgement: { confirmed: null, error: "" }, attentionError: "", busy: false, actionMessage: "", actionError: false };
    const parts = {};
    let resizeQueued = false;

    function status(message, error = false) {
      get("graph-status").textContent = message; get("graph-status").dataset.error = String(error);
    }
    function period(mode = state.mode, anchor = state.anchor, offset = state.offset, custom = state.custom) {
      return model.calculatePeriod(mode, { today: today(), anchor, offset, start: custom?.start, end: custom?.end, measurements: state.measurements });
    }
    function widthOf(container) {
      const width = container.getBoundingClientRect?.().width;
      const viewport = document.documentElement?.clientWidth;
      return Number.isFinite(width) && width > 0 ? Math.max(160, width)
        : Number.isFinite(viewport) && viewport > 0 ? Math.max(160, Math.min(620, viewport) - 58) : 262;
    }
    function choose(field, date) {
      const plot = parts[field];
      if (!state.open || state.error || !plot || !plot.data.points.some((point) => point.date === date)) return;
      state.selectedDate = date; renderSelection();
    }
    function measurementDates() {
      return [...new Set(FIELDS.flatMap(field => parts[field]?.data.points.map(point => point.date) || []))].sort();
    }
    function movePoint(delta) {
      if (!state.open || state.error) return;
      const dates = measurementDates(), index = dates.indexOf(state.selectedDate), next = index >= 0 && dates[index + delta];
      if (next) { state.selectedDate = next; renderSelection(); }
    }
    function confirmed(date, field) { return state.acknowledgement.confirmed?.[date]?.[field] === true; }
    function attentionPoint(date, field) { return state.attention?.[field].find((point) => point.date === date); }
    function updateAttention() {
      state.acknowledgement = acknowledgementStore.read();
      state.attention = null; state.attentionError = "";
      try {
        const saved = getAttentionSettings();
        if (saved.error || saved.uncertain) throw new Error(saved.error || "注意判定設定の保存結果が不明です");
        state.attention = attention.evaluateAttention(state.records, saved.values, state.range);
        // The calculation API uses current measurement identities only in memory.
        // Persisted confirmation is resolved solely by date + field, never by value.
        const resolved = state.acknowledgement.error ? null : FIELDS.flatMap((field) => state.attention[field].map((point) => ({
          date: point.date, field, value: point.decimal, status: confirmed(point.date, field) ? "confirmed" : "unconfirmed"
        })));
        state.attention.counts = attention.summarizeAttention(state.attention, resolved);
      } catch (error) { state.attentionError = `注意判定設定を確認してください：${error.message}`; }
      for (const field of FIELDS) {
        const count = state.attention?.counts[field];
        get(`graph-${field}-attention-count`).dataset.empty = String(!state.attentionError && count?.unconfirmedAttention === 0);
        get(`graph-${field}-attention-count`).textContent = state.attentionError ? "注意件数：判定できません"
          : !count || count.unconfirmedAttention === null ? `確認状態不明（注意対象${count?.totalAttention ?? "不明"}件）`
          : `未確認 ${count.unconfirmedAttention}件`;
      }
      get("graph-settings-status").textContent = [getTargetStatus(), state.attentionError].filter(Boolean).join("。 ");
      const message = get("graph-ack-status");
      message.textContent = [state.acknowledgement.error, state.actionMessage].filter(Boolean).join("。 ");
      message.dataset.error = String(Boolean(state.acknowledgement.error) || state.actionError);
    }
    function renderAttentionSelection(field, date) {
      const container = get(`graph-${field}-attention`), point = attentionPoint(date, field), checked = confirmed(date, field);
      container.replaceChildren(); container.hidden = !date || (!point?.isAttention && !checked);
      if (container.hidden) return;
      container.append(node("p", checked ? "確認済み（値や注意条件が変わっても維持します）"
        : state.acknowledgement.error ? "確認状態不明" : "入力値を確認してください（未確認）"));
      if (point?.isAttention) {
        const reasons = node("ul");
        for (const reason of point.reasons) reasons.append(node("li", reason.code === "fixed-below" ? `固定下限 ${reason.bound}${reason.unit} 未満`
          : reason.code === "fixed-above" ? `固定上限 ${reason.bound}${reason.unit} 超`
          : `前回 ${dateText(reason.previousDate)} の ${reason.previousRaw}${field === "weight" ? "kg" : "%"} から${reason.days}日で ${reason.difference}${reason.unit}（急変幅 ${reason.threshold}${reason.unit} 以上）`));
        container.append(reasons);
      }
      const button = node("button", checked ? "未確認に戻す" : "確認済みにする", "date-step graph-ack-toggle");
      button.type = "button"; button.dataset.date = date; button.dataset.field = field;
      button.disabled = state.busy || Boolean(state.acknowledgement.error) || !acknowledgementStore.supported();
      button.addEventListener("click", () => saveAcknowledgement(date, field, !checked)); container.append(button);
      if (!acknowledgementStore.supported()) container.append(node("p", "確認状態の保存はHTTPS対応環境で利用できます"));
    }
    async function saveAcknowledgement(date, field, value) {
      if (state.busy || state.error || state.acknowledgement.error) return;
      state.busy = true; state.actionError = false; state.actionMessage = "確認状態を保存中です";
      render();
      try {
        await acknowledgementStore.setConfirmed(date, field, value);
        state.actionMessage = `${dateText(date)}の${TITLES[field]}を${value ? "確認済み" : "未確認"}にしました`;
      } catch (error) { state.actionMessage = error.message; state.actionError = true; }
      finally { state.busy = false; refresh(); }
    }
    function renderSelection() {
      const dates = measurementDates();
      if (!dates.includes(state.selectedDate)) state.selectedDate = dates.at(-1) || null;
      const index = dates.indexOf(state.selectedDate), values = {};
      get("graph-point-previous").disabled = index <= 0;
      get("graph-point-next").disabled = index < 0 || index >= dates.length - 1;
      for (const field of FIELDS) {
        const plot = parts[field], point = plot?.data.points.find(item => item.date === state.selectedDate);
        values[field] = point ? point.raw + (field === "weight" ? "kg" : "%") : "—";
        if (plot?.marker) {
          plot.marker.setAttribute("visibility", point ? "visible" : "hidden");
          plot.guide.setAttribute("visibility", point ? "visible" : "hidden");
          plot.marker.dataset.date = point?.date || "";
          if (point) {
            const x = plot.left + point.x, y = plot.top + point.y;
            for (const [name, value] of Object.entries({ x1: x, x2: x, y1: plot.top, y2: plot.top + plot.height })) plot.guide.setAttribute(name, String(value));
            plot.marker.setAttribute("cx", String(x)); plot.marker.setAttribute("cy", String(y));
          }
        }
        renderAttentionSelection(field, point ? state.selectedDate : null);
      }
      get("graph-selected").textContent = state.selectedDate ? `${dateText(state.selectedDate)}　${values.weight}　${values.bodyFat}` : "記録なし";
    }
    function tapPosition(svg, event, width, height) {
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
      try {
        if (svg.createSVGPoint && svg.getScreenCTM) {
          const matrix = svg.getScreenCTM();
          if (matrix) {
            const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
            const local = point.matrixTransform(matrix.inverse());
            if (Number.isFinite(local.x) && Number.isFinite(local.y)) return local;
          }
        }
      } catch { /* Detached SVGs may have no transform; use a measured fallback. */ }
      const bounds = svg.getBoundingClientRect?.();
      if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
      return { x: (event.clientX - bounds.left) / bounds.width * width, y: (event.clientY - bounds.top) / bounds.height * height };
    }
    function renderDateTicks(svg, group, range, plotWidth, left, baseline, width) {
      function textWidth(item) {
        const measured = item.getComputedTextLength?.();
        // A detached SVG/test DOM may not expose font metrics. Stay conservative.
        return Number.isFinite(measured) && measured > 0 ? measured
          : [...item.textContent].reduce((sum, char) => sum + (char === "/" ? 3.5 : 6.5), 0);
      }
      function draw(ticks, twoLines) {
        group.replaceChildren();
        const bounds = ticks.map((tick) => {
          const x = left + tick.x, splitYear = twoLines && tick.label.split("/").length === 3;
          const label = svgNode("text", { x, y: baseline + (twoLines ? splitYear ? 16 : 29 : 22),
            class: "graph-axis-label graph-date-label", "aria-label": tick.label });
          label.dataset.tickDate = tick.date;
          if (splitYear) {
            const [year, month, day] = tick.label.split("/");
            label.append(svgNode("tspan", { x }, year + "/"), svgNode("tspan", { x, dy: 13 }, `${month}/${day}`));
          } else label.textContent = tick.label;
          group.append(label);
          const size = splitYear ? Math.max(...Array.from(label.children).map(textWidth)) : textWidth(label);
          // Use available SVG side margins without moving the date's anchor x.
          const anchor = x - size / 2 < 0 ? "start" : x + size / 2 > width ? "end" : "middle";
          label.setAttribute("text-anchor", anchor);
          const start = x - (anchor === "end" ? size : anchor === "middle" ? size / 2 : 0);
          return { start, end: start + size };
        });
        return bounds.every((bound, index) => bound.start >= 0 && bound.end <= width
          && (!index || bound.start - bounds[index - 1].end >= 6));
      }
      const crossYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
      for (let count = Math.min(5, model.daysBetween(range.start, range.end) + 1); count >= 1; count--) {
        const ticks = model.makeXTicks(range, plotWidth, { minLabelSpacing: 1, maxTicks: count });
        if (draw(ticks, false) || (crossYear && draw(ticks, true))) return;
      }
    }
    function renderField(field, targets) {
      const container = get(`graph-${field}-plot`), width = widthOf(container), top = 12, bottom = 32, right = 12, height = 180;
      const visible = model.filterMeasurements(state.measurements[field], state.range);
      const averages = state.showMovingAverage ? model.movingAverageSegments(state.measurements[field], state.range) : [];
      const extraValues = averages.flatMap((segment) => segment.map((point) => point.value));
      // Existing total span: 1.2 times; 25% margins make it 1.5 times (25% wider).
      const axisOptions = { extraValues, padding: .25 };
      const axis = model.calculateYAxis(visible, targets[field], axisOptions);
      const left = Math.max(38, Math.min(90, Math.max(...axis.ticks.map((tick) => axisText(tick.value).length)) * 6 + 10));
      const plotWidth = Math.max(1, width - left - right);
      const data = model.buildChartData(visible, state.range, targets[field], { field, width: plotWidth, height,
        minLabelSpacing: 1, ...axisOptions });
      const unit = field === "weight" ? "kg" : "%";
      get(`graph-${field}-goal`).textContent = `目標：${targets[field].min.toFixed(1)}〜${targets[field].max.toFixed(1)}${unit}`;
      container.replaceChildren();
      get(`graph-${field}-empty`).hidden = data.points.length > 0;
      const summary = get(`graph-${field}-summary`); summary.replaceChildren(); summary.hidden = !data.points.length;
      parts[field] = { data, width, height, left, top };
      if (!data.points.length) return;
      const change = data.summary.change === null ? "—" : `${data.summary.change.startsWith("-") ? "−" + data.summary.change.slice(1)
        : data.summary.change === "0" ? "0" : "+" + data.summary.change}${field === "bodyFat" ? "pt" : data.summary.changeUnit}`;
      for (const [label, value] of [["最初", data.summary.first.raw + unit], ["最後", data.summary.last.raw + unit], ["変化量", change]]) {
        const item = node("dl"); item.append(node("dt", label + "："), node("dd", value)); summary.append(item);
      }
      const svg = svgNode("svg", { viewBox: `0 0 ${width} ${top + height + bottom}`, width, height: top + height + bottom,
        role: "img", tabindex: "0", "aria-label": `${TITLES[field]}。測定${data.points.length}件。${state.showMovingAverage ? "点付きの線は実測値、細い補助線は4週間移動平均です。" : "実測値を表示しています。"}点をタップ、または下の共通の前の測定・次の測定で選択できます。` });
      if (data.targetBand.collapsed) svg.append(svgNode("line", { x1: left, x2: left + plotWidth, y1: top + data.targetBand.top, y2: top + data.targetBand.top, class: "graph-target-band" }));
      else svg.append(svgNode("rect", { x: left, y: top + data.targetBand.top, width: plotWidth, height: data.targetBand.height, class: "graph-target-band" }));
      for (const tick of data.yAxis.ticks) {
        svg.append(svgNode("line", { x1: left, x2: left + plotWidth, y1: top + tick.y, y2: top + tick.y, class: "graph-grid-line" }),
          svgNode("text", { x: left - 6, y: top + tick.y + 4, "text-anchor": "end", class: "graph-axis-label" }, axisText(tick.value)));
      }
      svg.append(svgNode("line", { x1: left, x2: left, y1: top, y2: top + height, class: "graph-axis" }),
        svgNode("line", { x1: left, x2: left + plotWidth, y1: top + height, y2: top + height, class: "graph-axis" }));
      const dateTicks = svgNode("g", {}); svg.append(dateTicks);
      if (data.points.length > 1) svg.append(svgNode("polyline", { points: data.points.map((point) => `${left + point.x},${top + point.y}`).join(" "), class: "graph-measurement-line" }));
      for (const segment of averages) {
        if (segment.length < 2) continue;
        const points = segment.map((point) => ({ x: left + model.calculateX(point.date, state.range, plotWidth), y: top + model.calculateY(point.value, data.yAxis, height) }));
        svg.append(svgNode("path", { d: averagePath(points), class: "graph-moving-average", "pointer-events": "none", "aria-hidden": "true" }));
      }
      for (const point of data.points) {
        const circle = svgNode("circle", { cx: left + point.x, cy: top + point.y, r: 3, class: "graph-point" });
        circle.dataset.date = point.date; svg.append(circle);
        if (attentionPoint(point.date, field)?.isAttention && !confirmed(point.date, field)) {
          svg.append(svgNode("circle", { cx: left + point.x, cy: top + point.y, r: 7.5, class: "graph-attention-mark" }));
        }
      }
      const guide = svgNode("line", { class: "graph-guide" }), marker = svgNode("circle", { r: 5, class: "graph-selection" });
      svg.append(guide, marker); Object.assign(parts[field], { svg, guide, marker });
      svg.addEventListener("click", (event) => {
        const direct = event.target?.dataset?.date;
        if (direct) { choose(field, direct); return; }
        const local = tapPosition(svg, event, width, top + height + bottom);
        const point = local && nearestPoint(data.points, local.x - left, local.y - top);
        if (point) choose(field, point.date);
      });
      svg.addEventListener("keydown", (event) => {
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); movePoint(event.key === "ArrowLeft" ? -1 : 1); }
      });
      container.append(svg);
      renderDateTicks(svg, dateTicks, state.range, plotWidth, left, top + height, width);
    }
    function controls() {
      get("graph-moving-average").checked = state.showMovingAverage;
      get("graph-moving-average").disabled = state.error;
      for (const field of FIELDS) get(`graph-${field}-average-legend`).hidden = !state.showMovingAverage;
      get("graph-period").value = state.mode;
      get("graph-period").disabled = state.error;
      get("graph-custom").hidden = state.mode !== "custom";
      get("graph-range").textContent = state.range ? `対象期間：${dateText(state.range.start)}〜${dateText(state.range.end)}` : "対象期間：測定記録なし";
      const rolling = !["all", "custom"].includes(state.mode);
      get("graph-previous").disabled = !rolling || state.error;
      get("graph-next").disabled = !rolling || state.offset === 0 || state.error;
      get("graph-latest").disabled = !rolling || state.error;
      if (rolling && !state.error) {
        try { period(state.mode, state.anchor, state.offset - 1); } catch { get("graph-previous").disabled = true; }
      }
    }
    function render(resetSelection = false) {
      if (resetSelection) state.selectedDate = null;
      controls();
      const targets = getTargets();
      updateAttention();
      for (const field of FIELDS) renderField(field, targets);
      renderSelection();
    }
    function showError(error) {
      state.error = true; status(`グラフを読み込めません：${error.message}。保存内容は変更していません。`, true);
      for (const field of FIELDS) {
        get(`graph-${field}-plot`).replaceChildren(); get(`graph-${field}-summary`).hidden = true;
        get(`graph-${field}-empty`).hidden = true;
        get(`graph-${field}-attention-count`).textContent = "注意情報を表示できません";
        get(`graph-${field}-attention-count`).dataset.empty = "false";
        get(`graph-${field}-attention`).hidden = true;
        delete parts[field];
      }
      get("graph-selected").textContent = "表示できません";
      get("graph-point-previous").disabled = true; get("graph-point-next").disabled = true;
      controls();
    }
    function refresh() {
      if (!state.open) return;
      try {
        const records = history.read(storage.getItem(KEY));
        state.records = records;
        state.measurements = model.extractMeasurements(records);
        if (!state.anchor || (state.offset === 0 && !["all", "custom"].includes(state.mode))) state.anchor = today();
        const next = period(), changed = JSON.stringify(next) !== JSON.stringify(state.range);
        state.range = next; state.error = false;
        const invalid = state.measurements.excluded.filter((point) => point.reason === "invalid").length;
        status(invalid ? `不正な型・値の測定項目${invalid}件を表示から除外しました。保存値は変更していません。` : "測定点をタップ、または前後の測定ボタンで選択できます。");
        // Data-driven all-period expansion is a reread, not a user's period change.
        render(changed && !["all", "custom"].includes(state.mode));
      } catch (error) { showError(error); }
    }
    function changeMode() {
      if (!state.open || state.error) { get("graph-period").value = state.mode; return; }
      try {
        const mode = get("graph-period").value, custom = state.range || model.rollingPeriod(today(), 3);
        const next = period(mode, today(), 0, custom);
        state.mode = mode; state.anchor = today(); state.offset = 0; state.custom = { ...custom }; state.range = next;
        if (mode === "custom") { get("graph-start-date").value = custom.start; get("graph-end-date").value = custom.end; }
        state.error = false; status(""); render(true);
      } catch (error) { get("graph-period").value = state.mode; status(error.message, true); }
    }
    function movePeriod(delta) {
      if (!state.open || state.error || ["all", "custom"].includes(state.mode)) return;
      try {
        const offset = state.offset + delta, anchor = offset === 0 ? today() : state.anchor;
        const next = period(state.mode, anchor, offset);
        state.offset = offset; state.anchor = anchor; state.range = next; status(""); render(true);
      } catch (error) { status(error.message, true); }
    }
    get("graph-period").addEventListener("change", changeMode);
    get("graph-moving-average").addEventListener("change", () => {
      state.showMovingAverage = get("graph-moving-average").checked;
      if (!state.open || state.error) return;
      const targets = getTargets();
      for (const field of FIELDS) { renderField(field, targets); get(`graph-${field}-average-legend`).hidden = !state.showMovingAverage; }
      renderSelection();
    });
    get("graph-previous").addEventListener("click", () => movePeriod(-1));
    get("graph-next").addEventListener("click", () => movePeriod(1));
    get("graph-latest").addEventListener("click", () => {
      if (!state.open || state.error || ["all", "custom"].includes(state.mode)) return;
      state.anchor = today(); state.offset = 0; state.range = period(); status(""); render(true);
    });
    get("graph-apply-dates").addEventListener("click", () => {
      if (!state.open || state.mode !== "custom" || state.error) return;
      try {
        const next = model.customPeriod(get("graph-start-date").value, get("graph-end-date").value);
        state.custom = next; state.range = next; status(""); render(true);
      } catch (error) { status(error.message, true); }
    });
    for (const [suffix, delta] of [["previous", -1], ["next", 1]]) {
      get(`graph-point-${suffix}`).addEventListener("click", () => movePoint(delta));
    }
    navigation.connectPeriodSwipe({ element: get("graph-screen"), window, enabled: () => state.open && !state.error && !state.busy,
      move: (direction) => get(direction < 0 ? "graph-previous" : "graph-next").click() });
    navigation.register("graph", { heading: "graph-heading", onShow() { state.open = true; refresh(); }, onHide() { state.open = false; } });
    function resize() {
      if (!state.open || state.error || resizeQueued) return;
      const draw = () => { resizeQueued = false; if (state.open && !state.error) { try { render(); } catch (error) { showError(error); } } };
      resizeQueued = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(draw); else draw();
    }
    window.addEventListener("resize", resize);
    if (typeof window.ResizeObserver === "function") {
      const observer = new window.ResizeObserver(() => {
        if (FIELDS.some((field) => parts[field] && Math.abs(widthOf(get(`graph-${field}-plot`)) - parts[field].width) > 0.5)) resize();
      });
      for (const field of FIELDS) observer.observe(get(`graph-${field}-plot`));
    }
    window.addEventListener("storage", (event) => {
      if ([KEY, "exercise-record.goals.v1", "exercise-record.attention-settings.v1", acknowledgements.KEY, null].includes(event.key)) refresh();
    });
    window.addEventListener("pagehide", () => acknowledgementStore.cancelPending());
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh);
    return Object.freeze({ open: () => navigation.show("graph"), refresh,
      getState: () => ({ mode: state.mode, anchor: state.anchor, offset: state.offset, range: state.range && { ...state.range }, selectedDate: state.selectedDate, error: state.error }) });
  }
  return Object.freeze({ mount, nearestPoint });
});
