"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const graph = require("../body-graph.js");
const transfer = require("../record-transfer.js");
const source = fs.readFileSync(path.join(__dirname, "../body-graph.js"), "utf8");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const series = (values, field = "weight") => graph.extractMeasurements(Object.fromEntries(values.map(([date, value]) => [date, day({ [field]: value })])))[field];
const target = Object.freeze({ min: 56, max: 56.9 });
const range = Object.freeze({ start: "2032-05-01", end: "2032-05-31" });
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test("moving averages use the inclusive trailing 28 calendar days and pre-display records, not 28 measurements", () => {
  const points = freeze(series([["2041-09-30", "200"], ["2041-10-01", "60"], ["2041-10-15", "66"], ["2041-10-28", "72"], ["2041-10-29", "80"], ["2041-11-01", "90"]]));
  const before = JSON.stringify(points), segments = graph.movingAverageSegments(points, { start: "2041-10-28", end: "2041-10-29" });
  assert.deepEqual(segments[0].map(p => [p.date, p.count]), [["2041-10-28", 3], ["2041-10-29", 3]]);
  assert.equal(segments[0][0].value, 66); assert.ok(Math.abs(segments[0][1].value - 218 / 3) < 1e-12);
  assert.equal(JSON.stringify(points), before);
});

test("moving averages independently exclude missing empty zero and invalid measurements without filling dates", () => {
  const data = freeze(graph.extractMeasurements({ "2041-01-01": day({ weight: "50", bodyFat: "10" }),
    "2041-01-02": day({ weight: "0", bodyFat: "20" }), "2041-01-03": day({ weight: "", bodyFat: "bad" }),
    "2041-01-04": day({ weight: "70" }), "2041-01-05": day({ weight: "NaN", bodyFat: 30 }) }));
  const bounds = { start: "2041-01-01", end: "2041-01-28" };
  assert.deepEqual(graph.movingAverageSegments(data.weight, bounds).flat().map(p => [p.date, p.value, p.count]), [["2041-01-01", 50, 1], ["2041-01-04", 60, 2]]);
  assert.deepEqual(graph.movingAverageSegments(data.bodyFat, bounds).flat().map(p => [p.date, p.value, p.count]), [["2041-01-01", 10, 1], ["2041-01-02", 15, 2]]);
  assert.deepEqual(graph.movingAverageSegments([], bounds), []); assert.deepEqual(graph.movingAverageSegments(data.weight, null), []);
});

test("insufficient windows split average segments across long gaps and leap-day boundaries are calendar based", () => {
  const data = series([["2041-01-01", "50"], ["2041-01-02", "52"], ["2041-01-03", "54"],
    ["2041-03-01", "60"], ["2041-03-02", "62"], ["2041-03-03", "64"]]);
  const segments = graph.movingAverageSegments(data, { start: "2041-01-01", end: "2041-03-03" });
  assert.deepEqual(segments.map(segment => segment.map(p => p.date)), [["2041-01-01", "2041-01-02", "2041-01-03"], ["2041-03-01", "2041-03-02", "2041-03-03"]]);
  const single = graph.movingAverageSegments(data.slice(0, 1), { start: "2041-01-01", end: "2041-03-03" });
  assert.equal(single.length, 1); assert.equal(single[0].length, 1); assert.equal(single[0][0].value, 50);
  const leap = graph.movingAverageSegments(series([["2040-02-01", "100"], ["2040-02-02", "10"], ["2040-02-29", "30"], ["2040-03-01", "50"]]), { start: "2040-02-29", end: "2040-03-01" });
  assert.deepEqual(leap[0].map(p => [p.value, p.count]), [[20, 2], [40, 2]]);
});

test("average-supported axes contain earlier outlying values while actual summaries remain unchanged", () => {
  const points = series([["2041-10-01", "140"], ["2041-10-27", "60"], ["2041-10-28", "50"]]), bounds = { start: "2041-10-27", end: "2041-10-28" };
  const extraValues = graph.movingAverageSegments(points, bounds).flat().map(p => p.value);
  const options = { field: "weight", width: 250, height: 180 }, plain = graph.buildChartData(points, bounds, target, options);
  const chart = graph.buildChartData(points, bounds, target, { ...options, extraValues });
  assert.ok(chart.yAxis.max > plain.yAxis.max); assert.deepEqual(chart.summary, plain.summary);
  assert.deepEqual(chart.points.map(p => p.raw), ["60", "50"]);
  for (const value of extraValues) assert.ok(graph.calculateY(value, chart.yAxis, 180) >= 0);
  const extreme = graph.movingAverageSegments(series([["2041-01-01", String(Number.MAX_VALUE)], ["2041-01-02", String(Number.MAX_VALUE)]]), { start: "2041-01-01", end: "2041-01-02" });
  assert.equal(extreme[0][0].value, Number.MAX_VALUE); assert.equal(extreme[0][1].value, Number.MAX_VALUE);
});

