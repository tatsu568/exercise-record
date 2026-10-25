(function (root, factory) {
  "use strict";
  const api = factory(typeof module === "object" && module.exports ? require("./body-graph.js") : root.BodyGraph);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MeasurementAttention = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (graph) {
  "use strict";

  // Pure calculations only. Supply saved settings.values, not a settings store.
  // All history is evaluated before the display range is applied to counts.
  const FIELDS = Object.freeze(["weight", "bodyFat"]);
  const SETTINGS = Object.freeze(["weightMin", "weightMax", "bodyFatMin", "bodyFatMax", "compareDays", "weightChange", "bodyFatChange"]);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const identityKey = (date, field, value) => JSON.stringify([date, field, value]);

  function validateSettings(settings) {
    if (!object(settings) || Object.keys(settings).some((key) => !SETTINGS.includes(key))) throw new TypeError("注意判定の7設定値が必要です");
    const values = {};
    for (const key of SETTINGS) {
      const value = settings[key];
      if (!own(settings, key) || typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / 10) {
        throw new RangeError(`${key}は正の有限な設定数値で指定してください`);
      }
      if (key === "compareDays") {
        if (!Number.isInteger(value) || value > 365) throw new RangeError("比較期間は1〜365日の整数です");
      } else if (!/^\d+(?:\.\d)?$/.test(String(value))) throw new RangeError(`${key}は小数点以下1桁までです`);
      values[key] = value;
    }
    for (const field of FIELDS) {
      if (graph.compareDecimals(String(values[field + "Min"]), String(values[field + "Max"])) > 0) throw new RangeError("下限は上限以下にしてください");
    }
    return values;
  }

  // Undefined: count all history. Null: no visible period (BodyGraph convention).
  function displayRange(range) {
    if (range === undefined || range === null) return range;
    if (!object(range)) throw new TypeError("表示期間には開始日と終了日が必要です");
    return graph.customPeriod(range.start, range.end);
  }

  function evaluateAttention(records, settings, range) {
    const values = validateSettings(settings), visible = displayRange(range);
    const measurements = graph.extractMeasurements(records);
    const result = { range: visible, weight: [], bodyFat: [], excluded: measurements.excluded };
    for (const field of FIELDS) {
      const min = String(values[field + "Min"]), max = String(values[field + "Max"]);
      const threshold = String(values[field + "Change"]), unit = field === "weight" ? "kg" : "pt";
      let previous = null;
      for (const point of measurements[field]) {
        const below = graph.compareDecimals(point.raw, min) < 0, above = graph.compareDecimals(point.raw, max) > 0;
        const fixedRange = below ? "below" : above ? "above" : null;
        const reasons = [];
        if (fixedRange) reasons.push({ code: below ? "fixed-below" : "fixed-above", bound: below ? min : max, unit: field === "weight" ? "kg" : "%" });
        let comparison = null, rapidChange = false;
        if (previous) {
          const days = graph.daysBetween(previous.date, point.date);
          const delta = graph.measurementDifference(previous.raw, point.raw);
          const absoluteDifference = delta.startsWith("-") ? delta.slice(1) : delta;
          const withinPeriod = days >= 1 && days <= values.compareDays;
          comparison = { date: previous.date, raw: previous.raw, decimal: previous.decimal,
            days, difference: delta, absoluteDifference, withinPeriod };
          rapidChange = withinPeriod && graph.compareDecimals(absoluteDifference, threshold) >= 0;
          if (rapidChange) reasons.push({ code: "rapid-change", previousDate: previous.date, previousRaw: previous.raw,
            previousValue: previous.decimal, days, difference: delta, absoluteDifference,
            threshold, compareDays: values.compareDays, unit });
        }
        result[field].push({ ...point, identity: { date: point.date, field, value: point.decimal },
          fixedRange, rapidChange, comparison, reasons, isAttention: reasons.length > 0,
          inRange: visible === undefined || (visible !== null && point.date >= visible.start && point.date <= visible.end) });
        previous = point;
      }
    }
    result.counts = summarizeAttention(result);
    return result;
  }

  // This is a resolved, in-memory contract, NOT a persisted acknowledgement schema.
  // Each item is { date, field, value: canonicalDecimal, status } where status is
  // confirmed / unconfirmed / unknown. A future adapter must first validate the
  // CURRENT revision and pending state; value equality alone cannot prevent ABA.
  // Undefined = not supplied; null = unavailable; missing items = unknown.
  function summarizeAttention(result, acknowledgementStates) {
    if (!object(result) || FIELDS.some((field) => !Array.isArray(result[field]))) throw new TypeError("注意判定結果が必要です");
    const states = new Map();
    if (acknowledgementStates !== undefined && acknowledgementStates !== null) {
      if (!Array.isArray(acknowledgementStates)) throw new TypeError("解決済み確認状態は配列で指定してください");
      for (const item of acknowledgementStates) {
        if (!object(item) || !FIELDS.includes(item.field) || !["confirmed", "unconfirmed", "unknown"].includes(item.status)) throw new TypeError("解決済み確認状態の形式が不正です");
        graph.parseDate(item.date);
        const parsed = graph.parseMeasurement(item.value);
        if (!parsed || parsed.decimal !== item.value) throw new TypeError("確認対象は正規化された有効測定値が必要です");
        const key = identityKey(item.date, item.field, item.value);
        if (states.has(key)) throw new TypeError("確認状態の識別情報が重複しています");
        states.set(key, item.status);
      }
    }
    return Object.fromEntries(FIELDS.map((field) => {
      const points = result[field].filter((point) => point.inRange && point.isAttention);
      if (acknowledgementStates === undefined || acknowledgementStates === null) {
        return [field, { totalAttention: points.length, unconfirmedAttention: null,
          acknowledgementStatus: acknowledgementStates === undefined ? "not-provided" : "unknown" }];
      }
      const status = points.map((point) => states.get(identityKey(point.date, field, point.decimal)) || "unknown");
      const unknown = status.includes("unknown");
      return [field, { totalAttention: points.length,
        unconfirmedAttention: unknown ? null : status.filter((value) => value === "unconfirmed").length,
        acknowledgementStatus: unknown ? "unknown" : "known" }];
    }));
  }

  return Object.freeze({ evaluateAttention, summarizeAttention });
});
