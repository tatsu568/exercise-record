"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const graph = require("../body-graph.js"), attention = require("../measurement-attention.js");
const defaults = Object.freeze({ ...require("../app-settings.js").DEFAULTS.attention });
// Every record below is fictional. No files containing user records are read.
const day = (values = {}) => ({ work: "", kids: false, standing: 10, squat: 0, march: 0, plank: 0,
  walkMinutes: "", walkSeconds: "", distance: "", walkSteps: "", weight: "", bodyFat: "", basal: "", ...values });
const records = (rows, field = "weight") => Object.fromEntries(rows.map(([date, raw]) => [date, day({ [field]: raw })]));
const run = (rows, settings = {}, range, field = "weight") => attention.evaluateAttention(records(rows, field), { ...defaults, ...settings }, range);
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const state = (point, status) => ({ ...point.identity, status });

for (const [id, field, raw, expected] of [
  ["F01", "weight", "44.9", "below"], ["F02", "weight", "45.0", null], ["F03", "weight", "56.0", null],
  ["F04", "weight", "70.0", null], ["F05", "weight", "70.1", "above"],
  ["F06", "bodyFat", "9.9", "below"], ["F07", "bodyFat", "10.0", null], ["F08", "bodyFat", "16.0", null],
  ["F09", "bodyFat", "30.0", null], ["F10", "bodyFat", "30.1", "above"]
]) test(`${id}: fixed boundary ${field}=${raw}`, () => {
  const result = run([["2041-05-10", raw]], {}, undefined, field), point = result[field][0];
  assert.equal(point.fixedRange, expected); assert.equal(point.isAttention, expected !== null);
  assert.equal(point.raw, raw); assert.equal(point.rapidChange, false); assert.equal(point.comparison, null);
  assert.equal(result.counts[field].totalAttention, expected ? 1 : 0);
});
test("F11: every range is supplied by the caller, without hardcoded decision limits", () => {
  const result = attention.evaluateAttention({ "2041-05-10": day({ weight: "49.9", bodyFat: "20.1" }) },
    { ...defaults, weightMin: 50, weightMax: 60, bodyFatMin: 15, bodyFatMax: 20 });
  assert.equal(result.weight[0].fixedRange, "below"); assert.equal(result.bodyFat[0].fixedRange, "above");
  assert.equal(result.weight[0].reasons[0].bound, "50");
});
test("equal minimum and maximum accepts that value and flags either side", () => {
  for (const [raw, expected] of [["55.999999999999999999", "below"], ["56.00", null], ["56.000000000000000001", "above"]]) {
    assert.equal(run([["2041-05-10", raw]], { weightMin: 56, weightMax: 56 }).weight[0].fixedRange, expected);
  }
});

for (const raw of ["", "0", "0.00", "-0", "NaN", "Infinity", "-1", "56kg", " 56", "56 ", "0x38", "1,000", "５６", "1e309", "1e-999", 56, 0, NaN, Infinity, false, null, {}, []]) {
  test(`V: excluded measurement ${String(raw)} (${typeof raw}) never suppresses the other field`, () => {
    for (const field of ["weight", "bodyFat"]) {
      const other = field === "weight" ? "bodyFat" : "weight";
      const result = attention.evaluateAttention({ "2041-05-10": day({ [field]: raw, [other]: "56" }) }, defaults);
      assert.equal(result[field].length, 0); assert.equal(result[other].length, 1);
      assert.equal(result.excluded.length, 1); assert.equal(result.counts[field].totalAttention, 0);
    }
  });
}
test("V04: absent fields and malformed old daily records never create measurements", () => {
  const input = { "2041-05-10": {}, "2041-05-11": null, "2041-05-12": [], "2041-05-13": "old" };
  const result = attention.evaluateAttention(input, defaults);
  assert.equal(result.weight.length + result.bodyFat.length, 0); assert.equal(result.excluded.length, 8);
  assert.deepEqual(Object.keys(input), ["2041-05-10", "2041-05-11", "2041-05-12", "2041-05-13"]);
});
for (const raw of ["+56.0", "56.", ".5", "5.6e1", "1e-300", "5e-324", String(Number.MAX_VALUE)]) {
  test(`retain the existing legitimate measurement grammar: ${raw}`, () => {
    const point = run([["2041-05-10", raw]]).weight[0];
    assert.equal(point.raw, raw); assert.equal(point.decimal, graph.parseMeasurement(raw).decimal);
  });
}

