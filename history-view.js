(function (root, factory) {
  "use strict";
  const model = typeof module === "object" && module.exports ? require("./record-history.js") : root.RecordHistory;
  const api = factory(model);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.RecordHistoryView = api;
    api.mount({ document, window, storage: localStorage, input: window.RecordHistoryInput, navigation: root.RecordAppNavigation });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model) {
  "use strict";
  const KEY = "exercise-record.entries.v1";
  const KIND = { record: "保存済み", default: "初期値のみの可能性", review: "保存値に要確認項目あり", missing: "保存記録なし" };
  const MARK = { record: "●", default: "△", review: "!", missing: "" };

  // Group only the displayed rows; retain the model's thirteen original fields.
  function detailRows(fields) {
    const minutes = fields.find((field) => field.key === "walkMinutes");
    const seconds = fields.find((field) => field.key === "walkSeconds");
    const missing = minutes.missing || seconds.missing;
    const error = minutes.error || seconds.error;
    const text = missing || error ? `分：${minutes.text} ／ 秒：${seconds.text}`
      : `${minutes.value !== "" ? `${minutes.value}分` : ""}${seconds.value !== "" ? `${seconds.value}秒` : ""}` || "空欄";
    return fields.flatMap((field) => field.key === "walkSeconds" ? [] : field.key === "walkMinutes"
      ? [{ key: "walkTime", label: "散歩・時間", text, type: "string", missing, error }] : [field]);
  }

  function mount({ document, window, storage, input, navigation, today = () => model.localToday() }) {
    const get = (id) => document.querySelector(`#${id}`);
    const node = (tag, text, className) => {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    };
    // Separators sit outside each item; clipping at the row edge hides them after wrapping.
    function joinedParts(parts, className, separator, renderPart = (part) => node("span", part, "history-summary-part")) {
      const group = node("span", undefined, className);
      const flow = node("span", undefined, "history-joined-flow");
      for (const [index, part] of parts.entries()) {
        const item = node("span", undefined, className === "history-summary-group" ? "history-joined-item history-summary-item" : "history-joined-item");
        if (index) {
          const divider = node("span", separator, "history-joined-separator");
          divider.setAttribute("aria-hidden", "true"); item.append(divider);
        }
        item.append(renderPart(part)); flow.append(item);
      }
      group.append(flow); return group;
    }
    const state = { open: false, records: {}, raw: null, year: 0, month: 0, selected: null, error: false };
    let inputScrollSequence = 0;
    function status(text, error = false) {
      get("history-status").textContent = text;
      get("history-status").dataset.error = String(error);
    }
    function close() {
      if (navigation) return navigation.show("input");
      ++inputScrollSequence;
      state.open = false; input.setBrowsing(false);
      get("history-screen").hidden = true; get("input-screen").hidden = false;
      get("history-show").setAttribute("aria-pressed", "false"); get("input-show").setAttribute("aria-pressed", "true");
      get("history-show").focus({ preventScroll: true });
    }
    function selectDate(date) {
      state.selected = date;
      render();
      get("history-detail-heading").focus({ preventScroll: true });
      get("history-detail").scrollIntoView({ block: "start", behavior: "auto" });
    }
    function renderDetail() {
      const detail = get("history-detail");
      detail.hidden = !state.selected || state.error;
      if (detail.hidden) return;
      const record = model.describe(state.records, state.selected);
      get("history-detail-heading").textContent = model.dateLabel(state.selected);
      get("history-detail-state").textContent = KIND[record.kind];
      const values = get("history-detail-values"); values.replaceChildren();
      if (!record.saved) values.append(node("p", "この日の保存記録はありません。初期値の記録は作成しません。"));
      else {
        for (const field of detailRows(record.fields)) {
          const row = node("dl", undefined, "history-value");
          const value = node("dd", field.text);
          row.append(node("dt", field.label), value);
          values.append(row);
        }
        if (record.unknown.length) values.append(node("p", `未知の保存項目があります（変更していません）：${record.unknown.join("、")}`, "history-help"));
        if (!record.canEdit) values.append(node("p", "項目の欠落・不正値があるため入力画面への移動を停止しています。保存値は補完・修復していません。", "history-help"));
      }
      get("history-edit").hidden = !record.saved || !record.canEdit;
    }
    function render() {
      get("history-month").textContent = `${state.year}年${state.month}月`;
      get("history-month-prev").disabled = !model.moveMonth(state.year, state.month, -1);
      get("history-month-next").disabled = !model.moveMonth(state.year, state.month, 1);
      const grid = get("history-calendar"); grid.replaceChildren();
      const list = get("history-list"); list.replaceChildren();
      get("history-count").replaceChildren();
      if (state.error) {
        get("history-count").textContent = "保存内容を読み取れないため、記録の有無を判定できません。";
        get("history-detail").hidden = true;
        return;
      }
      const month = model.monthRecords(state.records, state.year, state.month);
      const byDate = new Map(month.rows.map((row) => [row.date, row]));
      const calendar = model.calendar(state.year, state.month);
      for (let index = 0; index < calendar.offset; index++) {
        const space = node("span"); space.setAttribute("aria-hidden", "true"); grid.append(space);
      }
      for (const date of calendar.dates) {
        const kind = byDate.get(date)?.kind || "missing";
        const button = node("button", undefined, `history-day history-day-${kind}`); button.type = "button";
        button.dataset.date = date;
        button.append(node("span", String(Number(date.slice(-2)))), node("small", MARK[kind] || "\u00a0"));
        button.setAttribute("aria-label", `${model.dateLabel(date)}、${KIND[kind]}${date === today() ? "、今日" : ""}`);
        button.setAttribute("aria-pressed", String(date === state.selected));
        if (date === today()) button.setAttribute("aria-current", "date");
        button.addEventListener("click", () => selectDate(date)); grid.append(button);
      }
      const counts = month.counts;
      for (const parts of [
        [`保存${counts.saved}日`, `初期値と異なる保存値${counts.record}日`],
        [`初期値のみの可能性${counts.default}日`, `要確認${counts.review}日`]
      ]) {
        get("history-count").append(joinedParts(parts, "history-count-row", " / "));
      }
      if (!month.rows.length) list.append(node("li", "この月の保存記録はありません。"));
      for (const row of month.rows) {
        const item = node("li");
        const button = node("button", undefined, "history-list-button"); button.type = "button"; button.dataset.date = row.date;
        button.setAttribute("aria-pressed", String(row.date === state.selected));
        const header = node("span", undefined, "history-list-header");
        header.append(node("strong", model.dateLabel(row.date)), node("span", `${MARK[row.kind]} ${row.kind === "review" ? "要確認" : KIND[row.kind]}`, "history-kind"));
        button.append(header);
        for (const parts of model.summaryGroups(row)) {
          button.append(joinedParts(parts, "history-summary-group", " / ", (part) =>
            joinedParts(part.split(","), "history-summary-values", ",")));
        }
        button.addEventListener("click", () => selectDate(row.date)); item.append(button); list.append(item);
      }
      renderDetail();
    }
    function refresh() {
      if (!state.open) return;
      try {
        const raw = storage.getItem(KEY);
        const records = model.read(raw);
        state.records = records; state.raw = raw; state.error = false;
        status("閲覧専用です。記録内容は変更しません。");
      } catch (error) {
        state.records = {}; state.raw = null; state.error = true;
        status(`履歴を読み込めません：${error.message}。保存内容は変更していません。`, true);
      }
      render();
    }
    function activate() {
      ++inputScrollSequence;
      if (!state.year) {
        const date = today();
        [state.year, state.month] = date.split("-").map(Number); state.selected = date;
      }
      state.open = true; refresh();
    }
    function open() {
      if (navigation) return navigation.show("history");
      const error = input.canBrowse();
      if (error) { input.notify(error); return; }
      input.setBrowsing(true);
      get("input-toolbar").hidden = true;
      document.activeElement?.blur();
      get("input-screen").hidden = true; get("history-screen").hidden = false;
      get("history-show").setAttribute("aria-pressed", "true"); get("input-show").setAttribute("aria-pressed", "false");
      activate(); get("history-heading").focus({ preventScroll: true });
    }
    if (navigation) navigation.register("history", { heading: "history-heading", onShow: activate,
      onHide() { ++inputScrollSequence; state.open = false; } });
    else {
      get("history-show").addEventListener("click", open);
      get("input-show").addEventListener("click", () => { if (state.open) close(); });
    }
    get("history-detail-close").addEventListener("click", () => {
      state.selected = null; render(); get("history-month").focus({ preventScroll: true });
      get("history-month").scrollIntoView({ block: "start", behavior: "auto" });
    });
    for (const [id, delta] of [["history-month-prev", -1], ["history-month-next", 1]]) {
      get(id).addEventListener("click", () => {
        const next = model.moveMonth(state.year, state.month, delta);
        if (!next) return;
        Object.assign(state, next); state.selected = null; refresh();
      });
    }
    get("history-edit").addEventListener("click", () => {
      if (!state.selected || state.error) return;
      const record = model.describe(state.records, state.selected);
      if (!record.saved || !record.canEdit) return;
      const error = input.openSavedDate(state.selected, state.raw);
      if (error) { refresh(); status(error, true); return; }
      close();
      const sequence = inputScrollSequence;
      const scrollToInputTop = () => {
        if (state.open || sequence !== inputScrollSequence || get("input-screen").hidden) return;
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      };
      // Allow the newly visible input screen to render; do not focus a date/number input.
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.requestAnimationFrame(scrollToInputTop));
      } else setTimeout(scrollToInputTop, 0);
    });
    window.addEventListener("storage", (event) => { if (event.key === KEY || event.key === null) refresh(); });
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return Object.freeze({ open, close, refresh });
  }
  return Object.freeze({ mount });
});