test("initial averages connect the first reading to the next 28-day average and restart only after calendar gaps", () => {
  const data = freeze(series([["2041-06-20", "57.3"], ["2041-06-27", "57.1"], ["2041-07-25", "58"], ["2041-07-26", "56"]]));
  const segments = graph.movingAverageSegments(data, { start: "2041-06-20", end: "2041-07-26" });
  assert.deepEqual(segments.map(s => s.map(p => [p.date, p.count])), [[['2041-06-20', 1], ['2041-06-27', 2]], [['2041-07-25', 1], ['2041-07-26', 2]]]);
  assert.equal(segments[0][0].value, 57.3); assert.ok(Math.abs(segments[0][1].value - 57.2) < 1e-12);
  assert.deepEqual(segments[1].map(p => p.value), [58, 57]);
  const clipped = graph.movingAverageSegments(data, { start: "2041-06-27", end: "2041-06-27" });
  assert.equal(clipped[0][0].count, 2); assert.ok(Math.abs(clipped[0][0].value - 57.2) < 1e-12);
});

test("half-unit ticks stay inside the unchanged automatic bounds and thin safely for wide or extreme ranges", () => {
  for (const goals of [target, { min: 15.5, max: 17.5 }, { min: 45, max: 100 }, { min: Number.MIN_VALUE, max: Number.MAX_VALUE }]) {
    const original = graph.calculateYAxis([], goals, { padding: .25 });
    const axis = graph.calculateYAxis([], goals, { padding: .25, tickStep: .5, tickCount: 13 });
    assert.equal(axis.min, original.min); assert.equal(axis.max, original.max);
    assert.ok(axis.ticks.length >= 1 && axis.ticks.length <= 13);
    assert.ok(axis.ticks.every(tick => Number.isFinite(tick.value) && tick.value >= axis.min && tick.value <= axis.max));
    if (goals.max < 20 || goals === target) {
      assert.equal(axis.step, .5);
      const expected = [];
      for (let value = Math.ceil(axis.min * 2) / 2; value <= axis.max; value += .5) expected.push(value);
      assert.deepEqual(axis.ticks.map(tick => tick.value), expected);
    } else assert.ok(axis.step > .5);
  }
  for (const tickStep of [0, -1, NaN, Infinity]) assert.throws(() => graph.calculateYAxis([], target, { tickStep }));
});

for (const [left, right, expected] of [["56", "56.00", 0], ["44.999999999999999999", "45", -1],
  ["70.000000000000000001", "70", 1], ["9007199254740992", "9007199254740993", -1],
  ["0", "3", -1], ["-0.1", "0", -1], ["1e-325", "0", 1], ["+5.6e1", "056.000", 0],
  ["-0", "0", 0], ["-.000", "0e999999", 0], ["-0.100000000000000001", "-0.1", -1]]) {
  test(`exact decimal comparison ${left} against ${right}`, () => {
    assert.equal(graph.compareDecimals(left, right), expected);
    assert.equal(graph.compareDecimals(right, left), expected === 0 ? 0 : -expected);
  });
}
test("public measurement difference reuses exact arithmetic and validates measurement inputs", () => {
  assert.equal(graph.measurementDifference("56.1", "59.099999999999999999"), "2.999999999999999999");
  assert.equal(graph.measurementDifference("59.1", "56.1"), "-3");
  assert.equal(graph.measurementDifference("56", "56.00"), "0");
  for (const raw of ["", "0", "-1", "NaN", "Infinity", 56, null]) assert.throws(() => graph.measurementDifference(raw, "56"));
  for (const raw of ["", " 56", "NaN", "Infinity", "1e309", 56, null]) assert.throws(() => graph.compareDecimals(raw, "56"));
  assert.equal(graph.parseMeasurement("0"), null); assert.equal(graph.parseMeasurement("1e-325"), null);
});

test("independent extraction preserves raw strings and chronological order", () => {
  const records = { "2032-05-12": day({ weight: "56.00", bodyFat: "16.50" }), "2032-05-10": day({ weight: "55.9" }), "2032-05-11": day({ bodyFat: "16.1" }) };
  const result = graph.extractMeasurements(records);
  assert.deepEqual(result.weight.map((point) => [point.date, point.raw]), [["2032-05-10", "55.9"], ["2032-05-12", "56.00"]]);
  assert.deepEqual(result.bodyFat.map((point) => point.date), ["2032-05-11", "2032-05-12"]);
  assert.equal(result.weight[1].decimal, "56"); assert.equal(result.bodyFat[1].raw, "16.50");
});

test("unrelated invalid fields never suppress valid body measurements", () => {
  const record = day({ weight: "55.1", bodyFat: "17.2", work: {}, squat: -7, distance: Infinity, kids: "bad" });
  const result = graph.extractMeasurements({ "2032-05-10": record });
  assert.equal(result.weight.length, 1); assert.equal(result.bodyFat.length, 1);
  assert.equal(record.distance, Infinity);
});

test("missing and malformed day records do not invent measurements", () => {
  const records = { "2032-05-10": {}, "2032-05-11": null, "2032-05-12": [], "2032-05-13": "bad", "2032-05-14": day() };
  const result = graph.extractMeasurements(records);
  assert.equal(result.weight.length, 0); assert.equal(result.bodyFat.length, 0);
  assert.equal(result.excluded.length, 10); assert.equal(Object.keys(records).length, 5);
});

for (const raw of ["", "0", "0.00", "-0", "NaN", "Infinity", "-1", "56kg", " 56", "56 ", "0x38", "1,000", "５６", "1e309", "1e-999", 56, 0, NaN, Infinity, false, null, {}, []]) {
  test(`exclude invalid, zero or wrong-type measurement ${String(raw)} (${typeof raw})`, () => {
    assert.equal(graph.parseMeasurement(raw), null);
    const result = graph.extractMeasurements({ "2032-05-10": day({ weight: raw, bodyFat: "16.5" }) });
    assert.equal(result.weight.length, 0); assert.equal(result.bodyFat.length, 1);
  });
}