for (const [id, firstDate, lastDate, first, last, settings, expected] of [
  ["R01", "2041-05-01", "2041-05-02", "56.0", "58.9", {}, false],
  ["R02", "2041-05-01", "2041-05-02", "56.0", "59.0", {}, true],
  ["R03", "2041-05-01", "2041-05-02", "56.0", "59.1", {}, true],
  ["R04", "2041-05-01", "2041-05-02", "59.0", "56.0", {}, true],
  ["R07", "2041-05-01", "2041-05-11", "56", "59", {}, true],
  ["R08", "2041-05-01", "2041-05-12", "56", "59", {}, false],
  ["R09a", "2041-05-01", "2041-05-08", "56", "59", { compareDays: 7 }, true],
  ["R09b", "2041-05-01", "2041-05-09", "56", "59", { compareDays: 7 }, false],
  ["R10", "2041-05-01", "2041-05-02", "56", "58.5", { weightChange: 2.5 }, true],
  ["R14", "2041-04-30", "2041-05-01", "56", "59", { compareDays: 1 }, true],
  ["R15", "2041-12-31", "2042-01-01", "56", "59", { compareDays: 1 }, true],
  ["R16a", "2040-02-28", "2040-03-01", "56", "59", { compareDays: 2 }, true],
  ["R16b", "2040-02-28", "2040-03-01", "56", "59", { compareDays: 1 }, false],
  ["R16c", "2040-02-29", "2040-03-01", "56", "59", { compareDays: 1 }, true],
  ["R365", "2041-01-01", "2042-01-01", "56", "59", { compareDays: 365 }, true]
]) test(`${id}: rapid change uses exact signed difference and calendar days`, () => {
  const point = run([[firstDate, first], [lastDate, last]], settings).weight[1];
  assert.equal(point.rapidChange, expected); assert.equal(point.comparison.date, firstDate);
  assert.equal(point.comparison.days, graph.daysBetween(firstDate, lastDate));
  assert.equal(point.comparison.difference, graph.measurementDifference(first, last));
});
test("R05: first valid measurement has no rapid reason or fabricated comparison", () => {
  const point = run([["2041-05-10", "56"]]).weight[0];
  assert.equal(point.comparison, null); assert.equal(point.rapidChange, false);
});
test("R06/V07: skip intervening absent, empty, zero, invalid and wrong-type measurements", () => {
  const input = records([["2041-05-01", "56"], ["2041-05-03", ""], ["2041-05-04", "0"],
    ["2041-05-06", "bad"], ["2041-05-07", 58], ["2041-05-11", "59"]]);
  input["2041-05-08"] = {};
  const point = attention.evaluateAttention(input, defaults).weight[1];
  assert.equal(point.comparison.date, "2041-05-01"); assert.equal(point.comparison.days, 10); assert.equal(point.rapidChange, true);
});
test("R11: out-of-range predecessor is used before visible counts are filtered", () => {
  const result = run([["2041-05-09", "60"], ["2041-05-10", "71"]], {}, { start: "2041-05-10", end: "2041-05-10" });
  assert.equal(result.weight.length, 2); assert.equal(result.weight[0].inRange, false);
  assert.equal(result.weight[1].comparison.date, "2041-05-09"); assert.equal(result.weight[1].rapidChange, true);
  assert.equal(result.counts.weight.totalAttention, 1);
});
test("R12: each field uses its own previous valid date", () => {
  const result = attention.evaluateAttention({ "2041-05-01": day({ weight: "56" }), "2041-05-03": day({ bodyFat: "16" }),
    "2041-05-11": day({ weight: "59", bodyFat: "19" }) }, defaults);
  assert.equal(result.weight[1].comparison.days, 10); assert.equal(result.bodyFat[1].comparison.days, 8);
  assert.equal(result.weight[1].rapidChange, true); assert.equal(result.bodyFat[1].rapidChange, true);
});
test("R13: body fat uses percentage points and its independent supplied threshold", () => {
  const point = run([["2041-05-01", "16.0"], ["2041-05-02", "19.0"]], { weightChange: 9 }, undefined, "bodyFat").bodyFat[1];
  assert.equal(point.comparison.difference, "3"); assert.equal(point.rapidChange, true); assert.equal(point.reasons[0].unit, "pt");
  assert.equal(run([["2041-05-01", "16"], ["2041-05-02", "18.5"]], { bodyFatChange: 2.5 }, undefined, "bodyFat").bodyFat[1].rapidChange, true);
});

