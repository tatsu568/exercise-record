(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BodyGraph = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Pure calculation API: callers supply records, today, dimensions and goals.
  // No storage, clock, DOM, network, default measurements or warning decisions.
  // Modes: 1m / 3m / 6m / 1y / all / custom. Empty all-period returns null.
  // Points retain raw strings; decimal is a separate, exact numeric identity.
  const MONTHS = Object.freeze({ "1m": 1, "3m": 3, "6m": 6, "1y": 12 });
  const FIELDS = Object.freeze(["weight", "bodyFat"]);
  // Same numeric-string grammar as record-transfer.js strictValues validation.
  const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLength = (year, month) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const yearDays = (year) => 365 * (year - 1) + Math.floor((year - 1) / 4) - Math.floor((year - 1) / 100) + Math.floor((year - 1) / 400);
  const key = (year, month, day) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  function parseDate(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("実在する YYYY-MM-DD の日付が必要です");
    const [year, month, day] = date.split("-").map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) throw new RangeError(`不正な日付：${date}`);
    let ordinal = yearDays(year) + day - 1;
    for (let index = 1; index < month; index++) ordinal += monthLength(year, index);
    return { year, month, day, ordinal };
  }

  function dateFromDay(ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= yearDays(10000)) throw new RangeError("日付の計算範囲は0001〜9999年です");
    let low = 1, high = 9999;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (yearDays(middle) <= ordinal) low = middle;
      else high = middle - 1;
    }
    let remaining = ordinal - yearDays(low), month = 1;
    while (remaining >= monthLength(low, month)) remaining -= monthLength(low, month++);
    return key(low, month, remaining + 1);
  }

  function addDays(date, amount) {
    if (!Number.isSafeInteger(amount)) throw new RangeError("日数は整数で指定してください");
    return dateFromDay(parseDate(date).ordinal + amount);
  }

  function daysBetween(start, end) { return parseDate(end).ordinal - parseDate(start).ordinal; }

  function shiftMonths(date, amount) {
    if (!Number.isSafeInteger(amount)) throw new RangeError("移動月数は整数で指定してください");
    const { year, month, day } = parseDate(date), index = (year - 1) * 12 + month - 1 + amount;
    if (index < 0 || index >= 9999 * 12) throw new RangeError("移動先の日付が範囲外です");
    const targetYear = Math.floor(index / 12) + 1, targetMonth = index % 12 + 1;
    return key(targetYear, targetMonth, Math.min(day, monthLength(targetYear, targetMonth)));
  }

  // The caller supplies its Date (or a calendar-component test double).
  function localDateString(date) {
    const result = key(date.getFullYear(), date.getMonth() + 1, date.getDate());
    parseDate(result);
    return result;
  }

  function decimalParts(raw) {
    const [mantissa, exponent = "0"] = raw.toLowerCase().replace(/^\+/, "").split("e");
    const fraction = mantissa.split(".")[1] || "";
    let digits = mantissa.replace(".", "").replace(/^0+/, ""), power = Number(exponent) - fraction.length;
    while (digits.endsWith("0")) { digits = digits.slice(0, -1); power++; }
    return { coefficient: BigInt(digits || "0"), power };
  }

  function decimalText(coefficient, power) {
    if (coefficient === 0n) return "0";
    const negative = coefficient < 0n;
    let digits = (negative ? -coefficient : coefficient).toString();
    while (digits.endsWith("0")) { digits = digits.slice(0, -1); power++; }
    const position = digits.length + power;
    const text = position <= 0 ? `0.${"0".repeat(-position)}${digits}`
      : position >= digits.length ? digits + "0".repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
    return (negative ? "-" : "") + text;
  }

  function parseMeasurement(raw) {
    if (typeof raw !== "string" || !NUMBER_TEXT.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    const decimal = decimalParts(raw);
    return { raw, value, decimal: decimalText(decimal.coefficient, decimal.power) };
  }

  function sameMeasurement(left, right) {
    const a = parseMeasurement(left), b = parseMeasurement(right);
    return a !== null && b !== null && a.decimal === b.decimal;
  }

  function difference(first, last) {
    const a = decimalParts(first), b = decimalParts(last), power = Math.min(a.power, b.power);
    return decimalText(b.coefficient * 10n ** BigInt(b.power - power) - a.coefficient * 10n ** BigInt(a.power - power), power);
  }

  function extractMeasurements(records) {
    if (!object(records)) throw new TypeError("日付別レコードのオブジェクトが必要です");
    const result = { weight: [], bodyFat: [], excluded: [] };
    for (const date of Object.keys(records).sort()) {
      const day = parseDate(date).ordinal, entry = records[date];
      for (const field of FIELDS) {
        const present = object(entry) && own(entry, field), raw = present ? entry[field] : undefined;
        const parsed = parseMeasurement(raw);
        if (parsed) result[field].push({ date, day, field, ...parsed });
        else result.excluded.push({ date, field, reason: !present ? "missing" : raw === "" ? "empty"
          : typeof raw === "string" && NUMBER_TEXT.test(raw) && Number(raw) === 0 ? "zero" : "invalid" });
      }
    }
    return result;
  }

  // Public point-array helpers accept the extraction result and return copies.
  function orderedPoints(points) {
    if (!Array.isArray(points)) throw new TypeError("測定点の配列が必要です");
    const result = points.map((point) => {
      if (!object(point)) throw new TypeError("測定点の形式が不正です");
      const day = parseDate(point.date).ordinal, parsed = parseMeasurement(point.raw);
      if (!parsed || !FIELDS.includes(point.field) || point.value !== parsed.value) throw new TypeError("測定点の値・型が不正です");
      return { date: point.date, day, field: point.field, ...parsed };
    }).sort((a, b) => a.day - b.day);
    for (let index = 1; index < result.length; index++) {
      if (result[index].date === result[index - 1].date) throw new RangeError("測定日の重複があります");
    }
    return result;
  }

  function customPeriod(start, end) {
    if (daysBetween(start, end) < 0) throw new RangeError("開始日は終了日以前にしてください");
    return { start, end };
  }

  function rollingPeriod(anchor, months, offset = 0) {
    if (![1, 3, 6, 12].includes(months)) throw new RangeError("期間は1・3・6・12か月です");
    if (!Number.isSafeInteger(offset) || offset > 0) throw new RangeError("最新より未来の期間へ移動できません");
    const end = shiftMonths(anchor, offset);
    return customPeriod(addDays(shiftMonths(end, -months), 1), end);
  }

  function allPeriod(measurements) {
    if (!object(measurements)) throw new TypeError("項目別の測定点が必要です");
    const dates = FIELDS.flatMap((field) => orderedPoints(measurements[field]).map((point) => point.date)).sort();
    return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
  }

  // Pass the unchanged anchor + cumulative offset on each navigation call.
  // On a later day, reusing an older anchor preserves the historical range.
  function calculatePeriod(mode, { today, anchor = today, offset = 0, start, end, measurements } = {}) {
    if (mode === "custom") return customPeriod(start, end);
    if (mode === "all") return allPeriod(measurements);
    if (!own(MONTHS, mode)) throw new RangeError("未対応の表示期間です");
    parseDate(today);
    if (daysBetween(anchor, today) < 0) throw new RangeError("基準日は今日以前にしてください");
    return rollingPeriod(anchor, MONTHS[mode], offset);
  }

  function filterMeasurements(points, range) {
    const sorted = orderedPoints(points);
    if (range === null) return [];
    customPeriod(range.start, range.end);
    return sorted.filter((point) => point.date >= range.start && point.date <= range.end);
  }

  function summarizeMeasurements(points, field) {
    if (!FIELDS.includes(field)) throw new RangeError("体重または体脂肪率を指定してください");
    const sorted = orderedPoints(points);
    if (sorted.some((point) => point.field !== field)) throw new TypeError("異なる項目の測定点が混在しています");
    const first = sorted[0] || null, last = sorted[sorted.length - 1] || null;
    return { count: sorted.length, first, last, change: sorted.length < 2 ? null : difference(first.raw, last.raw),
      unit: field === "weight" ? "kg" : "%", changeUnit: field === "weight" ? "kg" : "パーセントポイント" };
  }

  function dimension(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new RangeError("表示寸法は正の有限数です");
    return value;
  }

  function calculateX(date, range, width) {
    dimension(width);
    customPeriod(range.start, range.end);
    const span = daysBetween(range.start, range.end), offset = daysBetween(range.start, date);
    if (offset < 0 || offset > span) throw new RangeError("測定日が表示期間外です");
    return span === 0 ? width / 2 : offset / span * width;
  }

  function makeXTicks(range, width, { minLabelSpacing = 80 } = {}) {
    dimension(width); dimension(minLabelSpacing);
    customPeriod(range.start, range.end);
    const span = daysBetween(range.start, range.end), capacity = Math.max(1, Math.floor(width / minLabelSpacing) + 1);
    const crossYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
    const makeTick = (date) => {
      const { year, month, day } = parseDate(date);
      return { date, x: calculateX(date, range, width), label: crossYear ? `${year}/${month}/${day}` : `${month}/${day}` };
    };
    if (span === 0 || capacity === 1) return [makeTick(range.end)];
    const desired = Math.max(span <= 35 ? 7 : span <= 100 ? 14 : span <= 200 ? 28 : span <= 400 ? 56 : 1, span / (capacity - 1));
    let dates = [];
    if (desired <= 14) {
      const step = desired <= 7 ? 7 : 14;
      for (let day = 0; day <= span; day += step) dates.push(addDays(range.start, day));
    } else {
      const months = [1, 2, 3, 6, 12, 24, 60, 120, 600, 1200, 12000].find((count) => count * 28 >= desired);
      const { year, month } = parseDate(range.start), firstIndex = (year - 1) * 12 + month - 1;
      for (let index = Math.ceil(firstIndex / months) * months; index < 9999 * 12; index += months) {
        const date = key(Math.floor(index / 12) + 1, index % 12 + 1, 1);
        if (date > range.end) break;
        if (date >= range.start) dates.push(date);
      }
    }
    if (!dates.length) dates = [range.end];
    const ticks = [];
    for (const date of dates) {
      const tick = makeTick(date);
      if (!ticks.length || tick.x - ticks[ticks.length - 1].x >= minLabelSpacing - 1e-9) ticks.push(tick);
    }
    return ticks;
  }

  function validateTarget(target) {
    if (!object(target)) throw new TypeError("目標上下限が必要です");
    dimension(target.min); dimension(target.max);
    if (target.min > target.max) throw new RangeError("目標下限は上限以下にしてください");
  }

  function calculateYAxis(points, target, { padding = 0.1, minSpan = 1, tickCount = 5 } = {}) {
    validateTarget(target); dimension(minSpan);
    if (!Number.isFinite(padding) || padding < 0 || padding > 1 || !Number.isInteger(tickCount) || tickCount < 2 || tickCount > 20) throw new RangeError("縦軸オプションが不正です");
    let low = target.min, high = target.max;
    for (const point of orderedPoints(points)) { low = Math.min(low, point.value); high = Math.max(high, point.value); }
    const span = Math.max(high - low, minSpan), extra = (span - (high - low)) / 2;
    const margin = Math.max(span * padding, Number.MIN_VALUE);
    const min = Math.max(0, low - extra - margin);
    const grow = extra + margin, max = grow > Number.MAX_VALUE - high ? Number.MAX_VALUE : high + grow;
    if (!(max > min)) throw new RangeError("有限な縦軸範囲を作成できません");
    const desired = (max - min) / (tickCount - 1), power = 10 ** Math.floor(Math.log10(desired));
    const ratio = desired / power;
    let step = [1, 2, 2.5, 5, 10].find((value) => value >= ratio) * power;
    if (!Number.isFinite(step) || step <= 0) step = desired || max - min;
    const first = Math.ceil(min / step), ticks = [];
    // Integer tick indices avoid accumulated addition error and unbounded loops.
    for (let index = first; ticks.length < 32; index++) {
      const raw = index * step;
      if (!Number.isFinite(raw) || raw > max) break;
      const rounded = Number(raw.toPrecision(15)), value = rounded >= min && rounded <= max ? rounded : raw;
      if (value >= min && (!ticks.length || value > ticks[ticks.length - 1].value)) ticks.push({ value, label: String(value) });
      if (index + 1 === index || index - first >= 32) break;
    }
    if (!ticks.length) ticks.push({ value: min, label: String(min) });
    return { min, max, step, ticks };
  }

  function calculateY(value, axis, height) {
    dimension(height);
    if (!object(axis) || !Number.isFinite(axis.min) || !Number.isFinite(axis.max) || axis.min < 0 || axis.max <= axis.min
      || !Number.isFinite(value) || value < axis.min || value > axis.max) throw new RangeError("値または縦軸範囲が不正です");
    return (1 - (value - axis.min) / (axis.max - axis.min)) * height;
  }

  function calculateTargetBand(target, axis, height) {
    validateTarget(target);
    const top = calculateY(target.max, axis, height), bottom = calculateY(target.min, axis, height);
    return { top, bottom, height: bottom - top, collapsed: target.min === target.max };
  }

  function selectionInfo(points, date = null) {
    const sorted = orderedPoints(points), selected = sorted.findIndex((point) => point.date === date);
    const index = selected < 0 ? sorted.length - 1 : selected;
    return { index: index < 0 ? null : index, point: sorted[index] || null,
      previous: index > 0 ? sorted[index - 1] : null, next: index >= 0 && index + 1 < sorted.length ? sorted[index + 1] : null };
  }

  function adjacentMeasurement(points, index, direction) {
    const sorted = orderedPoints(points);
    if (!Number.isInteger(index) || index < 0 || index >= sorted.length || ![-1, 1].includes(direction)) return null;
    return sorted[index + direction] || null;
  }

  // Coordinates are plot-local pixels, without axes/margins. UI supplies sizes.
  // change is an exact decimal string or null (UI renders null as an em dash).
  function buildChartData(points, range, target, { field, width, height, minLabelSpacing = 80, ...axisOptions } = {}) {
    dimension(width); dimension(height);
    const visible = filterMeasurements(points, range), summary = summarizeMeasurements(visible, field);
    const axis = calculateYAxis(visible, target, axisOptions);
    return { range: range === null ? null : { ...range },
      points: visible.map((point, index) => ({ ...point, index, x: calculateX(point.date, range, width), y: calculateY(point.value, axis, height) })),
      xTicks: range === null ? [] : makeXTicks(range, width, { minLabelSpacing }),
      yAxis: { ...axis, ticks: axis.ticks.map((tick) => ({ ...tick, y: calculateY(tick.value, axis, height) })) },
      targetBand: calculateTargetBand(target, axis, height), summary,
      initialIndex: visible.length ? visible.length - 1 : null };
  }

  return Object.freeze({ parseDate, dateFromDay, addDays, daysBetween, shiftMonths, localDateString,
    parseMeasurement, sameMeasurement, extractMeasurements, customPeriod, rollingPeriod, allPeriod, calculatePeriod,
    filterMeasurements, summarizeMeasurements, calculateX, makeXTicks, calculateYAxis, calculateY, calculateTargetBand,
    selectionInfo, adjacentMeasurement, buildChartData });
});
