(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-history.js") : root.RecordHistory);
  if (commonJS) module.exports = api;
  else {
    root.BodyGraphView = api;
    root.RecordGraphView = api.mount({ document, window, storage: localStorage, navigation: root.RecordAppNavigation });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, history) {
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

  function mount({ document, window, storage, navigation, today = () => model.localDateString(new Date()), getTargets = () => INITIAL_TARGETS }) {
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
    const state = { open: false, mode: "3m", anchor: null, offset: 0, custom: null, range: null,
      measurements: { weight: [], bodyFat: [], excluded: [] }, selected: { weight: null, bodyFat: null }, error: false };
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
      state.selected[field] = date; renderSelection(field);
    }
    function movePoint(field, delta) {
      const points = parts[field]?.data.points || [], selection = model.selectionInfo(points, state.selected[field]);
      const next = model.adjacentMeasurement(points, selection.index, delta);
      if (next) choose(field, next.date);
    }
    function renderSelection(field) {
      const plot = parts[field], points = plot?.data.points || [];
      const selection = model.selectionInfo(points, state.selected[field]);
      get(`graph-${field}-previous`).disabled = !selection.previous;
      get(`graph-${field}-next`).disabled = !selection.next;
      if (!selection.point) { state.selected[field] = null; get(`graph-${field}-selected`).textContent = ""; return; }
      const point = points[selection.index]; state.selected[field] = point.date;
      const x = plot.left + point.x, y = plot.top + point.y;
      for (const [name, value] of Object.entries({ x1: x, x2: x, y1: plot.top, y2: plot.top + plot.height })) plot.guide.setAttribute(name, String(value));
      plot.marker.setAttribute("cx", String(x)); plot.marker.setAttribute("cy", String(y));
      plot.marker.dataset.date = point.date;
      get(`graph-${field}-selected`).textContent = `${dateText(point.date)}　${point.raw}${field === "weight" ? "kg" : "%"}`;
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
      const axis = model.calculateYAxis(visible, targets[field]);
      const left = Math.max(38, Math.min(90, Math.max(...axis.ticks.map((tick) => axisText(tick.value).length)) * 6 + 10));
      const plotWidth = Math.max(1, width - left - right);
      const data = model.buildChartData(visible, state.range, targets[field], { field, width: plotWidth, height,
        minLabelSpacing: 1 });
      const unit = field === "weight" ? "kg" : "%";
      get(`graph-${field}-goal`).textContent = `目標：${targets[field].min.toFixed(1)}〜${targets[field].max.toFixed(1)}${unit}`;
      container.replaceChildren();
      get(`graph-${field}-empty`).hidden = data.points.length > 0;
      const summary = get(`graph-${field}-summary`); summary.replaceChildren(); summary.hidden = !data.points.length;
      parts[field] = { data, width, height, left, top };
      if (!data.points.length) { renderSelection(field); return; }
      const change = data.summary.change === null ? "—" : `${data.summary.change.startsWith("-") ? "−" + data.summary.change.slice(1)
        : data.summary.change === "0" ? "0" : "+" + data.summary.change}${field === "bodyFat" ? "pt" : data.summary.changeUnit}`;
      for (const [label, value] of [["最初", data.summary.first.raw + unit], ["最後", data.summary.last.raw + unit], ["変化量", change]]) {
        const item = node("dl"); item.append(node("dt", label + "："), node("dd", value)); summary.append(item);
      }
      const svg = svgNode("svg", { viewBox: `0 0 ${width} ${top + height + bottom}`, width, height: top + height + bottom,
        role: "img", tabindex: "0", "aria-label": `${TITLES[field]}。測定${data.points.length}件。点をタップ、または下の前の測定・次の測定で選択できます。` });
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
      for (const point of data.points) {
        const circle = svgNode("circle", { cx: left + point.x, cy: top + point.y, r: 3, class: "graph-point" });
        circle.dataset.date = point.date; svg.append(circle);
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
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); movePoint(field, event.key === "ArrowLeft" ? -1 : 1); }
      });
      container.append(svg);
      renderDateTicks(svg, dateTicks, state.range, plotWidth, left, top + height, width);
      renderSelection(field);
    }
    function controls() {
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
      if (resetSelection) state.selected = { weight: null, bodyFat: null };
      controls();
      const targets = getTargets();
      for (const field of FIELDS) renderField(field, targets);
    }
    function showError(error) {
      state.error = true; status(`グラフを読み込めません：${error.message}。保存内容は変更していません。`, true);
      for (const field of FIELDS) {
        get(`graph-${field}-plot`).replaceChildren(); get(`graph-${field}-summary`).hidden = true;
        get(`graph-${field}-empty`).hidden = true; get(`graph-${field}-selected`).textContent = "表示できません";
        get(`graph-${field}-previous`).disabled = true; get(`graph-${field}-next`).disabled = true;
        delete parts[field];
      }
      controls();
    }
    function refresh() {
      if (!state.open) return;
      try {
        const records = history.read(storage.getItem(KEY));
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
    for (const field of FIELDS) for (const [suffix, delta] of [["previous", -1], ["next", 1]]) {
      get(`graph-${field}-${suffix}`).addEventListener("click", () => movePoint(field, delta));
    }
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
    window.addEventListener("storage", (event) => { if (event.key === KEY || event.key === null) refresh(); });
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh);
    return Object.freeze({ open: () => navigation.show("graph"), refresh,
      getState: () => ({ mode: state.mode, anchor: state.anchor, offset: state.offset, range: state.range && { ...state.range }, selected: { ...state.selected }, error: state.error }) });
  }
  return Object.freeze({ mount, nearestPoint });
});