for (const [id, first, last, expected, delta] of [
  ["D01", "56.1", "59.099999999999999999", false, "2.999999999999999999"],
  ["D02", "56.1", "59.1", true, "3"],
  ["D03", "56.1", "59.100000000000000001", true, "3.000000000000000001"],
  ["D06", "56", "56.00", false, "0"],
  ["D07", "9007199254740992", "9007199254740993", false, "1"],
  ["D-negative", "59.099999999999999999", "56.1", false, "-2.999999999999999999"]
]) test(`${id}: exact decimal rapid comparison`, () => {
  const result = run([["2041-05-01", first], ["2041-05-02", last]]), point = result.weight[1];
  assert.equal(point.rapidChange, expected); assert.equal(point.comparison.difference, delta);
  assert.equal(result.weight[0].raw, first); assert.equal(point.raw, last);
});
for (const [id, raw, expected] of [["D04", "44.999999999999999999", "below"], ["D05", "70.000000000000000001", "above"]]) {
  test(`${id}: tiny exact difference across fixed boundary is not rounded away`, () => {
    assert.equal(run([["2041-05-10", raw]]).weight[0].fixedRange, expected);
  });
}
test("subnormal valid points with a difference below Number.MIN_VALUE do not throw or create rapid change", () => {
  const point = run([["2041-05-01", "5e-324"], ["2041-05-02", "5.1e-324"]]).weight[1];
  assert.notEqual(point.comparison.difference, "0"); assert.equal(Number(point.comparison.difference), 0);
  assert.equal(point.rapidChange, false); assert.equal(point.fixedRange, "below");
});

