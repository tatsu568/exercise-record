"use strict";
const RecordSave = require("../record-save.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const transfer = require("../record-transfer.js");
const KEY = "exercise-record.entries.v1";
function commit(storage, key, plan, choices, confirmation) {
  const store = RecordSave.createStore({ storage, key, transfer, locks: createLocks(), isSecureContext: true });
  return transfer.commitRecords(storage, key, plan, choices, confirmation, { store });
}
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const text = (records, extra = {}) => JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-03-01T01:02:03.000Z", records, ...extra });
const confirmed = { backupConfirmed: true, finalConfirmed: true };
function storage(raw, failWrite = false) {
  return {
    raw, writes: 0,
    getItem(key) { assert.equal(key, KEY); return this.raw; },
    setItem(key, value) { assert.equal(key, KEY); this.writes++; if (failWrite) throw new Error("quota"); this.raw = value; },
    removeItem() { assert.fail("must never remove existing storage"); }
  };
}

test("empty and multi-day backups keep all types, empty strings, explicit zero, and partial fields", () => {
  assert.deepEqual(transfer.parseBackup(text({})).records, {});
  const records = { "2032-02-28": day({ kids: true, squat: 10, distance: "0", weight: "0" }), "2032-02-29": { bodyFat: "0.0" } };
  assert.deepEqual(transfer.parseBackup(text(records)).records, records);
  assert.deepEqual(transfer.parseBackup("\uFEFF" + text(records)).records, records);
});

test("new dates are added without generating missing dates or losing existing records", () => {
  const original = { "2032-02-27": day({ walkSteps: "321" }) };
  const plan = transfer.createPlan(JSON.stringify(original), { "2032-02-29": day({ weight: "51.2" }) });
  const candidate = transfer.buildCandidate(plan);
  assert.deepEqual(Object.keys(candidate.records).sort(), ["2032-02-27", "2032-02-29"]);
  assert.deepEqual(candidate.records["2032-02-27"], original["2032-02-27"]);
  assert.deepEqual(candidate.counts, { added: 1, replaced: 0, skipped: 0, same: 0, before: 1, after: 2 });
});

test("comparison uses defaults only for missing known fields and ignores object key order", () => {
  const plan = transfer.createPlan(JSON.stringify({ "2032-02-28": { weight: "0", extra: { a: 1, b: 2 } } }), { "2032-02-28": day({ extra: { b: 2, a: 1 }, weight: "0" }) });
  assert.equal(plan.rows[0].kind, "same");
  const candidate = transfer.buildCandidate(plan);
  assert.equal(Object.hasOwn(candidate.records["2032-02-28"], "standing"), false);
  assert.equal(candidate.counts.same, 1);
});

test("conflicts and possible default-only records keep existing values by default", () => {
  const original = { "2032-02-27": day({ weight: "52" }), "2032-02-28": {} };
  const plan = transfer.createPlan(JSON.stringify(original), { "2032-02-27": day({ weight: "53" }), "2032-02-28": day({ squat: 5 }) });
  assert.equal(plan.rows.filter((row) => row.kind === "conflict").length, 2);
  assert.equal(plan.rows[1].defaultOnly, true);
  assert.deepEqual(transfer.buildCandidate(plan).records, original);
});

test("only explicitly selected conflict dates are replaced, with no field merge", () => {
  const original = { "2032-02-27": day({ weight: "52", basal: "1200" }), "2032-02-28": day({ weight: "53" }) };
  const incoming = { "2032-02-27": { weight: "0" }, "2032-02-28": day({ weight: "54" }) };
  const plan = transfer.createPlan(JSON.stringify(original), incoming);
  const candidate = transfer.buildCandidate(plan, { "2032-02-27": "replace" });
  assert.deepEqual(candidate.records["2032-02-27"], { weight: "0" });
  assert.deepEqual(candidate.records["2032-02-28"], original["2032-02-28"]);
  assert.equal(candidate.counts.replaced, 1);
  assert.equal(candidate.counts.skipped, 1);
  assert.deepEqual(original["2032-02-27"], day({ weight: "52", basal: "1200" }));
});

test("blank and string zero conflict; numeric zero is not a valid body string", () => {
  const plan = transfer.createPlan(JSON.stringify({ "2032-02-28": day() }), { "2032-02-28": day({ distance: "0", weight: "0" }) });
  assert.deepEqual(plan.rows[0].differences.map((diff) => diff.field), ["distance", "weight"]);
  assert.throws(() => transfer.parseBackup(text({ "2032-02-28": { weight: 0 } })));
});

test("unknown daily fields are warned about and preserved, including nested objects", async () => {
  const record = JSON.parse('{"weight":"0","extra":{"nested":[null,0,"0"]},"__proto__":{"safe":true}}');
  const backup = transfer.parseBackup(text({ "2032-02-28": record }));
  assert.ok(backup.warnings.some((warning) => warning.includes("未知")));
  const candidate = transfer.buildCandidate(transfer.createPlan(null, backup.records));
  assert.deepEqual(candidate.records["2032-02-28"], record);
  assert.equal({}.safe, undefined);
});

test("invalid backup input stops the whole import", async (t) => {
  const invalid = [
    ["syntax", "{broken"], ["wrong format", text({}, { format: "other" })],
    ["unsupported version", text({}, { formatVersion: 2 })], ["array records", text([])],
    ["nonexistent date", text({ "2031-02-29": day() })], ["non-ISO date", text({ "2032/2/29": day() })],
    ["null record", text({ "2032-02-28": null })], ["wrong bool type", text({ "2032-02-28": { kids: 1 } })],
    ["wrong exercise unit", text({ "2032-02-28": day({ squat: 3 }) })], ["negative body value", text({ "2032-02-28": { weight: "-1" } })],
    ["invalid string number", text({ "2032-02-28": { distance: "NaN" } })], ["seconds range", text({ "2032-02-28": { walkSeconds: "60" } })],
    ["fractional steps", text({ "2032-02-28": { walkSteps: "1.5" } })], ["unknown envelope", text({}, { extra: 1 })],
    ["invalid timestamp", text({}, { exportedAt: "2032-02-30T00:00:00.000Z" })],
    ["duplicate fields", text({ "2032-02-28": {} }).replace('"2032-02-28":{}', '"2032-02-28":{"weight":"1","weight":"2"}')],
    ["overflow in unknown field", text({ "2032-02-28": { extra: "OVERFLOW" } }).replace('"OVERFLOW"', "1e999")]
  ];
  for (const [name, source] of invalid) await t.test(name, () => assert.throws(() => transfer.parseBackup(source)));
});

test("read-only preview and cancellation require no storage writes", () => {
  const original = JSON.stringify({ "2032-02-28": day({ weight: "52" }) });
  const mock = storage(original);
  const backup = transfer.parseBackup(text({ "2032-02-29": day() }));
  const plan = transfer.createPlan(mock.getItem(KEY), backup.records);
  transfer.buildCandidate(plan);
  // Discarding the plan represents cancellation; no persistence API is involved.
  assert.equal(mock.writes, 0);
  assert.equal(mock.raw, original);
});

test("pre-backup and final confirmations are both mandatory", async () => {
  const mock = storage(null), plan = transfer.createPlan(null, { "2032-02-28": day() });
  for (const confirmation of [{}, { backupConfirmed: true }, { finalConfirmed: true }, { backupConfirmed: "yes", finalConfirmed: true }]) {
    await assert.rejects(() => commit(mock, KEY, plan, {}, confirmation), { code: "CONFIRMATION" });
  }
  assert.equal(mock.writes, 0);
});

test("single write and exact read-back preserve all values and count", async () => {
  const original = { "2032-02-27": day({ weight: "52" }) };
  const incoming = { "2032-02-28": { distance: "0", weight: "0", unknown: "keep" } };
  const mock = storage(JSON.stringify(original));
  const result = await commit(mock, KEY, transfer.createPlan(mock.raw, incoming), {}, confirmed);
  assert.equal(mock.writes, 1);
  assert.deepEqual(JSON.parse(mock.raw), { ...original, ...incoming });
  assert.equal(result.counts.after, 2);
});

test("empty and identical backups cause no setItem even after confirmation", async () => {
  const records = { "2032-02-28": day() }, raw = JSON.stringify(records);
  for (const incoming of [{}, records]) {
    const mock = storage(raw);
    await commit(mock, KEY, transfer.createPlan(raw, incoming), {}, confirmed);
    assert.equal(mock.writes, 0);
    assert.equal(mock.raw, raw);
  }
});

test("quota/write failure preserves original bytes and does not delete or retry", async () => {
  const original = JSON.stringify({ "2032-02-28": day() }), mock = storage(original, true);
  await assert.rejects(() => commit(mock, KEY, transfer.createPlan(original, { "2032-02-29": day() }), {}, confirmed), { code: "WRITE_FAILED" });
  assert.equal(mock.raw, original);
  assert.equal(mock.writes, 1);
});

test("stale storage is rejected before writing", async () => {
  const mock = storage(null), plan = transfer.createPlan(null, { "2032-02-28": day() });
  const external = JSON.stringify({ "2032-02-27": day({ squat: 15 }) });
  mock.raw = external;
  await assert.rejects(() => commit(mock, KEY, plan, {}, confirmed), { code: "STALE" });
  assert.equal(mock.raw, external);
  assert.equal(mock.writes, 0);
});

test("read-back mismatch is reported and never rolled back over another writer", async () => {
  const mock = storage(null);
  const external = JSON.stringify({ "2032-02-27": day({ squat: 15 }) });
  mock.setItem = function () { this.writes++; this.raw = external; };
  await assert.rejects(() => commit(mock, KEY, transfer.createPlan(null, { "2032-02-28": day() }), {}, confirmed), { code: "VERIFY_FAILED" });
  assert.equal(mock.raw, external);
  assert.equal(mock.writes, 1);
});

test("invalid existing storage and invalid conflict choices are not silently repaired", () => {
  assert.throws(() => transfer.createPlan("{broken", {}));
  const records = { "2032-02-28": day() }, plan = transfer.createPlan(JSON.stringify(records), records);
  assert.throws(() => transfer.buildCandidate(plan, { "2032-02-28": "unknown" }));
});

test("storage read failures before and after writing cannot produce a false success", async () => {
  const plan = transfer.createPlan(null, { "2032-02-28": day() });
  const before = storage(null);
  before.getItem = () => { throw new Error("blocked"); };
  await assert.rejects(() => commit(before, KEY, plan, {}, confirmed));
  assert.equal(before.writes, 0);
  const after = storage(null);
  after.getItem = function () { if (this.writes) throw new Error("blocked"); return this.raw; };
  await assert.rejects(() => commit(after, KEY, plan, {}, confirmed), { code: "VERIFY_FAILED" });
  assert.equal(after.writes, 1);
});

test("unknown prototype-like keys are compared as own data, not inherited properties", () => {
  const incoming = JSON.parse('{"__proto__":{"safe":true},"constructor":"saved"}');
  const diff = transfer.differences({}, incoming);
  assert.equal(diff.find((item) => item.field === "__proto__").existing, undefined);
  assert.equal(diff.find((item) => item.field === "constructor").existing, undefined);
  assert.equal({}.safe, undefined);
});
