(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./app-settings.js") : root.AppSettings);
  if (commonJS) module.exports = api;
  else { root.SettingsView = api; root.RecordSettingsView = api.mount({ document, window, navigation: root.RecordAppNavigation, store: root.RecordSettings }); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (model) {
  "use strict";
  function mount({ document, window, navigation, store }) {
    const get = (id) => document.querySelector(`#${id}`);
    const groups = ["goals", "attention"], state = {};
    let previous = "input", pending = null, bypass = false;
    const node = (tag, text, className) => {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    const unit = (name) => name === "compareDays" ? "日" : name.startsWith("weight") ? "kg" : name === "bodyFatChange" ? "ポイント" : "%";
    const id = (group, name) => `settings-${group}-${name}`;
    function currentDraft(group) { return Object.fromEntries(model.fields(group).map((name) => [name, get(id(group, name)).value])); }
    function dirty() { return groups.some((group) => state[group]?.editing && model.changed(group, currentDraft(group), state[group].saved)); }
    function setStatus(group, message, error = false) {
      get(`settings-${group}-status`).textContent = message;
      get(`settings-${group}-status`).dataset.error = String(error);
    }
    function errors(group, messages = {}) {
      for (const name of model.fields(group)) {
        get(id(group, name) + "-error").textContent = messages[name] || "";
        get(id(group, name)).setAttribute("aria-invalid", String(Boolean(messages[name])));
      }
    }
    function renderSummary(group) {
      const values = state[group].saved, target = get(`settings-${group}-summary`); target.replaceChildren();
      for (const [label, value] of [[group === "goals" ? "体重" : "体重の固定範囲", `${values.weightMin.toFixed(1)}〜${values.weightMax.toFixed(1)}kg`],
        [group === "goals" ? "体脂肪率" : "体脂肪率の固定範囲", `${values.bodyFatMin.toFixed(1)}〜${values.bodyFatMax.toFixed(1)}%`]]) {
        target.append(node("p", `${label}：${value}`));
      }
      if (group === "attention") {
        target.append(node("p", `急変比較期間：${values.compareDays}日以内`), node("p", `体重の急変幅：${values.weightChange.toFixed(1)}kg以上`),
          node("p", `体脂肪率の急変幅：${values.bodyFatChange.toFixed(1)}ポイント以上`));
      }
    }
    function display(group) {
      const editing = state[group].editing;
      get(`settings-${group}-form`).hidden = !editing;
      get(`settings-${group}-summary`).hidden = editing;
      get(`settings-${group}-edit`).hidden = editing;
      get(`settings-${group}-repair`).hidden = !editing || !state[group].needsRepair;
      renderSummary(group);
    }
    function reload(group) {
      const loaded = store.read(group);
      state[group] = { saved: loaded.values, editing: false, needsRepair: loaded.needsRepair };
      setStatus(group, loaded.error, Boolean(loaded.error)); display(group);
    }
    function fill(group, values) {
      for (const [name, value] of Object.entries(model.draft(group, values))) get(id(group, name)).value = value;
      errors(group);
    }
    function edit(group) {
      reload(group); state[group].editing = true; fill(group, state[group].saved);
      get(`settings-${group}-repair-confirm`).checked = false; display(group);
      get(id(group, model.fields(group)[0])).focus({ preventScroll: true });
    }
    function save(group) {
      const checked = model.validate(group, currentDraft(group)); errors(group, checked.errors);
      if (!checked.valid) { setStatus(group, "入力内容を確認してください。" + (checked.errors.form || ""), true); return; }
      const result = store.save(group, currentDraft(group), { repair: get(`settings-${group}-repair-confirm`).checked });
      if (!result.ok) { setStatus(group, result.error, true); return; }
      state[group].saved = result.values; state[group].editing = false; state[group].needsRepair = false;
      setStatus(group, "設定を保存しました"); display(group);
    }
    function hideLeave() { pending = null; get("settings-leave-confirm").hidden = true; }
    function canLeave({ destination } = {}) {
      if (bypass || !dirty()) return "";
      pending = destination || previous; get("settings-leave-confirm").hidden = false;
      get("settings-continue").focus({ preventScroll: true });
      get("settings-leave-confirm").scrollIntoView({ block: "nearest", behavior: "auto" });
      return "未保存の設定を確認してください";
    }
    for (const group of groups) {
      const form = get(`settings-${group}-fields`);
      for (const name of model.fields(group)) {
        const label = node("label", undefined, "settings-field");
        label.setAttribute("for", id(group, name)); label.append(node("span", model.LABELS[name]));
        const row = node("span", undefined, "settings-input-unit"), input = node("input");
        input.id = id(group, name); input.type = "text";
        input.setAttribute("inputmode", name === "compareDays" ? "numeric" : "decimal");
        input.setAttribute("autocomplete", "off"); input.setAttribute("enterkeyhint", "next");
        input.setAttribute("aria-describedby", id(group, name) + "-error");
        const error = node("span", "", "settings-field-error"); error.id = id(group, name) + "-error";
        row.append(input, node("span", unit(name))); label.append(row, error); form.append(label);
      }
      get(`settings-${group}-edit`).addEventListener("click", () => edit(group));
      get(`settings-${group}-save`).addEventListener("click", () => save(group));
      get(`settings-${group}-cancel`).addEventListener("click", () => { errors(group); reload(group); });
      get(`settings-${group}-reset`).addEventListener("click", () => { fill(group, model.DEFAULTS[group]); setStatus(group, "編集欄を初期値に戻しました。保存するまで確定しません"); });
    }
    navigation.register("settings", { tab: null, heading: "settings-heading", canLeave,
      onShow({ reenter, from }) { if (reenter) return; previous = from; for (const group of groups) reload(group); hideLeave(); },
      onHide() { for (const group of groups) state[group].editing = false; hideLeave(); }
    });
    get("settings-show").addEventListener("click", () => {
      if (navigation.current() === "settings") return;
      const from = navigation.current();
      if (navigation.show("settings")) previous = from;
    });
    get("settings-back").addEventListener("click", () => navigation.show(previous));
    get("settings-continue").addEventListener("click", hideLeave);
    get("settings-discard").addEventListener("click", () => {
      const destination = pending; if (!destination) return;
      bypass = true;
      try { navigation.show(destination); } finally { bypass = false; }
    });
    window.addEventListener("beforeunload", (event) => {
      if (navigation.current() === "settings" && dirty()) { event.preventDefault(); event.returnValue = ""; }
    });
    return Object.freeze({ hasUnsavedChanges: dirty });
  }
  return Object.freeze({ mount });
});
