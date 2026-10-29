(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./body-graph.js") : root.BodyGraph,
    commonJS ? require("./record-transfer.js") : root.RecordTransfer);
  if (commonJS) module.exports = api;
  else root.ExerciseSummary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (calendar, transfer) {
  "use strict";
  const METRICS = Object.freeze([
    ["squat", "スクワット合計", "回"], ["march", "足踏み合計", "回"],
    ["plank", "プランク合計", "秒"], ["standing", "スタンディング平均", "時間"],
    ["walkSteps", "散歩歩数合計", "歩"], ["distance", "散歩距離合計", "km"]
  ].map(([field, label, unit]) => Object.freeze({ field, label, unit })));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const averageText = (value) => String(Number(value.toFixed(2)));

  function validatePeriod(range) {
    if (!range || calendar.daysBetween(range.start, range.end) !== 27 || calendar.parseDate(range.start).ordinal % 7 !== 0) {
      throw new RangeError("集計期間は月曜日から日曜日までの28日間です");
    }
    return range;
  }
  function latestPeriod(today) {
    const day = calendar.parseDate(today).ordinal, monday = day - day % 7;
    return { start: calendar.dateFromDay(monday - 28), end: calendar.dateFromDay(monday - 1) };
  }
  function movePeriod(range, direction, latest) {
    validatePeriod(range); validatePeriod(latest);
    if (![-1, 1].includes(direction)) throw new RangeError("移動方向は前または次です");
    try {
      const next = { start: calendar.addDays(range.start, direction * 28), end: calendar.addDays(range.end, direction * 28) };
      // The immediately preceding comparison period must also fit the calendar.
      if (next.end > latest.end || calendar.parseDate(next.start).ordinal < 28) return null;
      return next;
    } catch (error) { if (error instanceof RangeError) return null; throw error; }
  }

  // Sum decimal text exactly, including distance fractions and signed differences.
  function sum(values) {
    const parts = values.map((raw) => {
      if (Number(raw) === 0) return { digits: 0n, power: 0 };
      const [base, exponent = "0"] = String(raw).toLowerCase().split("e");
      return { digits: BigInt(base.replace(".", "")), power: Number(exponent) - (base.split(".")[1] || "").length };
    });
    const power = Math.min(0, ...parts.map((part) => part.power));
    let total = parts.reduce((value, part) => value + part.digits * 10n ** BigInt(part.power - power), 0n);
    if (total === 0n) return "0";
    const sign = total < 0n ? "-" : ""; if (total < 0n) total = -total;
    const digits = total.toString().padStart(1 - power, "0"), split = digits.length + power;
    return sign + (power === 0 ? digits : `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/0+$/, "").replace(/\.$/, ""));
  }

  function aggregate(records, range) {
    if (!range || calendar.daysBetween(range.start, range.end) < 0) throw new RangeError("集計期間が不正です");
    if (!object(records)) throw new TypeError("日付別の保存記録が必要です");
    const values = Object.fromEntries(METRICS.map(({ field }) => [field, []]));
    const invalid = Object.fromEntries(METRICS.map(({ field }) => [field, 0]));
    let savedDays = 0;
    for (const [date, entry] of Object.entries(records)) {
      calendar.parseDate(date);
      if (date < range.start || date > range.end) continue;
      savedDays++;
      for (const { field } of METRICS) {
        if (object(entry) && (!own(entry, field) || entry[field] === "")) continue;
        const raw = object(entry) ? entry[field] : undefined;
        try {
          if (raw === undefined) throw new Error("レコードが不正です");
          transfer.validateRecordsMap({ [date]: { [field]: raw } }, { strictValues: true });
          values[field].push(String(raw));
        } catch { invalid[field]++; }
      }
    }
    const metrics = Object.fromEntries(METRICS.map(({ field }) => {
      const count = values[field].length, total = sum(values[field]);
      const average = field === "standing" && count ? Number(total) / count : null;
      // Keep count (including saved zero) for totals, averages and goal judging.
      const performedDays = field === "standing" ? null : values[field].filter(value => calendar.compareDecimals(value, "0") > 0).length;
      return [field, { count, performedDays, invalid: invalid[field], value: count ? average === null ? total : averageText(average) : null, average }];
    }));
    return { range: { ...range }, savedDays, metrics };
  }

  function buildSummary(records, range) {
    validatePeriod(range);
    const current = aggregate(records, range);
    const previousRange = { start: calendar.addDays(range.start, -28), end: calendar.addDays(range.start, -1) };
    const previous = aggregate(records, previousRange);
    const weeks = Array.from({ length: 4 }, (_, index) => {
      const start = calendar.addDays(range.start, index * 7);
      const end = calendar.addDays(start, 6);
      return { start, end, ...aggregate(records, { start, end }) };
    });
    const comparisons = Object.fromEntries(METRICS.map(({ field }) => {
      const a = previous.metrics[field], b = current.metrics[field];
      const change = !a.count || !b.count ? null : field === "standing"
        ? averageText(b.average - a.average) : sum([b.value, a.value === "0" ? "0" : `-${a.value}`]);
      return [field, { change, direction: change === null ? "unavailable" : change === "0" ? "same" : change.startsWith("-") ? "decrease" : "increase" }];
    }));
    return { current, previous, comparisons, weeks };
  }
  // Goal arithmetic uses the existing totals; it never fills missing records.
  function goalProgress(field, metric, weeklyGoal, weekCount = 4) {
    if (typeof weeklyGoal !== "number" || !Number.isFinite(weeklyGoal) || weeklyGoal <= 0) return { status: "unset" };
    const target = field === "standing" ? String(weeklyGoal) : sum(Array(weekCount).fill(String(weeklyGoal)));
    if (!metric || !metric.count || metric.value === null) return { status: "no-data", target };
    const actual = field === "standing" ? String(metric.average) : metric.value;
    const parts = (raw) => { const [base, exponent = "0"] = raw.toLowerCase().split("e"); return { digits: BigInt(base.replace(".", "")), power: Number(exponent) - (base.split(".")[1] || "").length }; };
    const a = parts(actual), t = parts(target), power = Math.min(a.power, t.power);
    const value = a.digits * 10n ** BigInt(a.power - power), goal = t.digits * 10n ** BigInt(t.power - power);
    const achieved = value >= goal, rounded = (value * 200n + goal) / (goal * 2n);
    const difference = sum([actual, `-${target}`]);
    const roundedDifference = field === "standing" ? averageText(Number(difference)) : difference;
    return { status: "ready", target, achieved, rate: String(!achieved && rounded >= 100n ? 99n : rounded),
      difference: roundedDifference === "0" && difference !== "0" ? String(Number(Number(difference).toPrecision(2))) : roundedDifference };
  }
  function weeklyAchievements(weeks, goals, totalWeeks = weeks.length) {
    const metrics = Object.fromEntries(METRICS.map(({ field }) => {
      const goal = goals[field];
      if (goalProgress(field, null, goal, 1).status === "unset") return [field, { status: "unset" }];
      if (!totalWeeks) return [field, { status: "no-weeks" }];
      const achievedWeeks = weeks.filter(week => goalProgress(field, week.metrics[field], goal, 1).achieved).length;
      // Classify the exact fraction, before rounding the percentage for display.
      const level = achievedWeeks === totalWeeks ? "perfect" : achievedWeeks * 4 >= totalWeeks * 3 ? "high"
        : achievedWeeks * 2 >= totalWeeks ? "half" : achievedWeeks > 0 ? "some" : "zero";
      return [field, { status: "ready", achievedWeeks, rate: Math.round(achievedWeeks / totalWeeks * 100), level }];
    }));
    return { totalWeeks, metrics };
  }

  function allTimeAchievements(records, latest, goals) {
    validatePeriod(latest);
    const dates = Object.keys(records).sort();
    if (!dates.length) return weeklyAchievements([], goals);
    const first = calendar.parseDate(dates[0]).ordinal;
    const start = first + (7 - first % 7) % 7, end = calendar.parseDate(latest.end).ordinal;
    if (start > end) return weeklyAchievements([], goals);
    const totalWeeks = (end - start + 1) / 7, groups = new Map();
    // Empty weeks remain in the denominator without inventing any records.
    for (const date of dates) {
      const day = calendar.parseDate(date).ordinal;
      if (day < start || day > end) continue;
      const monday = calendar.dateFromDay(day - day % 7);
      if (!groups.has(monday)) groups.set(monday, {});
      groups.get(monday)[date] = records[date];
    }
    const weeks = Array.from(groups, ([start, entries]) => aggregate(entries, { start, end: calendar.addDays(start, 6) }));
    return weeklyAchievements(weeks, goals, totalWeeks);
  }
  return Object.freeze({ METRICS, latestPeriod, movePeriod, aggregate, buildSummary, goalProgress, weeklyAchievements, allTimeAchievements });
});