test("C01/C02/C03: structured reasons coexist, never double-count a point", () => {
  assert.deepEqual(run([["2041-05-10", "71"]]).weight[0].reasons.map((item) => item.code), ["fixed-above"]);
  assert.deepEqual(run([["2041-05-09", "56"], ["2041-05-10", "59"]]).weight[1].reasons.map((item) => item.code), ["rapid-change"]);
  const result = run([["2041-05-09", "60"], ["2041-05-10", "71"]]);
  assert.deepEqual(result.weight[1].reasons.map((item) => item.code), ["fixed-above", "rapid-change"]);
  assert.equal(result.counts.weight.totalAttention, 1);
  assert.deepEqual(result.weight[1].reasons[1], { code: "rapid-change", previousDate: "2041-05-09", previousRaw: "60",
    previousValue: "60", days: 1, difference: "11", absoluteDifference: "11", threshold: "3", compareDays: 10, unit: "kg" });
});
test("C04/C05/C06/C07: zero, one and multiple points are counted independently by field", () => {
  assert.equal(run([]).counts.weight.totalAttention, 0);
  const result = attention.evaluateAttention({ "2041-05-10": day({ weight: "71", bodyFat: "31" }),
    "2041-05-11": day({ weight: "75", bodyFat: "34" }) }, defaults);
  assert.equal(result.counts.weight.totalAttention, 2); assert.equal(result.counts.bodyFat.totalAttention, 2);
  assert.equal(result.weight[1].reasons.length, 2);
});
test("C08/C09: inclusive ranges affect counts, not reasons, comparison history or measured point count", () => {
  const rows = [["2041-05-01", "71"], ["2041-05-02", "75"], ["2041-05-03", "76"]];
  const all = run(rows), visible = run(rows, {}, { start: "2041-05-02", end: "2041-05-03" });
  assert.equal(all.counts.weight.totalAttention, 3); assert.equal(visible.counts.weight.totalAttention, 2);
  assert.equal(visible.weight.length, all.weight.length);
  assert.deepEqual(visible.weight.map((point) => point.reasons), all.weight.map((point) => point.reasons));
  assert.equal(run(rows, {}, { start: "2041-06-01", end: "2041-06-30" }).counts.weight.totalAttention, 0);
  assert.equal(run(rows, {}, null).counts.weight.totalAttention, 0);
  assert.equal(run(rows, {}, null).weight.length, 3);
});
test("counts do not claim an unconfirmed count when acknowledgement states were not provided", () => {
  const result = run([["2041-05-10", "71"]]);
  assert.deepEqual(result.counts.weight, { totalAttention: 1, unconfirmedAttention: null, acknowledgementStatus: "not-provided" });
  assert.deepEqual(attention.summarizeAttention(result, null).weight, { totalAttention: 1, unconfirmedAttention: null, acknowledgementStatus: "unknown" });
  assert.equal(attention.summarizeAttention(result, []).weight.unconfirmedAttention, null);
});
test("resolved in-memory acknowledgement statuses exclude confirmed points without changing reasons", () => {
  const result = run([["2041-05-10", "71"], ["2041-05-11", "75"]]), before = JSON.stringify(result);
  const states = freeze([state(result.weight[0], "confirmed"), state(result.weight[1], "unconfirmed")]);
  assert.deepEqual(attention.summarizeAttention(result, states).weight, { totalAttention: 2, unconfirmedAttention: 1, acknowledgementStatus: "known" });
  assert.equal(JSON.stringify(result), before);
  assert.equal(attention.summarizeAttention(result, result.weight.map((point) => state(point, "confirmed"))).weight.unconfirmedAttention, 0);
});
test("one missing or unknown status keeps the unconfirmed total indeterminate", () => {
  const result = run([["2041-05-10", "71"], ["2041-05-11", "75"]]);
  for (const states of [[state(result.weight[0], "unconfirmed")], [state(result.weight[0], "confirmed"), state(result.weight[1], "unknown")]]) {
    assert.equal(attention.summarizeAttention(result, states).weight.unconfirmedAttention, null);
    assert.equal(attention.summarizeAttention(result, states).weight.acknowledgementStatus, "unknown");
  }
});
test("wrong date, field or value cannot apply a confirmed status to another point", () => {
  const result = run([["2041-05-10", "71"]]), base = state(result.weight[0], "confirmed");
  for (const changed of [{ date: "2041-05-11" }, { field: "bodyFat" }, { value: "72" }]) {
    assert.equal(attention.summarizeAttention(result, [{ ...base, ...changed }]).weight.unconfirmedAttention, null);
  }
});
test("same-day fields and visible periods have independent acknowledgement counts", () => {
  const result = attention.evaluateAttention({ "2041-05-09": day({ weight: "71" }), "2041-05-10": day({ weight: "75", bodyFat: "31" }) },
    defaults, { start: "2041-05-10", end: "2041-05-10" });
  const counts = attention.summarizeAttention(result, [state(result.weight[1], "confirmed"), state(result.bodyFat[0], "unconfirmed")]);
  assert.equal(counts.weight.unconfirmedAttention, 0); assert.equal(counts.bodyFat.unconfirmedAttention, 1);
  assert.equal(attention.summarizeAttention(run([]), []).weight.unconfirmedAttention, 0);
});
test("settings changes do not change point identity or consume a persisted acknowledgement format", () => {
  const rows = [["2041-05-10", "71"]], original = run(rows), changed = run(rows, { weightMax: 80 });
  assert.deepEqual(original.weight[0].identity, changed.weight[0].identity);
  assert.equal(changed.weight[0].isAttention, false);
  const resolved = [state(original.weight[0], "confirmed")];
  assert.equal(attention.summarizeAttention(changed, resolved).weight.unconfirmedAttention, 0);
  assert.equal(attention.summarizeAttention(original, resolved).weight.unconfirmedAttention, 0);
  assert.throws(() => attention.summarizeAttention(original, { schemaVersion: 1, points: {} }));
});
test("malformed and duplicate acknowledgement inputs fail explicitly instead of guessing", () => {
  const result = run([["2041-05-10", "71"]]), valid = state(result.weight[0], "confirmed");
  for (const states of [[null], [{ ...valid, status: true }], [{ ...valid, field: "basal" }],
    [{ ...valid, date: "2041-02-29" }], [{ ...valid, value: "71.0" }], [{ ...valid, value: 71 }], [valid, valid]]) {
    assert.throws(() => attention.summarizeAttention(result, states));
  }
  assert.throws(() => attention.summarizeAttention(null, []));
});

