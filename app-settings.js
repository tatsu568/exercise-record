(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.AppSettings = api; root.RecordSettings = api.createStore(localStorage); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Each key holds { schemaVersion: 1, values: { ...numeric fields below } }.
  // These settings are intentionally outside the records/backup schema.
  const KEYS = Object.freeze({ goals: "exercise-record.goals.v1", attention: "exercise-record.attention-settings.v1" });
  const DEFAULTS = Object.freeze({
    goals: Object.freeze({ weightMin: 56, weightMax: 56.9, bodyFatMin: 16, bodyFatMax: 16.9 }),
    attention: Object.freeze({ weightMin: 45, weightMax: 70, bodyFatMin: 10, bodyFatMax: 30, compareDays: 10, weightChange: 3, bodyFatChange: 3 })
  });
  const LABELS = Object.freeze({ weightMin: "体重の下限", weightMax: "体重の上限", bodyFatMin: "体脂肪率の下限", bodyFatMax: "体脂肪率の上限",
    compareDays: "急変比較期間", weightChange: "体重の急変幅", bodyFatChange: "体脂肪率の急変幅" });
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function fields(group) {
    if (!Object.hasOwn(DEFAULTS, group)) throw new Error("未対応の設定グループです");
    return Object.keys(DEFAULTS[group]);
  }
  function validate(group, source, stored = false) {
    const names = fields(group), values = {}, errors = {};
    if (!plain(source)) return { values, errors: { form: "設定値はオブジェクトで指定してください" }, valid: false };
    for (const name of Object.keys(source)) if (!names.includes(name)) errors.form = `未知の設定項目があります：${name}`;
    for (const name of names) {
      const raw = source[name], text = typeof raw === "string" ? raw.trim() : String(raw);
      if (stored && typeof raw !== "number") { errors[name] = `${LABELS[name]}の保存型が不正です`; continue; }
      if (!stored && typeof raw !== "string") { errors[name] = `${LABELS[name]}を入力してください`; continue; }
      if (!text) { errors[name] = `${LABELS[name]}は必須です`; continue; }
      // Validate the original text before Number(): never round or truncate.
      const syntax = name === "compareDays" ? /^\d+$/ : /^\d+(?:\.\d)?$/;
      if (!syntax.test(text)) {
        errors[name] = name === "compareDays" ? "比較期間は1〜365日の整数で入力してください"
          : /^\d+\.\d{2,}$/.test(text) ? "小数点以下は1桁までです" : `${LABELS[name]}は正の数値で入力してください`;
        continue;
      }
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / 10) errors[name] = `${LABELS[name]}が扱える数値の範囲外です`;
      else if (name === "compareDays" && (!Number.isInteger(value) || value > 365)) errors[name] = "比較期間は1〜365日の整数で入力してください";
      else values[name] = value;
    }
    for (const prefix of ["weight", "bodyFat"]) {
      if (values[prefix + "Min"] > values[prefix + "Max"]) errors[prefix + "Min"] = "下限は上限以下にしてください";
    }
    return { values, errors, valid: Object.keys(errors).length === 0 };
  }
  function parse(group, raw) {
    fields(group);
    if (raw === null) return { ...DEFAULTS[group] };
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error("設定JSONが破損しています"); }
    if (!plain(data)) throw new Error("設定全体の構造が不正です");
    if (data.schemaVersion !== 1) throw new Error("未対応の設定スキーマバージョンです");
    if (Object.keys(data).some((key) => !["schemaVersion", "values"].includes(key))) throw new Error("未知の設定情報があります。自動的に削除しません");
    const checked = validate(group, data.values, true);
    if (!checked.valid) throw new Error(Object.values(checked.errors).join("。"));
    return checked.values;
  }
  function draft(group, values = DEFAULTS[group]) {
    return Object.fromEntries(fields(group).map((name) => [name, name === "compareDays" ? String(values[name]) : values[name].toFixed(1)]));
  }
  function changed(group, input, saved) {
    const checked = validate(group, input);
    return !checked.valid || fields(group).some((name) => checked.values[name] !== saved[name]);
  }
  function createStore(storage) {
    const states = new Map();
    function state(group) {
      fields(group);
      if (!states.has(group)) states.set(group, { values: { ...DEFAULTS[group] }, raw: undefined, error: "", repair: false, uncertain: false, attempted: undefined });
      return states.get(group);
    }
    function result(item) { return { values: { ...item.values }, error: item.error, needsRepair: item.repair, uncertain: item.uncertain }; }
    function read(group) {
      const item = state(group);
      // Failed readback must not make a just-written, unconfirmed value active.
      // A reload can only validate what is actually stored; the UI explains this.
      if (item.uncertain) return result(item);
      let raw;
      try { raw = storage.getItem(KEYS[group]); }
      catch { item.error = "設定を読み込めません。最後に確認できた値（初回は標準値）を使用しています"; return result(item); }
      item.raw = raw;
      try { item.values = parse(group, raw); item.error = ""; item.repair = false; }
      catch (error) { item.error = error.message + "。最後に確認できた値（初回は標準値）を使用しています。保存データは変更していません"; item.repair = true; }
      return result(item);
    }
    function save(group, input, { repair = false } = {}) {
      const item = state(group), checked = validate(group, input);
      if (!checked.valid) return { ok: false, errors: checked.errors, ...result(item) };
      try {
        if (item.raw === undefined) read(group);
        if (item.raw === undefined) throw new Error("設定の読み取りができません。画面を開き直して確認してください");
        if (item.repair && !repair) throw new Error("破損・未対応の設定を置き換えるには修復の確認が必要です");
        const before = storage.getItem(KEYS[group]);
        if (before !== item.raw && !(item.uncertain && before === item.attempted)) throw new Error("別の画面で設定が変わりました。編集内容を控え、キャンセルして再編集してください");
        const raw = JSON.stringify({ schemaVersion: 1, values: checked.values });
        storage.setItem(KEYS[group], raw);
        item.uncertain = true; item.attempted = raw;
        const actual = storage.getItem(KEYS[group]);
        if (actual !== raw) throw new Error("保存後の内容が一致しません");
        const confirmed = parse(group, actual);
        item.values = confirmed; item.raw = raw; item.error = ""; item.repair = false; item.uncertain = false; item.attempted = undefined;
        return { ok: true, errors: {}, ...result(item) };
      } catch (error) {
        item.error = `設定を保存できませんでした：${error.message}。${item.uncertain ? "書き込み済みの可能性があります。この画面では確認前の値を適用せず、再試行できます。再読み込み後は実際の保存内容を確認してください" : "入力内容を保持しています"}`;
        return { ok: false, errors: {}, ...result(item) };
      }
    }
    function getTargets() {
      const { values } = read("goals");
      return { weight: { min: values.weightMin, max: values.weightMax }, bodyFat: { min: values.bodyFatMin, max: values.bodyFatMax } };
    }
    // STEP 5 should check error/uncertain as well as values before judging data.
    return Object.freeze({ read, save, getTargets, getAttention: () => read("attention") });
  }
  return Object.freeze({ KEYS, DEFAULTS, LABELS, fields, validate, parse, draft, changed, createStore });
});
