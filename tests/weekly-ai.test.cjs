"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const model = require("../weekly-ai.js"), transfer = require("../record-transfer.js"), save = require("../record-save.js"), calendar = require("../body-graph.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const W = "2041-01-07", entry = (score = 80, comment = "") => ({ score, comment });
function fixture(records = {}, ai = {}) {
  const map = new Map([[save.KEY, JSON.stringify(records)], [transfer.AI_KEY, JSON.stringify(ai)], ["settings-preserve", "unchanged"]]);
  const storage = { map, writes: [], getItem: key => map.get(key) ?? null, setItem(key, value) { this.writes.push(key); map.set(key, value); }, removeItem: key => map.delete(key) };
  const store = save.createStore({ storage, transfer, locks: createLocks(), isSecureContext: true });
  return { storage, store };
}
test("TSV accepts one or many two/three-column rows, blanks, zero and exact optional comments including a fictional 23-week batch", () => {
  const lines = Array.from({ length: 23 }, (_, i) => `${calendar.addDays(W, i * 7)}\t${i === 0 ? 0 : 70 + i}${i < 12 ? "\t  架空の総評。  " : ""}`);
  const parsed = model.parseTSV("\n" + lines.join("\r\n") + "\n");
  assert.deepEqual(parsed.errors, []); assert.equal(Object.keys(parsed.evaluations).length, 23);
  assert.equal(parsed.evaluations[W].score, 0); assert.equal(parsed.evaluations[W].comment, "  架空の総評。  ");
  assert.equal(Object.values(parsed.evaluations).filter(e => e.comment !== "").length, 12);
  assert.equal(model.parseTSV(`${W}\t100`).evaluations[W].comment, "");
});
test("TSV reports physical line numbers and rejects invalid days, scores, duplicates, extra columns and extreme input", () => {
  for (const line of ["2041-01-08\t80", "2041-02-30\t80", `${W}\t`, `${W}\t1.5`, `${W}\t101`, `${W}\t-1`, `${W}\t80\ta\tb`, `${W}\t80\t${"a".repeat(10001)}`]) {
    const result = model.parseTSV("\n" + line); assert.equal(result.errors[0].line, 2); assert.ok(result.errors[0].reason);
  }
  assert.equal(model.parseTSV(`${W}\t80\n${W}\t90`).errors[0].line, 2);
  assert.ok(model.parseTSV("x".repeat(1000001)).errors.length); assert.ok(model.parseTSV(" \n").errors.length);
});
test("weekly averages use the current plus three calendar weeks without filling gaps, and both lines connect across long gaps", () => {
  const values = { [W]: entry(40), "2041-01-14": entry(0), "2041-01-21": entry(100), "2041-01-28": entry(50), "2041-02-04": entry(90), "2041-03-11": entry(80), "2041-03-18": entry(100) };
  const before = JSON.stringify(values), data = model.chartData(values);
  assert.equal(data.points.length, 7); assert.equal(data.averageSegments[0][0].value, 40);
  assert.equal(data.averageSegments[0][1].value, 20); assert.equal(data.averageSegments[0][4].value, 60);
  assert.deepEqual(data.segments.map(s => s.length), [7]); assert.deepEqual(data.averageSegments.map(s => s.length), [7]);
  assert.equal(data.averageSegments[0][5].value, 80); assert.equal(data.averageSegments[0][6].value, 90);
  assert.deepEqual(data.points.map(p => p.date), Object.keys(values));
  assert.deepEqual(data.points.map(p => p.value), Object.values(values).map(e => e.score));
  assert.equal(data.points[5].day - data.points[4].day, 35);
  assert.equal(JSON.stringify(values), before); assert.equal(model.chartData({ [W]: entry(0) }).points.length, 1); assert.equal(model.chartData({}).points.length, 0);
});
test("AI imports are independent of daily records, default to keep, require explicit overwrite and verify a single write", async () => {
  const f = fixture({}, { [W]: entry(80, "original") }), daily = f.storage.getItem(save.KEY);
  const incoming = { [W]: entry(90, "corrected"), "2041-01-14": entry(70) }, plan = transfer.createEvaluationPlan(f.storage.getItem(transfer.AI_KEY), incoming);
  const kept = await f.store.commitEvaluations(plan, {}, { finalConfirmed: true });
  assert.equal(kept.records[W].score, 80); assert.equal(kept.counts.added, 1); assert.equal(f.storage.getItem(save.KEY), daily);
  const next = transfer.createEvaluationPlan(f.storage.getItem(transfer.AI_KEY), incoming);
  await assert.rejects(f.store.commitEvaluations(next, { [W]: "replace" }, { finalConfirmed: true }), { code: "CONFIRMATION" });
  await f.store.commitEvaluations(next, { [W]: "replace" }, { finalConfirmed: true, overwriteConfirmed: true });
  assert.equal(transfer.readEvaluations(f.storage.getItem(transfer.AI_KEY))[W].score, 90);
  assert.deepEqual(f.storage.writes, [transfer.AI_KEY, transfer.AI_KEY]); assert.equal(f.storage.getItem("settings-preserve"), "unchanged");
});
test("stale AI previews, denied writes and readback failures never report success or write daily records", async () => {
  for (const mode of ["stale", "write", "verify"]) {
    const f = fixture({}, { [W]: entry() }), raw = f.storage.getItem(transfer.AI_KEY), plan = transfer.createEvaluationPlan(raw, { "2041-01-14": entry() });
    if (mode === "stale") f.storage.map.set(transfer.AI_KEY, "{}");
    if (mode === "write") f.storage.setItem = () => { throw Error("quota"); };
    if (mode === "verify") f.storage.setItem = function (key) { this.writes.push(key); };
    await assert.rejects(f.store.commitEvaluations(plan, {}, { finalConfirmed: true }), { code: mode === "stale" ? "STALE" : mode === "write" ? "WRITE_FAILED" : "VERIFY_FAILED" });
    assert.equal(f.storage.getItem(save.KEY), "{}"); if (mode === "write") assert.equal(f.storage.getItem(transfer.AI_KEY), raw);
  }
});
test("v2 backups validate AI data while v1 remains compatible and rejects unknown fields and duplicate weeks", () => {
  const backup = { format: "exercise-record-backup", formatVersion: 2, exportedAt: "2041-05-13T00:00:00.000Z", records: {}, weeklyAI: { [W]: entry(0, "kept") } };
  assert.deepEqual(transfer.parseBackup(JSON.stringify(backup)).weeklyAI, backup.weeklyAI);
  const old = { ...backup, formatVersion: 1 }; delete old.weeklyAI; assert.equal(transfer.parseBackup(JSON.stringify(old)).weeklyAI, undefined);
  for (const e of [{ score: 101, comment: "" }, { score: 80.5, comment: "" }, { score: 80, comment: null }, { score: 80, comment: "", unknown: true }]) assert.throws(() => transfer.parseBackup(JSON.stringify({ ...backup, weeklyAI: { [W]: e } })));
  assert.throws(() => transfer.readEvaluations(`{"${W}":{"score":1,"score":2,"comment":""}}`));
});
test("combined restore preserves unrelated dates and AI, and a legacy restore never alters AI", async () => {
  const original = { "2041-01-01": { weight: "56" } }, f = fixture(original, { [W]: entry(80) });
  const plan = transfer.createPlan(f.storage.getItem(save.KEY), { "2041-01-02": { bodyFat: "16" } });
  plan.evaluations = transfer.createEvaluationPlan(f.storage.getItem(transfer.AI_KEY), { [W]: entry(90), "2041-01-14": entry(70) });
  const result = await f.store.commitImport(plan, {}, { backupConfirmed: true, finalConfirmed: true });
  assert.equal(result.outcome, "verified"); assert.deepEqual(JSON.parse(f.storage.getItem(save.KEY)), { ...original, "2041-01-02": { bodyFat: "16" } });
  assert.equal(transfer.readEvaluations(f.storage.getItem(transfer.AI_KEY))[W].score, 80); assert.equal(result.evaluationCounts.added, 1);
  const aiBefore = f.storage.getItem(transfer.AI_KEY), legacy = transfer.createPlan(f.storage.getItem(save.KEY), { "2041-01-03": {} });
  await f.store.commitImport(legacy, {}, { backupConfirmed: true, finalConfirmed: true }); assert.equal(f.storage.getItem(transfer.AI_KEY), aiBefore);
});
test("failure during the second restore write rolls back and verifies both maps, including an originally absent key", async () => {
  for (const absent of [false, true]) {
    const f = fixture({ "2041-01-01": {} }, { [W]: entry() }); if (absent) f.storage.map.delete(transfer.AI_KEY);
    const before = [...f.storage.map], plan = transfer.createPlan(f.storage.getItem(save.KEY), { "2041-01-02": {} });
    plan.evaluations = transfer.createEvaluationPlan(f.storage.getItem(transfer.AI_KEY), { "2041-01-14": entry() });
    const write = f.storage.setItem; let failed = false;
    f.storage.setItem = function (key, value) { if (key === transfer.AI_KEY && !failed) { failed = true; throw Error("quota"); } return write.call(this, key, value); };
    await assert.rejects(f.store.commitImport(plan, {}, { backupConfirmed: true, finalConfirmed: true }), { code: "RESTORE_FAILED", outcome: "not-written" });
    assert.deepEqual([...f.storage.map], before);
  }
});

test("restore rollback preserves an unexpected concurrent value and reports an uncertain result", async () => {
  const f = fixture({ "2041-01-01": {} }, { [W]: entry(80) });
  const plan = transfer.createPlan(f.storage.getItem(save.KEY), { "2041-01-02": {} });
  plan.evaluations = transfer.createEvaluationPlan(f.storage.getItem(transfer.AI_KEY), { "2041-01-14": entry() });
  const external = JSON.stringify({ [W]: entry(99, "external") }), before = f.storage.getItem(save.KEY), write = f.storage.setItem;
  f.storage.setItem = function (key, value) {
    if (key === transfer.AI_KEY) { this.map.set(key, external); throw Error("unexpected writer"); }
    return write.call(this, key, value);
  };
  await assert.rejects(f.store.commitImport(plan, {}, { backupConfirmed: true, finalConfirmed: true }), { code: "VERIFY_FAILED", outcome: "unknown" });
  assert.equal(f.storage.getItem(transfer.AI_KEY), external); assert.equal(f.storage.getItem(save.KEY), before);
});
