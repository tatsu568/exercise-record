(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./exercise-summary.js") : root.ExerciseSummary,
    commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-history.js") : root.RecordHistory,
    commonJS ? require("./app-settings.js") : root.AppSettings);
  if (commonJS) module.exports = api;
  else {
    root.ExerciseSummaryView = api;
    root.RecordSummaryView = api.mount({ document, window, navigation: root.RecordAppNavigation,
      storage: { getItem(key) { return localStorage.getItem(key); } }, settings: root.RecordSettings });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, calendar, history, settingsModel) {
  "use strict";
  const KEY = "exercise-record.entries.v1", SVG_NS = "http://www.w3.org/2000/svg";
  const dateText = (date, includeYear = true) => {
    const { year, month, day } = calendar.parseDate(date);
    return `${includeYear ? year + "/" : ""}${month}/${day}`;
  };
  const rangeText = (range) => `${dateText(range.start)}(月)〜${dateText(range.end, range.start.slice(0, 4) !== range.end.slice(0, 4))}(日)`;
  const displayNumber = (field, value) => field === "walkSteps" ? value.replace(/(\d)(?=(\d{3})+$)/g, "$1,") : value;
  const unitText = (metric) => metric.field === "standing" ? "H" : metric.unit;

  function mount({ document, window, storage, navigation, settings = settingsModel.createStore(storage), today = () => calendar.localDateString(new Date()) }) {
    const get = (id) => document.querySelector(`#${id}`);
    const state = { open: false, range: null, latest: null, field: "squat", data: null, error: "", goals: {}, goalError: "" };
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
      const goal = state.goals[state.field], unit = unitText(metric);
      plot.dataset.field = state.field;
      get("summary-chart-heading").textContent = `${metric.label.replace(/(合計|平均)$/, "")}・週ごとの${metric.field === "standing" ? "平均" : "合計"} (${unit})`;
      plot.replaceChildren();
      if (!state.data) { plot.append(node("p", "保存データを確認できないため、表示できません")); return; }
      const rows = state.data.weeks.map((week) => ({ ...week, result: week.metrics[state.field] }));
      const values = rows.filter(({ result }) => result.value !== null).map(({ result }) => Number(result.value));
      if (values.some((value) => !Number.isFinite(value))) { plot.append(node("p", "値が大きすぎるため、棒グラフを表示できません。集計値はカードで確認できます。")); return; }
      const measured = plot.getBoundingClientRect?.().width;
      const width = Math.max(240, measured || (document.documentElement?.clientWidth || 375) - 58);
      const left = 42, top = goal ? 36 : 18, height = goal ? 136 : 154, baseline = top + height, lane = (width - left - 8) / 4;
      // The shared body-graph axis accepts positive bounds; its padding clamps
      // this smallest positive lower bound to zero for a zero-based bar chart.
      const peak = Math.max(0, ...values, goal || 0), axis = calendar.calculateYAxis([], { min: Number.MIN_VALUE, max: peak || 1 }, { minSpan: peak || 1, tickCount: 4 });
      const accessible = rows.map((week, index) => `第${index + 1}週 ${rangeText(week)}：${week.result.value === null ? "データなし" : week.result.value + unit}`).join("。 ");
      const goalLabel = goal ? `目標 ${displayNumber(state.field, String(goal))}${unit}${state.field === "standing" ? "／日" : "／週"}` : "";
      const svg = svgNode("svg", { viewBox: `0 0 ${width} 214`, width, height: 214, role: "img", "aria-label": `${metric.label}。${accessible}${goalLabel ? "。" + goalLabel : ""}` });
      for (const tick of axis.ticks) {
        const y = top + calendar.calculateY(tick.value, axis, height);
        svg.append(svgNode("line", { x1: left, x2: width - 8, y1: y, y2: y, class: "graph-grid-line" }),
          svgNode("text", { x: left - 5, y: y + 4, "text-anchor": "end", class: "graph-axis-label" }, plotNumber(tick.value)));
      }
      rows.forEach((week, index) => {
        const x = left + lane * (index + .5), result = week.result;
        const group = svgNode("g", { class: "summary-week", "data-week": index + 1, "data-value": result.value ?? "" });
        group.append(svgNode("title", {}, `第${index + 1}週 ${rangeText(week)}：${result.value === null ? "データなし" : result.value + unit}（有効${result.count}日）`));
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
      if (goal) {
        const y = top + calendar.calculateY(goal, axis, height);
        svg.append(svgNode("line", { x1: left, x2: width - 8, y1: y, y2: y, class: "summary-goal-line", "data-goal": goal }),
          svgNode("text", { x: left, y: 16, class: "summary-goal-label" }, goalLabel));
      }
      plot.append(svg);
    }

    function render() {
      if (state.range) get("summary-range").textContent = rangeText(state.range);
      get("summary-saved-days").textContent = state.data ? `(${state.data.current.savedDays}/28)` : "(—/28)";
      get("summary-saved-days").setAttribute("aria-label", state.data ? `28日間のうち保存済み記録${state.data.current.savedDays}日` : "記録日数を確認できません");
      get("summary-comparison-range").textContent = state.data ? `比較：${rangeText(state.data.previous.range)}` : "";
      const excluded = state.data ? Object.values(state.data.current.metrics).reduce((count, metric) => count + metric.invalid, 0) : 0;
      const previousExcluded = state.data ? Object.values(state.data.previous.metrics).reduce((count, metric) => count + metric.invalid, 0) : 0;
      get("summary-status").textContent = state.error || (excluded || previousExcluded ? `不正な値は集計から除外しています（今回${excluded}項目・前4週${previousExcluded}項目）。保存値は変更していません。` : "");
      get("summary-status").dataset.error = String(Boolean(state.error));
      get("summary-goal-status").textContent = state.goalError;
      get("summary-previous").disabled = !state.range || !state.latest || !model.movePeriod(state.range, -1, state.latest);
      get("summary-next").disabled = !state.range || !state.latest || !model.movePeriod(state.range, 1, state.latest);
      get("summary-latest").disabled = !state.range || !state.latest || state.range.end === state.latest.end;
      for (const item of model.METRICS) {
        const { field } = item, unit = unitText(item), card = cards[field], metric = state.data?.current.metrics[field];
        const progress = model.goalProgress(field, metric, state.goals[field]);
        card.button.setAttribute("aria-pressed", String(field === state.field));
        card.number.textContent = !metric ? "表示できません" : metric.value === null ? "データなし" : displayNumber(field, metric.value);
        card.unit.textContent = metric && metric.value !== null ? unit : "";
        const days = field === "standing" ? metric?.count : metric?.performedDays, dayLabel = field === "standing" ? "平均対象日数" : "実施日数";
        card.count.textContent = metric ? `(${days}/28)` : "(—/28)";
        card.count.setAttribute("aria-label", metric ? `28日間のうち${dayLabel}${days}日` : `${dayLabel}を確認できません`);
        const difference = progress.difference;
        card.difference.textContent = progress.status === "ready" ? `目標${difference === "0" ? "±0" : difference.startsWith("-") ? "−" + displayNumber(field, difference.slice(1)) : "+" + displayNumber(field, difference)}` : "";
        card.change.dataset.achieved = String(progress.status === "ready" && progress.achieved);
        card.change.textContent = progress.status === "unset" ? "目標未設定" : progress.status === "no-data" ? "達成率 判定不可" : `達成率 ${progress.rate}%`;
      }
      renderPlot();
    }
    function refresh() {
      if (!state.open) return;
      const loaded = settings.read("exerciseGoals"); state.goals = loaded.values; state.goalError = loaded.error;
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
      const value = node("strong", "", "summary-card-value"), change = node("span", "", "summary-card-achievement"), count = node("span", "", "summary-card-count");
      const number = node("span", "", "summary-card-number"), unit = node("span", "", "summary-card-unit"); value.append(number, unit);
      const row = node("span", undefined, "summary-card-value-row"), difference = node("span", "", "summary-card-difference"); row.append(value, difference);
      const heading = node("span", undefined, "summary-card-heading"); heading.append(label, count);
      button.append(heading, row, change); get("summary-cards").append(button);
      cards[metric.field] = { button, number, unit, difference, change, count };
      button.addEventListener("click", () => {
        state.field = metric.field; render();
        get("summary-heading").scrollIntoView({ block: "start", behavior: "auto" });
      });
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
    navigation.connectPeriodSwipe({ element: get("summary-screen"), window, enabled: () => state.open && !state.error,
      move: (direction) => get(direction < 0 ? "summary-previous" : "summary-next").click() });
    navigation.register("summary", { heading: "summary-heading", onShow() { state.open = true; refresh(); }, onHide() { state.open = false; } });
    window.addEventListener("storage", (event) => { if (event.key === KEY || event.key === settingsModel.KEYS.exerciseGoals || event.key === null) refresh(); });
    for (const name of ["focus", "pageshow"]) window.addEventListener(name, refresh);
    window.addEventListener("resize", () => { if (state.open) renderPlot(); });
    return Object.freeze({ open: () => navigation.show("summary"), refresh,
      getState: () => ({ range: state.range && { ...state.range }, field: state.field, error: state.error }) });
  }
  return Object.freeze({ mount });
});