for (const raw of ["556.3", "+56.0", "56.", ".5", "5.6e1", "1e-300", "5e-324", String(Number.MAX_VALUE)]) {
  test(`retain legitimate numeric string ${raw} with existing validation grammar`, () => {
    transfer.validateRecordsMap({ "2032-05-10": { weight: raw } }, { strictValues: true });
    const parsed = graph.parseMeasurement(raw);
    assert.equal(parsed.raw, raw); assert.equal(parsed.value, Number(raw));
    assert.equal(graph.extractMeasurements({ "2032-05-10": { weight: raw } }).weight.length, 1);
  });
}

test("numeric identity is exact without changing original representation", () => {
  assert.equal(graph.sameMeasurement("56.0", "56.00"), true);
  assert.equal(graph.sameMeasurement("16.5", "16.50"), true);
  assert.equal(graph.sameMeasurement("+5.6e1", "056.000"), true);
  assert.equal(graph.sameMeasurement(".00500", "5e-3"), true);
  assert.equal(graph.sameMeasurement("56.0", "56.1"), false);
  assert.equal(graph.sameMeasurement("9007199254740992", "9007199254740993"), false);
  assert.equal(graph.sameMeasurement(56, "56"), false);
  assert.equal(graph.sameMeasurement("0", "0.0"), false);
});

test("invalid record roots and invalid date keys are explicit errors", () => {
  for (const root of [null, [], "{}", 0]) assert.throws(() => graph.extractMeasurements(root));
  for (const date of ["2031-02-29", "2032-02-30", "2032-5-01", "0000-01-01", "10000-01-01", "__proto__"]) {
    assert.throws(() => graph.extractMeasurements(JSON.parse(`{"${date}":{"weight":"56"}}`)));
  }
});

test("extraction and downstream calculations preserve a frozen thirteen-field map", () => {
  const records = freeze({ "2032-05-10": day({ weight: "56.200", bodyFat: "16.00", kids: false, walkSteps: "0", extra: { note: "fictional" } }),
    "2032-05-12": day({ weight: "55.900", bodyFat: "16.50" }) });
  const original = JSON.stringify(records), originalKeys = Object.keys(records);
  const result = graph.extractMeasurements(records);
  freeze(result);
  graph.allPeriod(result); graph.filterMeasurements(result.weight, range);
  graph.buildChartData(result.weight, range, target, { field: "weight", width: 300, height: 180 });
  assert.equal(JSON.stringify(records), original); assert.deepEqual(Object.keys(records), originalKeys);
  assert.equal(Object.keys(transfer.DEFAULT_ENTRY).length, 13);
  assert.equal(records["2032-05-10"].weight, "56.200"); assert.equal(records["2032-05-10"].walkSteps, "0");
});

for (const [end, months, start] of [
  ["2026-10-21", 3, "2026-07-22"], ["2032-05-15", 3, "2032-02-16"],
  ["2032-03-31", 1, "2032-03-01"], ["2031-03-31", 1, "2031-03-01"],
  ["2032-08-31", 6, "2032-03-01"], ["2032-02-29", 12, "2031-03-01"],
  ["2032-01-31", 1, "2032-01-01"], ["2032-01-15", 3, "2031-10-16"],
  ["2033-02-28", 12, "2032-02-29"], ["2032-10-21", 6, "2032-04-22"]
]) {
  test(`rolling ${months} months ending ${end} starts ${start}`, () => {
    assert.deepEqual(graph.rollingPeriod(end, months), { start, end });
  });
}

test("all four rolling mode identifiers use their exact month counts", () => {
  for (const [mode, months] of [["1m", 1], ["3m", 3], ["6m", 6], ["1y", 12]]) {
    assert.deepEqual(graph.calculatePeriod(mode, { today: "2032-05-15" }), graph.rollingPeriod("2032-05-15", months));
  }
});

test("January month movement and return use the original anchor without drift", () => {
  const anchor = "2032-01-31";
  assert.equal(graph.shiftMonths(anchor, 1), "2032-02-29"); assert.equal(graph.shiftMonths(anchor, 2), "2032-03-31");
  for (const offset of [-1, -2, -12, -1, 0]) {
    const period = graph.rollingPeriod(anchor, 3, offset);
    assert.equal(period.end, graph.shiftMonths(anchor, offset));
  }
  assert.equal(graph.rollingPeriod(anchor, 3, 0).end, anchor);
  assert.equal(graph.rollingPeriod("2032-03-31", 3, -1).end, "2032-02-29");
  assert.equal(graph.rollingPeriod("2032-03-31", 3, -2).end, "2032-01-31");
});

test("caller-controlled anchors support midnight retention and latest/mode reset", () => {
  const before = graph.calculatePeriod("3m", { today: "2032-05-31", anchor: "2032-05-31", offset: -1 });
  assert.deepEqual(graph.calculatePeriod("3m", { today: "2032-06-01", anchor: "2032-05-31", offset: -1 }), before);
  assert.equal(graph.calculatePeriod("3m", { today: "2032-06-01" }).end, "2032-06-01");
  assert.deepEqual(graph.calculatePeriod("1y", { today: "2032-06-01" }), { start: "2031-06-02", end: "2032-06-01" });
});

