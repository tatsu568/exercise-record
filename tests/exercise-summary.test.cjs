"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const model = require("../exercise-summary.js"), calendar = require("../body-graph.js"), transfer = require("../record-transfer.js");
const range = { start: "2041-04-15", end: "2041-05-12" };
const day = (values = {}) => ({ ...transfer.DEFAULT_ENTRY, ...values });

test("goals use four weekly totals, exact decimal differences and uncapped integer achievement rates", () => {
  for (const field of ["squat", "march", "plank", "walkSteps", "distance"]) {
    for (const [actual, rate, achieved, difference] of [["310", "97", false, "-10"], ["319", "99", false, "-1"], ["320", "100", true, "0"], ["400", "125", true, "80"]]) {
      assert.deepEqual(model.goalProgress(field, { value: actual, count: 1 }, 80), { status: "ready", target: "320", rate, achieved, difference });
    }
  }
  assert.equal(model.goalProgress("distance", { value: "0.3", count: 1 }, .1).difference, "-0.1");
  assert.equal(model.goalProgress("distance", { value: "0.3", count: 1 }, .1).rate, "75");
});

test("standing goals compare the unrounded recorded-day average directly, not four times the goal", () => {
  for (const [average, rate, achieved, difference] of [[14.5, "97", false, "-0.5"], [15, "100", true, "0"], [15.5, "103", true, "0.5"]]) {
    assert.deepEqual(model.goalProgress("standing", { count: 2, value: String(average), average }, 15), { status: "ready", target: "15", rate, achieved, difference });
  }
  const near = model.goalProgress("standing", { count: 3, value: "15", average: 14.9999 }, 15);
  assert.equal(near.achieved, false); assert.equal(near.rate, "99"); assert.notEqual(near.difference, "0");
});

test("missing goals and missing records never become a false zero or achievement", () => {
  for (const goal of [undefined, null, 0, -1, NaN, Infinity, "80"]) assert.deepEqual(model.goalProgress("squat", { count: 1, value: "100" }, goal), { status: "unset" });
  assert.deepEqual(model.goalProgress("squat", { count: 0, value: null }, 80), { status: "no-data", target: "320" });
  const zero = model.goalProgress("squat", { count: 1, value: "0" }, 80); assert.equal(zero.rate, "0"); assert.equal(zero.achieved, false);
});

for (const [today, start, end] of [
  ["2026-10-27", "2026-09-28", "2026-10-25"],
  ["2041-01-01", "2040-12-03", "2040-12-30"],
  ["2041-01-06", "2040-12-03", "2040-12-30"],
  ["2041-01-07", "2040-12-10", "2041-01-06"],
  ["2040-03-05", "2040-02-06", "2040-03-04"]
]) test(`completed Monday-Sunday weeks for ${today}`, () => {
  assert.deepEqual(model.latestPeriod(today), { start, end });
  assert.equal(calendar.daysBetween(start, end), 27); assert.equal(calendar.parseDate(start).ordinal % 7, 0);
});

test("period moves by 28 days across years, cannot pass the latest period, and works without records", () => {
  const latest = model.latestPeriod("2041-01-07"), previous = model.movePeriod(latest, -1, latest);
  assert.deepEqual(previous, { start: "2040-11-12", end: "2040-12-09" });
  assert.deepEqual(model.movePeriod(previous, 1, latest), latest); assert.equal(model.movePeriod(latest, 1, latest), null);
  assert.equal(model.buildSummary({}, previous).current.savedDays, 0);
  assert.throws(() => model.movePeriod(latest, 2, latest), RangeError);
  assert.throws(() => model.buildSummary({}, { start: "2041-04-16", end: "2041-05-13" }), RangeError);
});

test("six metrics use their own valid-day counts and include both endpoints", () => {
  const records = {
    "2041-04-14": day({ squat: 100 }), "2041-04-15": day({ squat: 15, march: 1, plank: 60, standing: 12, walkSteps: "1200", distance: "1.2" }),
    "2041-05-12": day({ squat: 20, march: 2, plank: 30, standing: 18, walkSteps: "2300", distance: "2.3" }), "2041-05-13": day({ squat: 100 })
  };
  const result = model.aggregate(records, range);
  assert.equal(result.savedDays, 2);
  for (const [field, value] of Object.entries({ squat: "35", march: "3", plank: "90", standing: "15", walkSteps: "3500", distance: "3.5" })) {
    assert.equal(result.metrics[field].value, value); assert.equal(result.metrics[field].count, 2);
  }
});

test("performed days count each positive valid day once, without changing valid counts, totals, standing averages or goal judging", () => {
  const positive = { squat: 50, march: 2, plank: 120, standing: 10, walkSteps: "123", distance: "0.25" };
  const records = {
    "2041-04-14": positive,
    "2041-04-15": positive,
    "2041-04-16": { squat: 0, march: 0, plank: 0, standing: 20, walkSteps: "0", distance: "0" },
    "2041-04-17": { squat: "", march: "", plank: "", standing: "", walkSteps: "", distance: "" },
    "2041-04-18": { squat: 3, march: -1, plank: 31, standing: 0, walkSteps: "1.5", distance: "-1" },
    "2041-04-19": {},
    "2041-04-20": { squat: 5, march: 1, plank: 30, standing: 15, walkSteps: "1", distance: "0.0001" },
    "2041-05-12": { squat: 0, march: 0, plank: 0, standing: 20, walkSteps: "0", distance: "1e-3" }
  };
  const before = JSON.stringify(records), result = model.buildSummary(records, range), metrics = result.current.metrics;
  assert.equal(result.current.savedDays, 7);
  for (const [field, total, days] of [["squat", "55", 2], ["march", "3", 2], ["plank", "150", 2], ["walkSteps", "124", 2], ["distance", "0.2511", 3]]) {
    assert.equal(metrics[field].performedDays, days); assert.equal(metrics[field].count, 4); assert.equal(metrics[field].value, total);
    assert.deepEqual(model.goalProgress(field, metrics[field], 80), model.goalProgress(field, { count: 4, value: total }, 80));
  }
  assert.equal(metrics.standing.performedDays, null); assert.equal(metrics.standing.count, 4); assert.equal(metrics.standing.value, "16.25");
  assert.deepEqual(model.goalProgress("standing", metrics.standing, 15), { status: "ready", target: "15", achieved: true, rate: "108", difference: "1.25" });
  assert.deepEqual(result.weeks.map(week => week.metrics.squat.value), ["55", null, null, "0"]);
  assert.equal(result.previous.metrics.squat.performedDays, 1); assert.equal(JSON.stringify(records), before);
});

