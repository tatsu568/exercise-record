(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-save.js") : root.RecordSave);
  if (commonJS) module.exports = api;
  else root.AttentionAcknowledgements = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (graph, recordSave) {
  "use strict";
  const KEY = "exercise-record.attention-acknowledgements.v1";
  const FIELDS = ["weight", "bodyFat"];
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function parse(raw) {
    if (raw === null) return {};
    const data = JSON.parse(raw);
    if (!object(data) || data.schemaVersion !== 1 || !object(data.confirmed)
      || Object.keys(data).some((key) => !["schemaVersion", "confirmed"].includes(key))) throw new Error("確認済み情報の形式・バージョンを確認できません");
    for (const [date, fields] of Object.entries(data.confirmed)) {
      graph.parseDate(date);
      if (!object(fields) || Object.entries(fields).some(([field, value]) => !FIELDS.includes(field) || value !== true)) throw new Error("確認済みの日付・項目・値が不正です");
    }
    return data.confirmed;
  }
  function createStore({ storage, locks, isSecureContext, timeoutMs = 5000 }) {
    let uncertain = false;
    const waiting = new Set();
    const supported = () => { try { return isSecureContext === true && typeof locks?.request === "function"; } catch { return false; } };
    function read() {
      try {
        if (uncertain) throw new Error("保存結果を確認できません。再読み込みして保存済みの確認状態を確認してください");
        return { confirmed: parse(storage.getItem(KEY)), error: "" };
      } catch (error) { return { confirmed: null, error: `確認状態不明：${error.message}。保存データは自動修復しません` }; }
    }
    async function setConfirmed(date, field, confirmed) {
      graph.parseDate(date);
      if (!FIELDS.includes(field) || typeof confirmed !== "boolean") throw new Error("確認対象の日付・項目が不正です");
      if (!supported()) throw new Error("確認状態の保存にはHTTPSとWeb Locks対応ブラウザーが必要です");
      if (uncertain) throw new Error("前の保存結果が不明です。再読み込みして確認してください");
      const controller = new AbortController(), deadline = Date.now() + timeoutMs;
      waiting.add(controller);
      const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await locks.request(recordSave.LOCK_NAME, { mode: "exclusive", signal: controller.signal }, () => {
          if (controller.signal.aborted || Date.now() >= deadline) throw new Error("確認状態の保存待ちを中止しました。再試行してください");
          globalThis.clearTimeout(timer); waiting.delete(controller);
          const before = storage.getItem(KEY), values = parse(before);
          if (Boolean(values[date]?.[field]) === confirmed) return { confirmed: values, error: "" };
          if (confirmed) { values[date] ||= {}; values[date][field] = true; }
          else { delete values[date][field]; if (!Object.keys(values[date]).length) delete values[date]; }
          const raw = JSON.stringify({ schemaVersion: 1, confirmed: values });
          if (storage.getItem(KEY) !== before) throw new Error("別の画面で確認状態が変更されました。もう一度確認してください");
          storage.setItem(KEY, raw);
          try {
            const actual = storage.getItem(KEY);
            if (actual !== raw) throw new Error("保存後の内容が一致しません");
            return { confirmed: parse(actual), error: "" };
          } catch {
            uncertain = true;
            throw new Error("保存後の照合に失敗しました。書き込み済みの可能性があります。自動再保存せず、再読み込みして確認してください");
          }
        });
      } catch (error) {
        throw new Error(error.name === "AbortError" ? "確認状態の保存待ちを中止しました。再試行してください" : `確認状態を保存できませんでした：${error.message}`);
      } finally { globalThis.clearTimeout(timer); waiting.delete(controller); }
    }
    return Object.freeze({ read, setConfirmed, supported, cancelPending() { for (const item of waiting) item.abort(); } });
  }
  return Object.freeze({ KEY, parse, createStore });
});