test("future offsets, missing today, unsupported periods and date overflow fail", () => {
  for (const call of [() => graph.rollingPeriod("2032-05-31", 3, 1), () => graph.rollingPeriod("2032-05-31", 2),
    () => graph.rollingPeriod("2032-05-31", 3, 0.5), () => graph.calculatePeriod("bad", {}), () => graph.calculatePeriod("3m"),
    () => graph.calculatePeriod("3m", { today: "2032-05-31", anchor: "2032-06-01" }),
    () => graph.shiftMonths("0001-01-01", -1), () => graph.shiftMonths("9999-12-31", 1),
    () => graph.addDays("0001-01-01", -1), () => graph.addDays("9999-12-31", 1), () => graph.addDays("2032-01-01", 0.5)]) assert.throws(call);
});

test("custom ranges include both endpoints, same day and empty measurement ranges", () => {
  assert.deepEqual(graph.customPeriod("2032-02-29", "2032-02-29"), { start: "2032-02-29", end: "2032-02-29" });
  assert.deepEqual(graph.calculatePeriod("custom", range), range);
  assert.equal(graph.filterMeasurements([], range).length, 0);
  for (const dates of [["2032-05-31", "2032-05-01"], ["2031-02-29", "2032-05-01"], ["2032-05-01", "bad"]]) assert.throws(() => graph.customPeriod(...dates));
});

test("all-period combines independent valid dates and handles either or neither metric", () => {
  const data = graph.extractMeasurements({ "2032-04-01": day({ weight: "0" }), "2032-05-01": day({ bodyFat: "16" }),
    "2032-06-01": day({ weight: "55" }), "2032-07-01": day({ weight: "bad" }) });
  assert.deepEqual(graph.calculatePeriod("all", { measurements: data }), { start: "2032-05-01", end: "2032-06-01" });
  assert.deepEqual(graph.allPeriod({ weight: data.weight, bodyFat: [] }), { start: "2032-06-01", end: "2032-06-01" });
  assert.deepEqual(graph.allPeriod({ weight: [], bodyFat: data.bodyFat }), { start: "2032-05-01", end: "2032-05-01" });
  assert.equal(graph.allPeriod({ weight: [], bodyFat: [] }), null);
});

test("Gregorian calendar day arithmetic handles leap centuries and years 0001 to 9999", () => {
  assert.equal(graph.addDays("2032-02-28", 1), "2032-02-29"); assert.equal(graph.addDays("2032-02-29", 1), "2032-03-01");
  assert.equal(graph.addDays("2100-02-28", 1), "2100-03-01"); assert.equal(graph.addDays("2000-02-28", 1), "2000-02-29");
  assert.equal(graph.addDays("2031-12-31", 1), "2032-01-01");
  assert.equal(graph.parseDate("0001-01-01").ordinal, 0);
  for (const date of ["0001-01-01", "0099-12-31", "2000-02-29", "2032-03-01", "9999-12-31"]) {
    assert.equal(graph.dateFromDay(graph.parseDate(date).ordinal), date);
  }
  assert.equal(graph.daysBetween("2032-03-01", "2032-03-10"), 9);
  assert.equal(graph.daysBetween("2032-03-10", "2032-03-01"), -9);
});

test("calendar computations are timezone/DST independent; supplied local date remains local", () => {
  const modulePath = path.join(__dirname, "../body-graph.js");
  const code = 'const g=require(process.argv[1]); console.log(JSON.stringify({days:g.daysBetween("2032-03-13","2032-03-15"),period:g.rollingPeriod("2032-03-31",3),local:g.localDateString(new Date("2032-01-01T00:30:00Z"))}));';
  const outputs = ["Asia/Tokyo", "America/Los_Angeles", "UTC"].map((zone) => JSON.parse(execFileSync(process.execPath, ["-e", code, modulePath], { env: { ...process.env, TZ: zone }, encoding: "utf8" })));
  for (const output of outputs) { assert.equal(output.days, 2); assert.deepEqual(output.period, { start: "2032-01-01", end: "2032-03-31" }); }
  assert.deepEqual(outputs.map((output) => output.local), ["2032-01-01", "2031-12-31", "2032-01-01"]);
});

test("filter includes exact boundary days and returns copies in sorted order", () => {
  const points = series([["2032-04-30", "54"], ["2032-05-01", "55"], ["2032-05-31", "56"], ["2032-06-01", "57"]]).reverse();
  const original = JSON.stringify(points), filtered = graph.filterMeasurements(points, range);
  assert.deepEqual(filtered.map((point) => point.date), ["2032-05-01", "2032-05-31"]);
  assert.equal(JSON.stringify(points), original); assert.notEqual(filtered[0], points[2]);
});

test("zero and one measurement have no fabricated change", () => {
  assert.deepEqual(graph.summarizeMeasurements([], "weight"), { count: 0, first: null, last: null, change: null, unit: "kg", changeUnit: "kg" });
  const single = graph.summarizeMeasurements(series([["2032-05-10", "56.00"]]), "weight");
  assert.equal(single.count, 1); assert.equal(single.first.raw, "56.00"); assert.deepEqual(single.first, single.last); assert.equal(single.change, null);
});