test("absent days and absent/empty fields never receive defaults; saved zero differs from no data", () => {
  const empty = model.aggregate({}, range);
  assert.equal(empty.savedDays, 0); assert(Object.values(empty.metrics).every(item => item.value === null && item.count === 0));
  const result = model.aggregate({ "2041-04-15": {}, "2041-04-16": { squat: 0, distance: "0", walkSteps: "0" },
    "2041-04-17": { standing: 10, distance: "", walkSteps: "" } }, range);
  assert.equal(result.savedDays, 3);
  for (const field of ["squat", "distance", "walkSteps"]) { assert.equal(result.metrics[field].value, "0"); assert.equal(result.metrics[field].count, 1); }
  assert.equal(result.metrics.standing.value, "10"); assert.equal(result.metrics.standing.count, 1);
  assert.equal(result.metrics.plank.value, null);
});

test("invalid types, ranges and units are excluded independently without discarding valid fields", () => {
  const result = model.aggregate({ "2041-04-15": { squat: 3, march: 3, plank: -30, standing: 0, walkSteps: "1.5", distance: "-1" },
    "2041-04-16": { squat: "15", march: null, plank: 31, standing: "10", walkSteps: 1000, distance: "NaN" },
    "2041-04-17": { work: "bad", squat: 5, distance: "0.2" }, "2041-04-18": null }, range);
  assert.equal(result.savedDays, 4); assert.equal(result.metrics.squat.value, "5"); assert.equal(result.metrics.distance.value, "0.2");
  assert.equal(result.metrics.squat.invalid, 3); assert.equal(result.metrics.standing.value, null); assert.equal(result.metrics.walkSteps.value, null);
});

test("distance decimal totals and signed comparisons avoid floating point artifacts", () => {
  const records = { "2041-04-15": { distance: "0.1" }, "2041-04-16": { distance: "0.2" },
    "2041-04-17": { distance: "1e-2" }, "2041-03-18": { distance: "0.5" } };
  const result = model.buildSummary(records, range);
  assert.equal(result.current.metrics.distance.value, "0.31");
  assert.deepEqual(result.comparisons.distance, { change: "-0.19", direction: "decrease" });
});

test("standing averages use only valid days, include persisted default 10 and round presentation only", () => {
  const result = model.buildSummary({ "2041-04-15": day(), "2041-04-16": { standing: 11 }, "2041-04-17": { standing: 11 },
    "2041-04-18": {}, "2041-03-18": { standing: 9 }, "2041-03-19": { standing: 10 } }, range);
  assert.equal(result.current.metrics.standing.value, "10.67"); assert.equal(result.current.metrics.standing.count, 3);
  assert.equal(result.current.metrics.standing.average, 32 / 3); assert.equal(result.comparisons.standing.change, "1.17");
});

test("comparisons distinguish increase, decrease, no change and either side without data", () => {
  const result = model.buildSummary({ "2041-03-18": day({ squat: 10, plank: 60, march: 1, walkSteps: "0" }),
    "2041-04-15": day({ squat: 15, plank: 30, march: 1, distance: "0" }) }, range);
  for (const [field, change, direction] of [["squat", "5", "increase"], ["plank", "-30", "decrease"], ["march", "0", "same"],
    ["walkSteps", null, "unavailable"], ["distance", null, "unavailable"]]) assert.deepEqual(result.comparisons[field], { change, direction });
  assert.deepEqual(result.previous.range, { start: "2041-03-18", end: "2041-04-14" });
});

test("four week bins have Monday-Sunday boundaries, weekly sums, missing weeks and real zeros", () => {
  const result = model.buildSummary({ "2041-04-15": { squat: 5, standing: 10 }, "2041-04-21": { squat: 10, standing: 12 },
    "2041-04-22": { squat: 0, standing: 15 }, "2041-05-12": { squat: 30, standing: 20 } }, range);
  assert.deepEqual(result.weeks.map(w => [w.start, w.end, w.metrics.squat.value, w.metrics.standing.value]), [
    ["2041-04-15", "2041-04-21", "15", "11"], ["2041-04-22", "2041-04-28", "0", "15"],
    ["2041-04-29", "2041-05-05", null, null], ["2041-05-06", "2041-05-12", "30", "20"]
  ]);
});

test("aggregation never changes its input, counts saved default records, and rejects invalid maps/dates", () => {
  const entry = Object.freeze(day()), records = Object.freeze({ "2041-04-15": entry });
  assert.equal(model.buildSummary(records, range).current.savedDays, 1); assert.equal(entry.standing, 10);
  assert.throws(() => model.aggregate(null, range)); assert.throws(() => model.aggregate({ "2041-02-29": {} }, range));
});