for (const key of Object.keys(defaults)) {
  for (const invalid of [0, Infinity, "3", undefined]) test(`reject invalid supplied setting ${key}=${String(invalid)}`, () => {
    assert.throws(() => run([], { [key]: invalid }));
  });
}
for (const changed of [{ compareDays: 366 }, { compareDays: 1.5 }, { weightChange: 3.01 }, { weightMin: 45.01 },
  { bodyFatMax: 30.01 }, { weightMin: 71 }, { bodyFatMin: 31 }, { extra: 1 }, { bodyFatChange: -1 }]) {
  test(`reject out-of-domain settings ${JSON.stringify(changed)}`, () => assert.throws(() => run([], changed)));
}
test("missing settings are not silently replaced by defaults", () => {
  for (const value of [undefined, null, {}, [], { ...defaults, compareDays: NaN }]) assert.throws(() => attention.evaluateAttention({}, value));
});
test("invalid record roots, dates and display ranges fail explicitly", () => {
  for (const value of [null, [], "records", 0]) assert.throws(() => attention.evaluateAttention(value, defaults));
  for (const date of ["2041-02-29", "2040-02-30", "2041-5-10", "0000-01-01"]) assert.throws(() => run([[date, "56"]]));
  for (const range of [[], "range", {}, { start: "2041-05-12", end: "2041-05-10" }, { start: "2041-02-29", end: "2041-03-01" }]) assert.throws(() => run([], {}, range));
});
test("C10/D08: frozen input, settings, ranges and original strings remain unchanged and deterministic", () => {
  const input = freeze({ "2041-05-11": day({ weight: "071.000", bodyFat: "31.00", extra: { fictional: true } }),
    "2041-05-01": day({ weight: "+5.6e1", bodyFat: "16.000" }) });
  const range = freeze({ start: "2041-05-01", end: "2041-05-11" }), before = JSON.stringify(input);
  const first = attention.evaluateAttention(input, defaults, range), second = attention.evaluateAttention(input, defaults, range);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(input), before);
  assert.equal(Object.keys(input["2041-05-01"]).length, 13);
  assert.deepEqual(first.weight.map((point) => point.date), ["2041-05-01", "2041-05-11"]);
  assert.equal(first.weight[1].raw, "071.000"); assert.equal(first.weight[1].decimal, "71");
  first.range.start = "2041-05-02"; first.weight[1].identity.value = "changed";
  assert.equal(range.start, "2041-05-01"); assert.equal(second.weight[1].identity.value, "71");
  assert.equal(first.weight.length, 2); assert.equal(first.weight[1].isAttention, true);
});
test("attention calculation does not alter any existing graph points, coordinates, targets or summaries", () => {
  const input = freeze(records([["2041-05-01", "60"], ["2041-05-02", "71"]]));
  const points = freeze(graph.extractMeasurements(input).weight), range = { start: "2041-05-01", end: "2041-05-02" };
  const chart = () => graph.buildChartData(points, range, { min: 56, max: 56.9 }, { field: "weight", width: 250, height: 180 });
  const before = chart(), result = attention.evaluateAttention(input, defaults, range);
  assert.equal(result.weight.length, 2); assert.deepEqual(chart(), before);
});
test("CommonJS loads only BodyGraph and never reads storage, DOM, navigator, network or clock", () => {
  const context = { module: { exports: {} }, require(name) { assert.equal(name, "./body-graph.js"); return graph; } };
  for (const key of ["localStorage", "sessionStorage", "document", "window", "navigator", "fetch", "Date"]) {
    Object.defineProperty(context, key, { get() { assert.fail(`unexpected access: ${key}`); } });
  }
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, "../measurement-attention.js"), "utf8"), context);
  const result = context.module.exports.evaluateAttention(records([["2041-05-10", "71"]]), defaults);
  assert.equal(result.counts.weight.totalAttention, 1); assert.equal(result.counts.weight.unconfirmedAttention, null);
});
test("browser global export works without app startup or side effects", () => {
  const context = {};
  for (const key of ["localStorage", "document", "window", "navigator", "fetch", "Date"]) Object.defineProperty(context, key, { get() { assert.fail(key); } });
  vm.createContext(context);
  for (const file of ["body-graph.js", "measurement-attention.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  assert.equal(typeof context.MeasurementAttention.evaluateAttention, "function");
  assert.equal(context.MeasurementAttention.evaluateAttention(records([["2041-05-10", "71"]]), defaults).weight[0].isAttention, true);
});
