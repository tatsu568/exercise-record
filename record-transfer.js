(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecordTransfer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_ENTRY = Object.freeze({
    work: "", kids: false, standing: 10, squat: 0, march: 0, plank: 0,
    walkMinutes: "", walkSeconds: "", distance: "", walkSteps: "",
    weight: "", bodyFat: "", basal: ""
  });
  const AI_KEY = "exercise-record.weekly-ai-evaluations.v1";
  function validateEvaluations(values) {
    if (!isObject(values) || Object.keys(values).length > 10000) fail("AI評価は10000週以内の日付別データが必要です");
    for (const [date, entry] of Object.entries(values)) {
      if (!isRealDateKey(date) || new Date(date + "T12:00:00Z").getUTCDay() !== 1
        || new Date(Date.parse(date + "T12:00:00Z") + 6 * 86400000).getUTCFullYear() > 9999) fail("対象週は実在する月曜日（週末も9999年以内）で指定してください");
      if (!isObject(entry) || Object.keys(entry).some(key => !["score", "comment"].includes(key))
        || !Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) fail("評価点数は0〜100の整数で指定してください");
      if (typeof entry.comment !== "string" || entry.comment.length > 10000) fail("総評は10000文字以内の文字列で指定してください");
    }
    return values;
  }
  function readEvaluations(raw) { return validateEvaluations(raw === null ? {} : parseJson(raw)); }
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function fail(message, code = "INVALID") {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function isRealDateKey(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [year, month, day] = date.split("-").map(Number);
    if (year < 1 || month < 1 || month > 12) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function assertFiniteNumbers(value, path) {
    if (typeof value === "number" && !Number.isFinite(value)) fail(`${path} に有限でない数値があります`);
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) assertFiniteNumbers(item, `${path}.${key}`);
    }
  }

  function validateRecordsMap(records, { strictValues = false } = {}) {
    if (!isObject(records)) fail("全体が日付別レコードのオブジェクトではありません");
    assertFiniteNumbers(records, "保存データ");
    for (const [date, entry] of Object.entries(records)) {
      if (!isRealDateKey(date)) fail(`日付キー「${date}」が実在する YYYY-MM-DD 形式ではありません`);
      if (!isObject(entry)) fail(`${date} のレコードがオブジェクトではありません`);
      for (const [field, defaultValue] of Object.entries(DEFAULT_ENTRY)) {
        if (!own(entry, field)) continue;
        const value = entry[field];
        if (typeof value !== typeof defaultValue) fail(`${date} の ${field} の型が不正です`);
        if (typeof value === "number" && !Number.isFinite(value)) fail(`${date} の ${field} が有限数ではありません`);
        if (strictValues && typeof value === "string" && field !== "work" && value !== "") {
          const number = Number(value);
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(number) || number < 0) {
            fail(`${date} の ${field} が空欄または非負の数値文字列ではありません`);
          }
          if (["walkMinutes", "walkSeconds", "walkSteps"].includes(field) && !Number.isInteger(number)) fail(`${date} の ${field} は整数で入力してください`);
          if (field === "walkSeconds" && number > 59) fail(`${date} の walkSeconds は0〜59です`);
        }
      }
      if (own(entry, "work") && !["", "出社", "在宅", "休日"].includes(entry.work)) fail(`${date} の work に想定外の値があります`);
      for (const [field, step, min, max] of [["standing", 1, 5, 20], ["squat", 5, 0, Infinity], ["march", 1, 0, 2], ["plank", 30, 0, Infinity]]) {
        if (own(entry, field) && (!Number.isInteger(entry[field]) || entry[field] < min || entry[field] > max || entry[field] % step !== 0)) {
          fail(`${date} の ${field} が入力範囲・単位に合いません`);
        }
      }
    }
    return records;
  }

  // JSON.parse alone silently accepts duplicate keys. Reject ambiguous input before using its result.
  function parseJson(text) {
    const source = text.replace(/^\uFEFF/, "");
    let value;
    try { value = JSON.parse(source); } catch { fail("JSONの構文を読み取れません"); }
    let index = 0;
    const whitespace = () => { while (/\s/.test(source[index] || "") && index < source.length) index++; };
    const string = () => {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index++] === '"') break;
      }
      return JSON.parse(source.slice(start, index));
    };
    function scan() {
      whitespace();
      if (source[index] === "{") {
        index++; whitespace();
        const keys = new Set();
        while (source[index] !== "}") {
          const key = string();
          if (keys.has(key)) fail("JSONに重複した項目名があります");
          keys.add(key); whitespace(); index++; scan(); whitespace();
          if (source[index] !== ",") break;
          index++; whitespace();
        }
        index++;
      } else if (source[index] === "[") {
        index++; whitespace();
        while (source[index] !== "]") {
          scan(); whitespace();
          if (source[index] !== ",") break;
          index++;
        }
        index++;
      } else if (source[index] === '"') string();
      else while (index < source.length && !/[\s,\]}]/.test(source[index])) index++;
    }
    scan();
    return value;
  }

  function recordWarnings(records) {
    let incomplete = 0;
    const unknown = new Set();
    for (const entry of Object.values(records)) {
      if (Object.keys(DEFAULT_ENTRY).some((key) => !own(entry, key))) incomplete++;
      Object.keys(entry).filter((key) => !own(DEFAULT_ENTRY, key)).forEach((key) => unknown.add(key));
    }
    return [
      ...(incomplete ? [`不足項目のある旧記録：${incomplete}日。比較時だけ既定値を使い、保存時に補完しません。`] : []),
      ...(unknown.size ? [`未知の日別項目は削除せず保持します：${[...unknown].sort().join("、")}`] : [])
    ];
  }

  function parseBackup(text) {
    const backup = parseJson(text);
    if (!isObject(backup) || backup.format !== "exercise-record-backup") fail("対応するJSONバックアップではありません");
    if (![1, 2].includes(backup.formatVersion)) fail("対応していないバックアップ形式バージョンです");
    const keys = ["format", "formatVersion", "exportedAt", "records", ...(backup.formatVersion === 2 ? ["weeklyAI"] : [])];
    if (Object.keys(backup).some((key) => !keys.includes(key))) fail("未知のバックアップ最上位項目があります。対応版で確認してください");
    if (typeof backup.exportedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(backup.exportedAt)
      || !Number.isFinite(Date.parse(backup.exportedAt)) || new Date(backup.exportedAt).toISOString() !== backup.exportedAt) fail("バックアップ作成日時が不正です");
    validateRecordsMap(backup.records, { strictValues: true });
    if (backup.formatVersion === 2) validateEvaluations(backup.weeklyAI);
    return { ...backup, warnings: recordWarnings(backup.records) };
  }

  function readSnapshot(raw, { strictValues = true } = {}) {
    const records = raw === null ? {} : parseJson(raw);
    validateRecordsMap(records, { strictValues });
    return { raw, records };
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }

  function differences(existing, incoming) {
    const left = Object.assign(Object.create(null), DEFAULT_ENTRY, existing);
    const right = Object.assign(Object.create(null), DEFAULT_ENTRY, incoming);
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => stable(left[key]) !== stable(right[key]))
      .map((field) => ({ field, existing: left[field], incoming: right[field] }));
  }

  function createPlan(baselineRaw, incoming) {
    const existing = readSnapshot(baselineRaw).records;
    validateRecordsMap(incoming, { strictValues: true });
    const rows = Object.keys(incoming).sort().map((date) => {
      if (!own(existing, date)) return { date, kind: "new", differences: [] };
      const diff = differences(existing[date], incoming[date]);
      return { date, kind: diff.length ? "conflict" : "same", differences: diff,
        defaultOnly: stable({ ...DEFAULT_ENTRY, ...existing[date] }) === stable(DEFAULT_ENTRY) };
    });
    return { baselineRaw, existing: clone(existing), incoming: clone(incoming), rows,
      warnings: [...recordWarnings(existing).map((text) => `現在の記録：${text}`), ...recordWarnings(incoming).map((text) => `バックアップ：${text}`)] };
  }

  function buildCandidate(plan, choices = {}) {
    const records = clone(plan.existing);
    const counts = { added: 0, replaced: 0, skipped: 0, same: 0, before: Object.keys(records).length };
    for (const row of plan.rows) {
      const choice = own(choices, row.date) ? choices[row.date] : "keep";
      if (!["keep", "replace"].includes(choice)) fail("競合時の選択が不正です");
      if (row.kind === "new" || (row.kind === "conflict" && choice === "replace")) {
        records[row.date] = clone(plan.incoming[row.date]);
        if (row.kind === "new") counts.added++;
        else counts.replaced++;
      } else {
        counts.skipped++;
        if (row.kind === "same") counts.same++;
      }
    }
    counts.after = Object.keys(records).length;
    validateRecordsMap(records, { strictValues: true });
    return { records, counts };
  }
  function createEvaluationPlan(raw, incoming) {
    readEvaluations(raw); validateEvaluations(incoming);
    return createPlan(raw, incoming);
  }
  function buildEvaluationCandidate(plan, choices = {}) {
    validateEvaluations(plan.existing); validateEvaluations(plan.incoming);
    const result = buildCandidate(plan, choices); validateEvaluations(result.records); return result;
  }

  async function commitRecords(storage, key, plan, choices, confirmation, { store } = {}) {
    if (confirmation?.backupConfirmed !== true || confirmation?.finalConfirmed !== true) fail("復元前バックアップと最終確認が必要です", "CONFIRMATION");
    if (!store || store.storage !== storage || store.key !== key) fail("共通の排他保存処理が必要です", "LOCK_REQUIRED");
    return store.commitImport(plan, choices, confirmation);
  }

  return Object.freeze({ DEFAULT_ENTRY, AI_KEY, validateEvaluations, readEvaluations, parseJson, validateRecordsMap, parseBackup, readSnapshot,
    createPlan, buildCandidate, createEvaluationPlan, buildEvaluationCandidate, commitRecords, differences });
});
