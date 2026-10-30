(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./weekly-ai.js") : root.WeeklyAI,
    commonJS ? require("./record-transfer.js") : root.RecordTransfer,
    commonJS ? require("./record-save.js") : root.RecordSave,
    commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./graph-view.js") : root.BodyGraphView);
  if (commonJS) module.exports = api;
  else {
    let locks; try { locks = root.navigator.locks; } catch { /* Saving stays disabled. */ }
    root.RecordWeeklyAIView = api.mount({ document, window, storage: localStorage, locks,
      clipboard: root.navigator.clipboard, navigation: root.RecordAppNavigation, input: window.RecordHistoryInput });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, transfer, save, calendar, graph) {
  "use strict";
  function mount({ document, window, storage, locks, clipboard, navigation, input }) {
    const get = id => document.querySelector(`#${id}`), store = save.createStore({ storage, transfer, locks, isSecureContext: window.isSecureContext });
    const state = { evaluations: {}, selected: null, showAverage: true, plan: null, choices: {}, busy: false, error: "" };
    const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
    const svgNode = (tag, attrs, text) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
    const dateText = date => { const p = calendar.parseDate(date); return `${p.year}/${p.month}/${p.day}`; };
    function status(text, error = false) { get("ai-import-status").textContent = text; get("ai-import-status").dataset.error = String(error); }
    function renderPlot() {
      const plot = get("ai-plot"); get("ai-average-legend").hidden = !state.showAverage;
      const data = model.chartData(state.evaluations);
      if (!data.points.length || state.error) { plot.replaceChildren(node("p", state.error || "評価はまだ登録されていません。")); return; }
      const width = Math.max(240, plot.getBoundingClientRect?.().width || (document.documentElement?.clientWidth || 375) - 58), left = 38, top = 18, height = 154;
      const range = { start: data.points[0].date, end: data.points.at(-1).date }, values = data.points.map(p => p.value);
      const low = Math.min(...values), high = Math.max(...values), margin = Math.max(10, high - low) * .1 + Math.max(0, 10 - (high - low)) / 2;
      const axis = { min: Math.max(0, low - margin), max: Math.min(100, high + margin) };
      const step = axis.max - axis.min > 50 ? 20 : axis.max - axis.min > 20 ? 10 : 5;
      const xy = p => ({ x: left + calendar.calculateX(p.date, range, width - left - 12), y: top + calendar.calculateY(p.value, axis, height) });
      const svg = svgNode("svg", { viewBox: `0 0 ${width} 224`, width, height: 224, role: "group", "aria-label": "週間AI評価。緑の点付き線は評価点数、紫の補助線は4週間移動平均。点を選ぶと総評を表示します。" });
      for (let tick = Math.ceil(axis.min / step) * step; tick <= axis.max; tick += step) {
        const y = top + calendar.calculateY(tick, axis, height);
        svg.append(svgNode("line", { x1: left, x2: width - 12, y1: y, y2: y, class: "graph-grid-line" }), svgNode("text", { x: left - 6, y: y + 4, "text-anchor": "end", class: "graph-axis-label" }, String(tick)));
      }
      for (const segment of data.segments) if (segment.length > 1) svg.append(svgNode("polyline", { points: segment.map(p => { const q = xy(p); return `${q.x},${q.y}`; }).join(" "), class: "ai-score-line" }));
      if (state.showAverage) for (const segment of data.averageSegments) if (segment.length > 1) svg.append(svgNode("path", { d: graph.averagePath(segment.map(xy)), class: "ai-average-line", "pointer-events": "none", "aria-hidden": "true" }));
      for (const p of data.points) {
        const q = xy(p), selected = state.selected === p.date;
        svg.append(svgNode("circle", { cx: q.x, cy: q.y, r: selected ? 5 : 3.5, class: selected ? "graph-selection ai-score-point ai-score-selected" : "graph-point ai-score-point", "pointer-events": "none" }));
        const hit = svgNode("circle", { cx: q.x, cy: q.y, r: 12, fill: "transparent", tabindex: 0, role: "button", "aria-label": `${dateText(p.date)}、${p.value}/100点`, "aria-pressed": selected });
        hit.dataset.aiDate = p.date; svg.append(hit);
      }
      for (const tick of calendar.makeXTicks(range, width - left - 12, { maxTicks: 4, minLabelSpacing: 75 })) {
        svg.append(svgNode("text", { x: left + tick.x, y: 195, "text-anchor": "middle", class: "graph-axis-label" }, tick.label));
      }
      plot.replaceChildren(svg);
    }
    function render() {
      const dates = Object.keys(state.evaluations).sort(), index = dates.indexOf(state.selected), item = state.evaluations[state.selected];
      get("ai-status").textContent = state.error;
      get("ai-selected-week").textContent = item ? `${dateText(state.selected)}(月)〜${dateText(calendar.addDays(state.selected, 6))}(日)` : "評価なし";
      get("ai-selected-score").textContent = item ? `${item.score}/100点` : "—";
      get("ai-selected-comment").textContent = item?.comment ? `総評：${item.comment}` : "総評：登録なし";
      get("ai-previous").disabled = state.busy || index <= 0; get("ai-next").disabled = state.busy || index < 0 || index === dates.length - 1;
      get("ai-preview-button").disabled = state.busy || !!state.error || !store.supported(); get("ai-paste").disabled = state.busy;
      get("ai-confirm").disabled = state.busy; get("ai-cancel").disabled = state.busy;
      if (!store.supported()) get("ai-status").textContent = "評価の保存にはHTTPSとWeb Locks対応ブラウザーが必要です。閲覧は可能です。";
      renderPlot();
    }
    function refresh() {
      if (state.busy) return;
      try {
        state.evaluations = transfer.readEvaluations(storage.getItem(model.KEY)); state.error = "";
        const dates = Object.keys(state.evaluations).sort(); if (!dates.includes(state.selected)) state.selected = dates.at(-1) || null;
      } catch (error) { state.evaluations = {}; state.selected = null; state.error = `AI評価を読み取れません：${error.message}。自動初期化しません。`; }
      render();
    }
    function invalidate() {
      state.plan = null; state.choices = {}; get("ai-preview").replaceChildren(); get("ai-totals").textContent = ""; get("ai-confirm").checked = false; get("ai-save").disabled = true;
    }
    function totals() {
      if (!state.plan) return;
      const { counts } = transfer.buildEvaluationCandidate(state.plan, state.choices);
      get("ai-totals").textContent = `保存予定：追加${counts.added}週・上書き${counts.replaced}週／既存維持・一致${counts.skipped}週`;
      get("ai-save").disabled = state.busy || !get("ai-confirm").checked || counts.added + counts.replaced === 0;
    }
    function preview() {
      if (state.busy || state.error) return;
      invalidate(); get("ai-errors").replaceChildren();
      const parsed = model.parseTSV(get("ai-paste").value);
      if (parsed.errors.length) { for (const e of parsed.errors) get("ai-errors").append(node("li", `${e.line}行目：${e.reason}`)); status("エラーがあるため全件の保存を停止しました。", true); return; }
      try {
        state.plan = transfer.createEvaluationPlan(storage.getItem(model.KEY), parsed.evaluations);
        for (const row of state.plan.rows) {
          const card = node("div", undefined, "restore-conflict"), value = state.plan.incoming[row.date];
          card.append(node("strong", `${row.date}：${row.kind === "new" ? "新規" : row.kind === "same" ? "一致" : "既存週と重複"}／${value.score}/100点`), node("p", value.comment || "総評：登録なし", "ai-comment"));
          if (row.kind === "conflict") {
            const old = state.plan.existing[row.date]; card.append(node("p", `既存：${old.score}/100点`), node("p", old.comment || "総評：登録なし", "ai-comment"));
            const label = node("label", `${row.date} の保存方法`), select = document.createElement("select");
            select.dataset.aiWeek = row.date;
            for (const [value, text] of [["keep", "既存を維持"], ["replace", "この週を上書き"]]) { const option = node("option", text); option.value = value; select.append(option); }
            select.value = "keep"; select.addEventListener("change", () => { if (state.busy || !state.plan) return; state.choices[row.date] = select.value; get("ai-confirm").checked = false; totals(); });
            label.append(select); card.append(label);
          }
          get("ai-preview").append(card);
        }
        status("プレビュー中です。まだ保存していません。対象週と点数・総評を確認してください。"); totals();
      } catch (error) { invalidate(); status(error.message, true); }
    }
    async function apply() {
      if (state.busy || !state.plan || !get("ai-confirm").checked || input.canBrowse()) return;
      const plan = state.plan, choices = { ...state.choices };
      state.busy = true; render(); get("ai-save").disabled = true;
      for (const select of get("ai-preview").querySelectorAll?.("select") || []) select.disabled = true;
      try {
        const result = await store.commitEvaluations(plan, choices, { finalConfirmed: true, overwriteConfirmed: true });
        invalidate(); get("ai-paste").value = ""; state.selected = null;
        status(`保存と読み戻し照合が完了しました。追加${result.counts.added}週・上書き${result.counts.replaced}週。`);
      } catch (error) { invalidate(); status(error.message, true); }
      finally { state.busy = false; refresh(); }
    }
    get("ai-prompt").textContent = model.PROMPT; get("ai-moving-average").checked = true;
    get("ai-moving-average").addEventListener("change", () => { state.showAverage = get("ai-moving-average").checked; renderPlot(); });
    get("ai-preview-button").addEventListener("click", preview); get("ai-save").addEventListener("click", apply);
    get("ai-confirm").addEventListener("change", totals); get("ai-paste").addEventListener("input", () => { if (!state.busy) { invalidate(); get("ai-errors").replaceChildren(); status(""); } });
    get("ai-cancel").addEventListener("click", () => { if (!state.busy) { invalidate(); get("ai-errors").replaceChildren(); get("ai-totals").textContent = ""; status("保存せずプレビューを取り消しました。"); } });
    for (const [id, direction] of [["ai-previous", -1], ["ai-next", 1]]) get(id).addEventListener("click", () => {
      const dates = Object.keys(state.evaluations).sort(), index = dates.indexOf(state.selected), next = dates[index + direction];
      if (!state.busy && next) {
        state.selected = next; render();
        get("ai-heading").scrollIntoView({ block: "start", behavior: "auto" });
      }
    });
    const selectPoint = event => { const date = event.target?.dataset?.aiDate; if (!state.busy && Object.hasOwn(state.evaluations, date)) { state.selected = date; render(); } };
    get("ai-plot").addEventListener("click", selectPoint);
    get("ai-plot").addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectPoint(event); } });
    get("ai-copy-prompt").addEventListener("click", async () => { try { await clipboard.writeText(model.PROMPT); get("ai-copy-status").textContent = "依頼文をコピーしました。"; } catch { get("ai-copy-status").textContent = "コピーできません。表示中の依頼文を選択してコピーしてください。"; } });
    navigation.register("summary", { canLeave: () => state.busy ? "AI評価を保存中です。結果を確認してから移動してください。" : "" });
    // This all-period section has no period gesture; leave native scrolling intact.
    get("weekly-ai").addEventListener("touchstart", event => event.stopPropagation(), { passive: true });
    get("summary-show").addEventListener("click", refresh);
    window.addEventListener("storage", event => { if (event.key === model.KEY || event.key === null) { invalidate(); refresh(); status("保存内容が変更されました。取り込みは再度プレビューしてください。"); } });
    for (const name of ["focus", "pageshow"]) window.addEventListener(name, () => { if (!get("summary-screen").hidden) refresh(); });
    window.addEventListener("resize", () => { if (!get("summary-screen").hidden) renderPlot(); });
    window.addEventListener("pagehide", () => store.cancelPending());
    refresh();
    return Object.freeze({ refresh });
  }
  return Object.freeze({ mount });
});
