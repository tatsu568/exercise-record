"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const api = require("../attention-acknowledgements.js"), recordSave = require("../record-save.js"), transfer = require("../record-transfer.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const DATE = "2041-01-01", NEXT = "2041-01-02";
function fixture(raw = null, options = {}) {
  const storage = { raw, writes: 0, failWrite: false, failRead: false, failVerify: false,
    getItem(key) { assert.equal(key, api.KEY); if (this.failRead || (this.failVerify && this.writes)) throw Error("read denied"); return this.raw; },
    setItem(key, value) { assert.equal(key, api.KEY); if (this.failWrite) throw Error("quota"); this.raw = value; this.writes++; } };
  const locks = createLocks();
  return { storage, locks, store: api.createStore({ storage, locks, isSecureContext: true, ...options }) };
}
test("missing key is readable without initialization; confirmation and manual release persist only date and field", async () => {
  const a = fixture(); assert.deepEqual(a.store.read(), { confirmed: {}, error: "" }); assert.equal(a.storage.writes, 0);
  await a.store.setConfirmed(DATE, "weight", true); await a.store.setConfirmed(DATE, "bodyFat", true);
  await a.store.setConfirmed(NEXT, "weight", true); await a.store.setConfirmed(DATE, "weight", false);
  assert.deepEqual(api.parse(a.storage.raw), { [DATE]: { bodyFat: true }, [NEXT]: { weight: true } });
  assert.deepEqual(api.createStore({ storage: a.storage, locks: a.locks, isSecureContext: true }).read(), a.store.read());
  assert.deepEqual(Object.keys(JSON.parse(a.storage.raw)).sort(), ["confirmed", "schemaVersion"]);
});
test("two instances reread latest confirmation under the shared record lock and retain both changes", async () => {
  const a = fixture(), b = api.createStore({ storage: a.storage, locks: a.locks, isSecureContext: true });
  let release, acquired; const ready = new Promise(r => acquired = r);
  const held = a.locks.request(recordSave.LOCK_NAME, { mode: "exclusive" }, async () => { acquired(); await new Promise(r => release = r); });
  await ready; const p = a.store.setConfirmed(DATE, "weight", true), q = b.setConfirmed(NEXT, "bodyFat", true);
  assert.equal(a.storage.writes, 0); release(); await held; await Promise.all([p,q]);
  assert.deepEqual(a.store.read().confirmed, { [DATE]: { weight: true }, [NEXT]: { bodyFat: true } });
});
for (const raw of ["{broken", "[]", '{"schemaVersion":2,"confirmed":{}}', '{"schemaVersion":1,"confirmed":{"2041-02-29":{"weight":true}}}', '{"schemaVersion":1,"confirmed":{"2041-01-01":{"weight":false}}}', '{"schemaVersion":1,"confirmed":{},"unknown":true}']) {
  test("invalid acknowledgement stays untouched: " + raw, async () => {
    const a = fixture(raw); assert.equal(a.store.read().confirmed, null);
    await assert.rejects(a.store.setConfirmed(DATE, "weight", true)); assert.equal(a.storage.raw, raw); assert.equal(a.storage.writes, 0);
  });
}
test("read denial and write failure do not report success; explicit retry can succeed", async () => {
  const a = fixture(); a.storage.failRead = true;
  assert.equal(a.store.read().confirmed, null); await assert.rejects(a.store.setConfirmed(DATE, "weight", true));
  a.storage.failRead = false; a.storage.failWrite = true;
  await assert.rejects(a.store.setConfirmed(DATE, "weight", true), /quota/); assert.equal(a.storage.raw, null);
  a.storage.failWrite = false; await a.store.setConfirmed(DATE, "weight", true); assert.equal(a.store.read().confirmed[DATE].weight, true);
});
test("failed readback remains unknown without rollback or automatic retry", async () => {
  const a = fixture(); a.storage.failVerify = true;
  await assert.rejects(a.store.setConfirmed(DATE, "weight", true), /照合/); assert.equal(a.store.read().confirmed, null);
  a.storage.failVerify = false; await assert.rejects(a.store.setConfirmed(DATE, "weight", false), /不明/); assert.equal(a.storage.writes, 1);
  assert.equal(api.createStore({ storage: a.storage, locks: a.locks, isSecureContext: true }).read().confirmed[DATE].weight, true);
});
test("unsupported context never writes", async () => {
  const a = fixture(null, { isSecureContext: false }); assert.equal(a.store.supported(), false);
  await assert.rejects(a.store.setConfirmed(DATE, "weight", true), /HTTPS/); assert.equal(a.storage.writes, 0);
});
test("queued acknowledgement times out without a later write", async () => {
  const a = fixture(null, { timeoutMs: 15 }); let release, acquired; const ready = new Promise(r => acquired = r);
  const held = a.locks.request(recordSave.LOCK_NAME, { mode: "exclusive" }, async () => { acquired(); await new Promise(r => release = r); });
  await ready; await assert.rejects(a.store.setConfirmed(DATE, "weight", true), /中止/); release(); await held;
  assert.equal(a.storage.writes, 0);
});
test("ordinary record save never changes confirmation, including value edits and import replacement", async () => {
  const values = new Map([[api.KEY, JSON.stringify({ schemaVersion: 1, confirmed: { [DATE]: { weight: true } } })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, raw) => values.set(key, raw) };
  const before = values.get(api.KEY), records = recordSave.createStore({ storage, transfer, locks: createLocks(), isSecureContext: true });
  let expected;
  for (const weight of ["80", "81", "80"]) {
    const entry = { ...transfer.DEFAULT_ENTRY, weight }; await records.saveDay(() => ({ date: DATE, entry, expected })); expected = entry;
  }
  const plan = transfer.createPlan(storage.getItem(recordSave.KEY), { [DATE]: { ...transfer.DEFAULT_ENTRY, weight: "60" } });
  await records.commitImport(plan, { [DATE]: "replace" }, { backupConfirmed: true, finalConfirmed: true });
  assert.equal(values.get(api.KEY), before);
});
