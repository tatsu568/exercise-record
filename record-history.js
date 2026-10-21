(function (root, factory) {
  "use strict";
  const transfer = typeof module === "object" && module.exports ? require("./record-transfer.js") : root.RecordTransfer;
  const api = factory(transfer);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecordHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (transfer) {
  "use strict";
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const FIELDS = Object.freeze([
    ["work", "勤務区分", ""], ["kids", "子供と動く", ""], ["standing", "スタンディング", ""],
    ["squat", "スクワット", "回"], ["march", "足踏み", "回"], ["plank", "プランク", "秒"],
    ["walkMinutes", "散歩・時間", "分"], ["walkSeconds", "散歩・時間", "秒"], ["distance", "散歩・距離", "km"],
    ["walkSteps", "散歩・歩数", "歩"], ["weight", "体重", "kg"], ["bodyFat", "体脂肪率", "%"], ["basal", "基礎代謝", "kcal"]
  ].map((field) => Object.freeze(field)));
  const WEEKDAYS = Object.freeze(["月", "火", "水", "木", "金", "土", "日"]);

  function validDate(date) {
    try { transfer.validateRecordsMap({ [date]: {} }); return true; } catch { return false; }
  }

  function read(raw) {
    let records;
    try { records = raw === null ? {} : JSON.parse(raw); }
    catch { throw new Error("保存データのJSONを読み取れません。初期化せず、閲覧を停止しました。"); }
    if (!object(records)) throw new Error("保存データが日付別オブジェクトではありません。初期化しません。");
    for (const date of Object.keys(records)) {
      if (!validDate(date)) throw new Error("不正な日付キーがあります。保存内容を変更せず、閲覧を停止しました。");
    }
    return records;
  }

  function localToday(now = new Date()) {
    return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  // UTC is used only for calendar arithmetic; record keys never pass through UTC timestamps.
  function calendar(year, month) {
    if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("表示年月が範囲外です");
    const first = new Date(0); first.setUTCHours(12, 0, 0, 0); first.setUTCFullYear(year, month - 1, 1);
    const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0);
    const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;
    return { year, month, offset: (first.getUTCDay() + 6) % 7,
      dates: Array.from({ length: next.getUTCDate() }, (_v, index) => prefix + String(index + 1).padStart(2, "0")) };
  }

  function moveMonth(year, month, delta) {
    const index = (year - 1) * 12 + month - 1 + delta;
    if (index < 0 || index >= 9999 * 12) return null;
    return { year: Math.floor(index / 12) + 1, month: index % 12 + 1 };
  }

  function dateLabel(date) {
    if (!validDate(date)) throw new Error("実在する日付ではありません");
    const [year, month, day] = date.split("-").map(Number);
    const grid = calendar(year, month);
    return `${year}/${month}/${day}（${WEEKDAYS[(grid.offset + day - 1) % 7]}）`;
  }

  function describe(records, date) {
    if (!validDate(date)) throw new Error("実在する日付ではありません");
    if (!own(records, date)) return { date, saved: false, kind: "missing", fields: [], unknown: [], canEdit: false };
    const entry = records[date];
    const fields = FIELDS.map(([key, label, unit]) => {
      const missing = object(entry) && !own(entry, key);
      const value = object(entry) ? entry[key] : entry;
      let error = object(entry) ? "" : "レコードがオブジェクトではありません";
      if (!missing && !error) {
        try { transfer.validateRecordsMap({ [date]: { [key]: value } }, { strictValues: true }); }
        catch { error = "保存値の型・範囲が不正です"; }
      }
      const type = missing ? "項目なし" : value === null ? "null" : typeof value;
      const rawText = typeof value === "number" && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
      const text = missing ? "項目なし（補完していません）" : error ? `不正な値：${rawText}（${type}）`
        : value === "" ? "空欄" : key === "kids" ? (value ? "あり" : "なし") : `${value}${unit ? ` ${unit}` : ""}`;
      return { key, label, unit, value, missing, error, type, text };
    });
    const unknown = object(entry) ? Object.keys(entry).filter((key) => !own(transfer.DEFAULT_ENTRY, key)) : [];
    const review = fields.some((field) => field.missing || field.error);
    const defaultOnly = !review && unknown.length === 0 && fields.every((field) => field.value === transfer.DEFAULT_ENTRY[field.key]);
    return { date, saved: true, kind: review ? "review" : defaultOnly ? "default" : "record", fields, unknown, canEdit: !review };
  }

  function summaryGroups(detail) {
    const field = (key) => detail.fields.find((item) => item.key === key);
    const part = (key) => { const item = field(key); return item.missing || item.error ? "要確認" : item.value === "" ? "未選択" : item.value; };
    const exercise = (key) => {
      const item = field(key);
      return `${item.label}：${item.missing || item.error ? "要確認" : `${item.value}${item.unit}`}`;
    };
    const measurements = (label, keys, values) => {
      const items = keys.map(field);
      return `${label}：${items.some((item) => item.error || item.missing) ? "要確認" : values().filter((value) => value !== "").join(",") || "なし"}`;
    };
    const minutes = field("walkMinutes"), seconds = field("walkSeconds");
    const withUnit = (key) => { const item = field(key); return item.value === "" ? "" : `${item.value}${item.unit}`; };
    const walk = measurements("散歩", ["walkMinutes", "walkSeconds", "distance", "walkSteps"], () => [
      minutes.value !== "" && seconds.value !== "" ? `${minutes.value}:${String(Number(seconds.value)).padStart(2, "0")}`
        : minutes.value !== "" ? `${minutes.value}分` : seconds.value !== "" ? `${seconds.value}秒` : "",
      withUnit("distance"), withUnit("walkSteps")
    ]);
    const body = measurements("身体", ["weight", "bodyFat"], () => [withUnit("weight"), withUnit("bodyFat")]);
    return [
      [`勤務：${part("work")}`, `子供：${part("kids") === true ? "あり" : part("kids") === false ? "なし" : "要確認"}`, exercise("standing")],
      [exercise("squat"), exercise("march"), exercise("plank")],
      [walk, body]
    ];
  }

  function summary(detail) {
    return summaryGroups(detail).flat().join(" / ");
  }

  function monthRecords(records, year, month) {
    const prefix = calendar(year, month).dates[0].slice(0, 7) + "-";
    const rows = Object.keys(records).filter((date) => date.startsWith(prefix)).sort().reverse().map((date) => describe(records, date));
    const counts = { saved: rows.length, record: 0, default: 0, review: 0 };
    rows.forEach((row) => counts[row.kind]++);
    return { rows, counts };
  }

  return Object.freeze({ FIELDS, WEEKDAYS, read, localToday, validDate, calendar, moveMonth, dateLabel, describe, summary, summaryGroups, monthRecords });
});