for (const [first, last, change] of [["56.2", "55.9", "-0.3"], ["55.9", "56.2", "0.3"], ["56.00", "56.0", "0"],
  ["1e-3", "2.5e-3", "0.0015"], ["9007199254740992", "9007199254740993", "1"], ["0.00000000001", "0.00000000002", "0.00000000001"]]) {
  test(`exact decimal change ${first} to ${last} equals ${change}`, () => {
    const summary = graph.summarizeMeasurements(series([["2032-05-01", first], ["2032-05-31", last]]), "weight");
    assert.equal(summary.change, change); assert.equal(summary.first.raw, first); assert.equal(summary.last.raw, last);
  });
}

test("body-fat statistics use percentage points and independent measurement dates", () => {
  const data = graph.extractMeasurements({ "2032-05-01": day({ weight: "56.2" }), "2032-05-10": day({ bodyFat: "16.1" }), "2032-05-31": day({ weight: "55.9", bodyFat: "16.5" }) });
  assert.equal(graph.summarizeMeasurements(data.weight, "weight").change, "-0.3");
  const summary = graph.summarizeMeasurements(data.bodyFat, "bodyFat");
  assert.equal(summary.first.date, "2032-05-10"); assert.equal(summary.change, "0.4"); assert.equal(summary.changeUnit, "パーセントポイント");
  assert.throws(() => graph.summarizeMeasurements(data.weight, "bodyFat"));
});

test("x coordinates use actual day gaps, full axis bounds and same-day center", () => {
  const bounds = { start: "2032-09-01", end: "2032-09-10" };
  assert.equal(graph.calculateX("2032-09-01", bounds, 270), 0);
  assert.equal(graph.calculateX("2032-09-02", bounds, 270), 30);
  assert.equal(graph.calculateX("2032-09-10", bounds, 270), 270);
  assert.equal(graph.calculateX("2032-09-01", { start: "2032-09-01", end: "2032-09-01" }, 270), 135);
  assert.throws(() => graph.calculateX("2032-08-31", bounds, 270));
});

for (const width of [320, 375, 390, 430]) {
  test(`x ticks respect numeric spacing at ${width}px without removing points`, () => {
    for (const bounds of [range, graph.rollingPeriod("2032-05-31", 3), graph.rollingPeriod("2032-05-31", 6), graph.rollingPeriod("2032-05-31", 12), { start: "2031-01-01", end: "2035-12-31" }]) {
      const ticks = graph.makeXTicks(bounds, width);
      assert.ok(ticks.length >= 1);
      for (let index = 0; index < ticks.length; index++) {
        assert.ok(ticks[index].x >= 0 && ticks[index].x <= width);
        assert.ok(ticks[index].date >= bounds.start && ticks[index].date <= bounds.end);
        if (index) assert.ok(ticks[index].x - ticks[index - 1].x >= 80 - 1e-9);
      }
    }
  });
}

