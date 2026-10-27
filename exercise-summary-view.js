(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./exercise-summary.js") : root.ExerciseSummary,
    commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-history.js") : root.RecordHistory);
  if (commonJS) module.exports = api;
  else {
    root.ExerciseSummaryView = api;
    root.RecordSummaryView = api.mount({ document, window, navigation: root.RecordAppNavigation,
      storage: { getItem(key) { return localStorage.getItem(key); } } });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, calendar, history) {
  "use strict";
  const KEY = "exercise-record.entries.v1", SVG_NS = "http://www.w3.org/2000/svg";
  const dateText = (date) => date.replace(/-/g, "/");
  const rangeText = (range) => `${dateText(range.start)}（月）〜${dateText(range.end)}（日）`;

  function mount({ document, window, storage, navigation, today = () => calendar.localDateString(new Date()) }) {
    const get = (id) => document.querySelector(`#${id}`);
    const state = { open: false, range: null, latest: null, field: "squat", data: null, error: "" };
    const cards = {};
    const node = (tag, text, className) => {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    };
    const svgNode = (tag, attributes, text) => {
      const item = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, String(value));
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const plotNumber = (value) => value !== 0 && (Math.abs(value) >= 100000 || Math.abs(value) < .01)
      ? value.toExponential(1) : String(Number(value.toPrecision(4)));

    function renderPlot() {
      const plot = get("summary-plot"), metric = model.METRICS.find(({ field }) => field === state.field);
      plot.dataset.field = state.field;
      get("summary-chart-heading").textContent = `${metric.label}・週ごとの${metric.field === "standing" ? "平均" : "合計"}（${metric.unit}）`;
      plot.replaceChildren();
      if (!state.data) { plot.append(node("p", "保存データを確認できないため、表示できません")); return; }
      const rows = state.data.weeks.map((week) => ({ ...week, result: week.metrics[state.field] }));
      const values = rows.filter(({ result }) => result.value !== null).map(({ result }) => Number(result.value));
      if (values.some((value) => !Number.isFinite(value))) { plot.append(node("p", "値が大きすぎるため、棒グラフを表示できません。集計値はカードで確認できます。")); return; }
      const measured = plot.getBoundingClientRect?.().width;
      const width = Math.max(240, measured || (document.documentElement?.clientWidth || 375) - 58);
      const left = 42, top = 18, height = 154, baseline = top + height, lane = (width - left - 8) / 4;
      // The shared body-graph axis accepts positive bounds; its padding clamps
      // this smallest positive lower bound to zero for a zero-based bar chart.
      const peak = Math.max(0, ...values), axis = calendar.calculateYAxis([], { min: Number.MIN_VALUE, max: peak || 1 }, { minSpan: peak || 1, tickCount: 4 });
      const accessible = rows.map((week, index) => `第${index + 1}週 ${rangeText(week)}：${week.result.value === null ? "データなし" : week.result.value + metric.unit}`).join("。 ");
      const svg = svgNode("svg", { viewBox: `0 0 ${width} 214`, width, height: 214, role: "img", "aria-label": `${metric.label}。${accessible}` });
      for (const tick of axis.ticks) {
        const y = top + calendar.calculateY(tick.value, axis, height);
        svg.append(svgNode("line", { x1: left, x2: width - 8, y1: y, y2: y, class: "graph-grid-line" }),
          svgNode("text", { x: left - 5, y: y + 4, "text-anchor": "end", class: "graph-axis-label" }, plotNumber(tick.value)));
      }
      rows.forEach((week, index) => {
        const x = left + lane * (index + .5), result = week.result;
        const group = svgNode("g", { class: "summary-week", "data-week": index + 1, "data-value": result.value ?? "" });
        group.append(svgNode("title", {}, `第${index + 1}週 ${rangeText(week)}：${result.value === null ? "データなし" : result.value + metric.unit}（有効${result.count}日）`));
        if (result.value !== null) {
          const y = top + calendar.calculateY(Number(result.value), axis, height);
          // A saved zero is a baseline marker, never a fabricated positive bar.
          group.append(result.value === "0" ? svgNode("line", { x1: x - 12, x2: x + 12, y1: baseline, y2: baseline, class: "summary-zero" })
            : svgNode("rect", { x: x - lane * .27, y, width: lane * .54, height: baseline - y, rx: 3, class: "summary-bar" }));
          group.append(svgNode("text", { x, y: Math.max(12, y - 6), "text-anchor": "middle", class: "graph-axis-label" }, plotNumber(Number(result.value))));
        } else group.append(svgNode("text", { x, y: baseline - 8, "text-anchor": "middle", class: "summary-no-data" }, "データなし"));
        group.append(svgNode("text", { x, y: baseline + 21, "text-anchor": "middle", class: "graph-axis-label" }, `第${index + 1}週`));
        const short = (date) => { const p = calendar.parseDate(date); return `${p.month}/${p.day}`; };
        const end = week.start.slice(0, 7) === week.end.slice(0, 7) ? String(calendar.parseDate(week.end).day) : short(week.end);
        group.append(svgNode("text", { x, y: baseline + 36, "text-anchor": "middle", class: "summary-week-dates" }, `${short(week.start)}〜${end}`));
        svg.append(group);
      });
      plot.append(svg);
    }

    function render() {
      if (state.range) get("summary-range").textContent = rangeText(state.range);
      get("summary-saved-days").textContent = state.data ? `記録日数：${state.data.current.savedDays} / 28日` : "記録日数：確認できません";
      get("summary-comparison-range").textContent = state.data ? `比較：${rangeText(state.data.previous.range)}` : "";
      const excluded = state.data ? Object.values(state.data.current.metrics).reduce((count, metric) => count + metric.invalid, 0) : 0;
      const previousExcluded = state.data ? Object.values(state.data.previous.metrics).reduce((count, metric) => count + metric.invalid, 0) : 0;
      get("summary-status").textContent = state.error || (excluded || previousExcluded ? `不正な値は集計から除外しています（今回${excluded}項目・前4週${previousExcluded}項目）。保存値は変更していません。` : "");
      get("summary-status").dataset.error = String(Boolean(state.error));
      get("summary-previous").disabled = !state.range || !state.latest || !model.movePeriod(state.range, -1, state.latest);
      get("summary-next").disabled = !state.range || !state.latest || !model.movePeriod(state.range, 1, state.latest);
      get("summary-latest").disabled = !state.range || !state.latest || state.range.end === state.latest.end;
      for (const { field, unit } of model.METRICS) {
        const card = cards[field], metric = state.data?.current.metrics[field], comparison = state.data?.comparisons[field];
        card.button.setAttribute("aria-pressed", String(field === state.field));
        card.value.textContent = !metric ? "表示できません" : metric.value === null ? "データなし" : metric.value + unit;
        card.count.textContent = metric ? `${field === "standing" ? "平均対象" : "データのある日"}：${metric.count}日` : "有効日数：—";
        card.change.dataset.direction = comparison?.direction || "unavailable";
        card.change.textContent = !comparison || comparison.change === null ? "前4週と比較不可" : comparison.direction === "same" ? "前4週より 変化なし"
          : `前4週より ${comparison.direction === "increase" ? "+" : "−"}${comparison.change.replace(/^-/, "")}${unit}`;
      }
      renderPlot();
    }
    function refresh() {
      if (!state.open) return;
      try {
        const latest = model.latestPeriod(today());
        if (!state.range || state.range.end === state.latest?.end || state.range.end > latest.end) state.range = latest;
        state.latest = latest;
        state.data = model.buildSummary(history.read(storage.getItem(KEY)), state.range); state.error = "";
      } catch (error) { state.data = null; state.error = error.message || "保存データを読み取れません。保存内容は変更していません。"; }
      render();
    }
    for (const metric of model.METRICS) {
      const button = node("button", undefined, "summary-card"), label = node("span", metric.label, "summary-card-label");
      button.type = "button"; button.dataset.field = metric.field; button.setAttribute("aria-controls", "summary-plot");
      const value = node("strong", "", "summary-card-value"), change = node("span", "", "summary-card-change"), count = node("span", "", "summary-card-count");
      button.append(label, value, change, count); get("summary-cards").append(button);
      cards[metric.field] = { button, value, change, count };
      button.addEventListener("click", () => { state.field = metric.field; render(); });
    }
    for (const [id, direction] of [["summary-previous", -1], ["summary-next", 1]]) get(id).addEventListener("click", () => {
      if (!state.range || !state.latest) return;
      const next = model.movePeriod(state.range, direction, state.latest);
      if (next) { state.range = next; refresh(); }
    });
    get("summary-latest").addEventListener("click", () => {
      if (!state.open) return;
      state.range = null; refresh();
    });
    navigation.register("summary", { heading: "summary-heading", onShow() { state.open = true; refresh(); }, onHide() { state.open = false; } });
    window.addEventListener("storage", (event) => { if (event.key === KEY || event.key === null) refresh(); });
    for (const name of ["focus", "pageshow"]) window.addEventListener(name, refresh);
    window.addEventListener("resize", () => { if (state.open) renderPlot(); });
    return Object.freeze({ open: () => navigation.show("summary"), refresh,
      getState: () => ({ range: state.range && { ...state.range }, field: state.field, error: state.error }) });
  }
  return Object.freeze({ mount });
});