test("tiny, single-day, year-crossing and maximum-length tick ranges are safe", () => {
  assert.equal(graph.makeXTicks(range, 20).length, 1);
  assert.equal(graph.makeXTicks({ start: range.start, end: range.start }, 300)[0].x, 150);
  assert.match(graph.makeXTicks({ start: "2031-12-01", end: "2032-01-31" }, 300)[0].label, /^3[12]\//);
  assert.ok(graph.makeXTicks({ start: "0001-01-01", end: "9999-12-31" }, 160).length >= 1);
});

for (const [name, values, goals] of [
  ["empty", [], target], ["single", ["56.2"], target], ["same", ["56.2", "56.2"], target],
  ["equal goal", ["56"], { min: 56, max: 56 }], ["outlier", ["556.3"], target],
  ["maximum", [String(Number.MAX_VALUE)], target], ["minimum", ["5e-324"], { min: Number.MIN_VALUE, max: Number.MIN_VALUE }],
  ["maximum goal", ["56"], { min: Number.MAX_VALUE, max: Number.MAX_VALUE }]
]) {
  test(`finite y-axis and coordinates for ${name}`, () => {
    const points = series(values.map((value, index) => [`2032-05-${String(index + 1).padStart(2, "0")}`, value]));
    const axis = graph.calculateYAxis(points, goals);
    for (const number of [axis.min, axis.max, axis.step]) assert.ok(Number.isFinite(number));
    assert.ok(axis.max > axis.min); assert.ok(axis.step > 0);
    for (const value of [goals.min, goals.max, ...points.map((point) => point.value)]) {
      assert.ok(value >= axis.min && value <= axis.max);
      const y = graph.calculateY(value, axis, 180); assert.ok(Number.isFinite(y) && y >= 0 && y <= 180);
    }
    for (const tick of axis.ticks) assert.ok(Number.isFinite(tick.value) && tick.value >= axis.min && tick.value <= axis.max);
    const band = graph.calculateTargetBand(goals, axis, 180);
    assert.ok(band.top >= 0 && band.bottom <= 180 && band.height >= 0);
  });
}

test("y-axis need not start at zero and goals are caller supplied", () => {
  const points = series([["2032-05-10", "56.2"]]), normal = graph.calculateYAxis(points, target);
  assert.ok(normal.min > 0);
  const changed = graph.calculateYAxis(points, { min: 80, max: 81 });
  assert.ok(changed.max >= 81); assert.ok(changed.min <= 56.2); assert.notDeepEqual(normal, changed);
});

test("goal band coordinates and collapsed equal limits are explicit", () => {
  const axis = { min: 50, max: 60 };
  assert.deepEqual(graph.calculateTargetBand({ min: 54, max: 56 }, axis, 200), { top: 80, bottom: 120, height: 40, collapsed: false });
  assert.deepEqual(graph.calculateTargetBand({ min: 55, max: 55 }, axis, 200), { top: 100, bottom: 100, height: 0, collapsed: true });
});

test("invalid axis inputs fail instead of propagating NaN or Infinity", () => {
  for (const goals of [null, { min: 0, max: 56 }, { min: 57, max: 56 }, { min: NaN, max: 56 }, { min: 1, max: Infinity }]) assert.throws(() => graph.calculateYAxis([], goals));
  for (const size of [0, -1, NaN, Infinity, "300"]) {
    assert.throws(() => graph.calculateX(range.start, range, size));
    assert.throws(() => graph.calculateY(56, { min: 50, max: 60 }, size));
  }
  for (const axis of [{ min: 56, max: 56 }, { min: -Infinity, max: 60 }, { min: 50, max: Infinity }]) assert.throws(() => graph.calculateY(56, axis, 200));
  for (const options of [{ minSpan: 0 }, { padding: NaN }, { tickCount: 1 }, { tickCount: 100 }]) assert.throws(() => graph.calculateYAxis([], target, options));
});

test("subnormal axis steps remain finite even when requested span is minimal", () => {
  const goals = { min: Number.MIN_VALUE, max: Number.MIN_VALUE };
  const axis = graph.calculateYAxis([], goals, { minSpan: Number.MIN_VALUE, padding: 0 });
  assert.ok(Number.isFinite(axis.step) && axis.step > 0); assert.ok(axis.max > axis.min);
});

test("chart data contains only measured in-range points and exact summary", () => {
  const points = series([["2032-04-30", "1"], ["2032-05-01", "56.2"], ["2032-05-02", "56.1"], ["2032-05-31", "55.9"], ["2032-06-01", "999"]]);
  const data = graph.buildChartData(points, range, target, { field: "weight", width: 300, height: 180 });
  assert.equal(data.points.length, 3); assert.deepEqual(data.points.map((point) => point.index), [0, 1, 2]);
  assert.equal(data.points[0].x, 0); assert.equal(data.points[1].x, 10); assert.equal(data.points[2].x, 300);
  assert.equal(data.summary.change, "-0.3"); assert.equal(data.initialIndex, 2);
  assert.ok(data.yAxis.max < 999); assert.equal(data.summary.first.raw, "56.2");
});

test("empty chart and single point have explicit safe selection/summary results", () => {
  const options = { field: "weight", width: 300, height: 180 };
  const empty = graph.buildChartData([], null, target, options);
  assert.equal(empty.initialIndex, null); assert.equal(empty.summary.first, null); assert.equal(empty.summary.change, null);
  assert.deepEqual(empty.points, []); assert.deepEqual(empty.xTicks, []);
  const points = series([["2032-05-10", "56"]]);
  const single = graph.buildChartData(points, { start: "2032-05-10", end: "2032-05-10" }, target, options);
  assert.equal(single.points[0].x, 150); assert.equal(single.summary.change, null); assert.equal(single.initialIndex, 0);
  assert.equal(graph.buildChartData(points, { start: "2032-06-01", end: "2032-06-02" }, target, options).points.length, 0);
});

test("selection defaults to latest, retains a valid date, falls back after removal", () => {
  const points = series([["2032-05-01", "56"], ["2032-05-02", "56.1"], ["2032-05-31", "56.2"]]);
  assert.equal(graph.selectionInfo(points).index, 2);
  const selected = graph.selectionInfo(points, "2032-05-02");
  assert.equal(selected.index, 1); assert.equal(selected.previous.date, "2032-05-01"); assert.equal(selected.next.date, "2032-05-31");
  assert.equal(graph.selectionInfo(points, "2032-05-03").index, 2);
  assert.equal(graph.selectionInfo(points, "2032-05-01").previous, null);
  assert.equal(graph.selectionInfo(points, "2032-05-31").next, null);
  assert.equal(graph.adjacentMeasurement(points, 0, -1), null); assert.equal(graph.adjacentMeasurement(points, 2, 1), null);
  assert.equal(graph.adjacentMeasurement(points, 1, -1).date, "2032-05-01");
  assert.equal(graph.adjacentMeasurement(points, 1, 1).date, "2032-05-31");
  assert.deepEqual(graph.selectionInfo([]), { index: null, point: null, previous: null, next: null });
  assert.equal(graph.adjacentMeasurement([], 0, 1), null);
});

test("selection keeps a date while refreshing its value", () => {
  const changed = series([["2032-05-01", "56"], ["2032-05-02", "57.5"]]);
  assert.equal(graph.selectionInfo(changed, "2032-05-02").point.raw, "57.5");
  const single = graph.selectionInfo(changed.slice(0, 1));
  assert.equal(single.previous, null); assert.equal(single.next, null);
});

test("5000 fictional measurements are retained while only axis labels thin out", () => {
  const records = {};
  for (let index = 0; index < 5000; index++) records[graph.addDays("2030-01-01", index)] = day({ weight: String(55 + index % 10 / 10) });
  const measurements = graph.extractMeasurements(records), bounds = graph.allPeriod(measurements);
  const chart = graph.buildChartData(measurements.weight, bounds, target, { field: "weight", width: 320, height: 180 });
  assert.equal(chart.points.length, 5000); assert.equal(chart.summary.count, 5000); assert.equal(chart.initialIndex, 4999);
  assert.ok(chart.xTicks.length <= 5); assert.equal(chart.points[4999].x, 320);
  for (let index = 0; index < chart.points.length; index++) assert.equal(chart.points[index].index, index);
  assert.equal(graph.adjacentMeasurement(chart.points, 4998, 1).date, chart.points[4999].date);
  const sample = measurements.weight.slice(0, 100);
  for (let index = 0; index < sample.length - 1; index++) assert.equal(graph.adjacentMeasurement(sample, index, 1).date, sample[index + 1].date);
});

test("standalone browser module loads and calculates with forbidden platform getters", () => {
  let accesses = 0;
  const sandbox = {};
  for (const name of ["localStorage", "sessionStorage", "document", "navigator", "fetch", "XMLHttpRequest", "indexedDB", "Date"]) {
    Object.defineProperty(sandbox, name, { get() { accesses++; throw new Error(`forbidden: ${name}`); } });
  }
  vm.runInNewContext(source, sandbox);
  const api = sandbox.BodyGraph;
  const data = api.extractMeasurements({ "2032-05-01": day({ weight: "56.2" }), "2032-05-31": day({ weight: "55.9" }) });
  const plot = api.buildChartData(data.weight, api.calculatePeriod("all", { measurements: data }), target, { field: "weight", width: 300, height: 180 });
  assert.equal(plot.summary.change, "-0.3"); assert.equal(api.sameMeasurement("56.0", "56.00"), true);
  api.calculatePeriod("3m", { today: "2032-05-31" }); api.selectionInfo(data.weight); api.adjacentMeasurement(data.weight, 0, 1);
  assert.equal(accesses, 0); assert.ok(Object.isFrozen(api));
  assert.doesNotMatch(source, /exercise-record\.entries\.v1|\.setItem\(|\.getItem\(|\.removeItem\(/);
});

test("one-month labels target five distributed calendar dates including both ends", () => {
  const bounds = graph.rollingPeriod("2026-10-22", 1);
  assert.deepEqual(graph.makeXTicks(bounds, 247, { minLabelSpacing: 40 }).map((tick) => tick.label), ["9/23", "9/30", "10/8", "10/15", "10/22"]);
});

for (const width of [197, 252, 267, 307]) for (const [name, bounds] of [
  ["1m", graph.rollingPeriod("2032-10-22", 1)], ["3m", graph.rollingPeriod("2032-10-22", 3)],
  ["6m", graph.rollingPeriod("2032-10-22", 6)], ["1y", graph.rollingPeriod("2032-10-22", 12)],
  ["all", { start: "2030-01-17", end: "2036-10-22" }], ["custom", { start: "2031-12-10", end: "2032-04-19" }]
]) test(`adaptive ${name} ticks fill ${width}px without changing bounds, points, or coordinates`, () => {
  const crossYear = bounds.start.slice(0, 4) !== bounds.end.slice(0, 4);
  const spacing = Math.max(crossYear ? 105 : 80, width / 3), original = JSON.stringify(bounds);
  const values = series([[bounds.start, "56.2"], [graph.addDays(bounds.start, 1), "56.1"], [bounds.end, "55.9"]]);
  const before = JSON.stringify(values), data = graph.buildChartData(values, bounds, target, { field: "weight", width, height: 180, minLabelSpacing: spacing });
  assert.ok(data.xTicks.length >= 2 && data.xTicks.length <= 4);
  for (const [index, tick] of data.xTicks.entries()) {
    assert.equal(tick.x, graph.daysBetween(bounds.start, tick.date) / graph.daysBetween(bounds.start, bounds.end) * width);
    assert.ok(tick.date >= bounds.start && tick.date <= bounds.end);
    if (index) assert.ok(tick.x - data.xTicks[index - 1].x >= spacing - 1e-9);
    if (crossYear && (!index || tick.date.slice(0, 4) !== data.xTicks[index - 1].date.slice(0, 4))) assert.match(tick.label, /^\d{2}\//);
    else assert.match(tick.label, /^\d{1,2}\/\d{1,2}$/);
  }
  assert.equal(data.points.length, 3); assert.equal(data.points[0].x, 0); assert.equal(data.points[2].x, width);
  assert.ok(Math.abs(data.points[1].x - width / graph.daysBetween(bounds.start, bounds.end)) < 1e-9);
  assert.equal(data.summary.change, "-0.3"); assert.equal(JSON.stringify(bounds), original); assert.equal(JSON.stringify(values), before);
});

for (const [mode, bounds] of [
  ["1m", graph.rollingPeriod("2032-10-22", 1)], ["3m", graph.rollingPeriod("2032-10-22", 3)],
  ["6m", graph.rollingPeriod("2032-10-22", 6)], ["1y", graph.rollingPeriod("2032-10-22", 12)],
  ["all", { start: "2030-01-17", end: "2036-10-22" }], ["custom", { start: "2031-12-10", end: "2032-04-19" }]
]) test(`five ${mode} ticks retain exact dates, day spacing and all measurement points`, () => {
  for (const width of [197, 252, 267, 307]) {
    const ticks = graph.makeXTicks(bounds, width, { minLabelSpacing: 40 });
    assert.equal(ticks.length, 5); assert.equal(ticks[0].date, bounds.start); assert.equal(ticks[4].date, bounds.end);
    const before = JSON.stringify(bounds), records = {};
    for (let index = 0; index <= graph.daysBetween(bounds.start, bounds.end); index++) records[graph.addDays(bounds.start, index)] = day({ weight: "56.2" });
    const extracted = graph.extractMeasurements(records).weight, chart = graph.buildChartData(extracted, bounds, target, { field: "weight", width, height: 180, minLabelSpacing: 40 });
    for (const tick of ticks) assert.equal(tick.x, graph.calculateX(tick.date, bounds, width));
    assert.equal(chart.points.length, extracted.length); assert.equal(chart.summary.change, "0");
    assert.equal(JSON.stringify(bounds), before);
  }
});

test("year-crossing labels use zero-padded two-digit years while retaining complete date keys", () => {
  const bounds = { start: "2025-10-23", end: "2026-10-22" }, ticks = graph.makeXTicks(bounds, 300, { minLabelSpacing: 1 });
  assert.deepEqual(ticks.map((tick) => tick.label), ["25/10/23", "26/1/22", "4/23", "7/23", "10/22"]);
  assert.equal(graph.makeXTicks({ start: "2005-12-31", end: "2006-01-01" }, 300, { minLabelSpacing: 1 })[0].label, "05/12/31");
  assert.equal(graph.makeXTicks({ start: "2032-05-01", end: "2032-05-31" }, 300)[0].label, "5/1");
  assert.equal(ticks[0].date, bounds.start); assert.equal(ticks[4].date, bounds.end);
});

test("same-year axes keep month/day labels even at the first tick", () => {
  const ticks = graph.makeXTicks({ start: "2032-01-03", end: "2032-11-23" }, 320, { minLabelSpacing: 1 });
  assert.equal(ticks.length, 5);
  assert.ok(ticks.every((tick) => tick.label === `${graph.parseDate(tick.date).month}/${graph.parseDate(tick.date).day}`));
});

test("multi-year axes show the year only at the first displayed tick of each new year", () => {
  const bounds = { start: "2030-10-23", end: "2032-02-22" };
  const ticks = graph.makeXTicks(bounds, 320, { minLabelSpacing: 1 });
  assert.deepEqual(ticks.map((tick) => tick.label.split("/").length), [3, 3, 2, 2, 3]);
  for (const [index, tick] of ticks.entries()) {
    const { year, month, day } = graph.parseDate(tick.date);
    const yearChanged = !index || year !== graph.parseDate(ticks[index - 1].date).year;
    assert.equal(tick.label, (yearChanged ? `${String(year % 100).padStart(2, "0")}/` : "") + `${month}/${day}`);
    assert.equal(tick.x, graph.calculateX(tick.date, bounds, 320));
  }
});

test("year annotations are recalculated after thinning and preserve single-tick context", () => {
  const bounds = { start: "2030-10-23", end: "2032-02-22" };
  for (const maxTicks of [5, 4, 3, 2, 1]) {
    const ticks = graph.makeXTicks(bounds, 320, { minLabelSpacing: 1, maxTicks });
    assert.equal(ticks.length, maxTicks);
    for (const [index, tick] of ticks.entries()) {
      assert.equal(tick.label.split("/").length, !index || tick.date.slice(0, 4) !== ticks[index - 1].date.slice(0, 4) ? 3 : 2);
    }
  }
  const boundary = graph.makeXTicks({ start: "2099-12-31", end: "2100-01-01" }, 320, { minLabelSpacing: 1 });
  assert.deepEqual(boundary.map((tick) => tick.label), ["99/12/31", "00/1/1"]);
});

test("short ranges avoid duplicate dates and narrow axes reduce count without losing boundaries", () => {
  for (let days = 0; days <= 5; days++) {
    const bounds = { start: "2032-02-28", end: graph.addDays("2032-02-28", days) };
    const ticks = graph.makeXTicks(bounds, 300, { minLabelSpacing: 1 });
    assert.equal(ticks.length, Math.min(5, days + 1)); assert.equal(new Set(ticks.map((tick) => tick.date)).size, ticks.length);
    assert.equal(ticks[0].date, bounds.start); assert.equal(ticks.at(-1).date, bounds.end);
  }
  const bounds = graph.rollingPeriod("2032-10-22", 3);
  assert.equal(graph.makeXTicks(bounds, 160, { minLabelSpacing: 60 }).length, 3);
  for (const maxTicks of [0, 6, 2.5, NaN]) assert.throws(() => graph.makeXTicks(bounds, 300, { maxTicks }));
});

test("short custom dates, narrow axes, leap days and maximum ranges keep valid separated labels", () => {
  for (const bounds of [{ start: "2032-02-29", end: "2032-02-29" }, { start: "2032-02-28", end: "2032-03-02" },
    { start: "0001-01-01", end: "9999-12-31" }]) for (const width of [20, 80, 160, 307]) {
    const ticks = graph.makeXTicks(bounds, width, { minLabelSpacing: 80 }); assert.ok(ticks.length >= 1);
    for (const [index, tick] of ticks.entries()) {
      assert.ok(Number.isFinite(tick.x) && tick.x >= 0 && tick.x <= width);
      if (index) assert.ok(tick.x - ticks[index - 1].x >= 80 - 1e-9);
    }
  }
});
