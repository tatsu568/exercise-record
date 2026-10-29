"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const api = require("../record-save.js"), transfer = require("../record-transfer.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const KEY = api.KEY, DATE = "2041-05-10", OTHER = "2041-05-11";
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const confirmed = { backupConfirmed: true, finalConfirmed: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(records = {}, options = {}) {
  const storage = { raw: records === null ? null : JSON.stringify(records), writes: [], reads: [],
    getItem(key) { assert.equal(key, KEY); this.reads.push(key); return this.raw; },
    setItem(key, raw) { assert.equal(key, KEY); this.writes.push(raw); this.raw = raw; },
    removeItem() { assert.fail("no removal"); }, clear() { assert.fail("no clearing"); } };
  const locks = options.locks || createLocks();
  const store = api.createStore({ storage, transfer, locks, isSecureContext: true, ...options });
  return { storage, locks, store };
}
function save(store, date, entry, expected, generation = 1) { return store.saveDay(() => ({ date, entry, expected, generation })); }
async function hold(locks) {
  let release, acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const job = locks.request(api.LOCK_NAME, { mode: "exclusive" }, async () => { acquired(); await gate; });
  await ready; return async () => { release(); await job; };
}

test("confirmed day deletion preserves every other date including unknown fields and verifies the saved map", async () => {
  const target = "2049-10-27", other = day({ weight: "56.200", future: { keep: [1, "0"] } });
  const f = fixture({ [target]: day(), [OTHER]: other }), raw = f.storage.raw;
  const result = await f.store.deleteDay({ date: target, expectedRaw: raw, confirmed: true });
  assert.equal(result.outcome, "verified"); assert.equal(result.date, target);
  assert.deepEqual(result.records, { [OTHER]: other }); assert.deepEqual(JSON.parse(f.storage.raw), result.records);
  assert.equal(f.storage.writes.length, 1); assert.ok(f.storage.reads.length >= 3);
  assert.deepEqual(f.locks.state(), { held: 0, pending: 0 });
});

test("deletion requires confirmation and a saved complete valid target, without initializing or repairing data", async () => {
  const f = fixture({ [DATE]: day() }), raw = f.storage.raw;
  await assert.rejects(f.store.deleteDay({ date: DATE, expectedRaw: raw }), { code: "CONFIRMATION" });
  await assert.rejects(f.store.deleteDay({ date: OTHER, expectedRaw: raw, confirmed: true }), { code: "NOT_FOUND" });
  await assert.rejects(f.store.deleteDay({ date: "2041-02-30", expectedRaw: raw, confirmed: true }), { code: "INVALID_ENTRY" });
  assert.equal(f.storage.raw, raw); assert.equal(f.storage.writes.length, 0);
  for (const entry of [{ weight: "56" }, day({ distance: "bad" })]) {
    const invalid = fixture({ [DATE]: entry }), before = invalid.storage.raw;
    await assert.rejects(invalid.store.deleteDay({ date: DATE, expectedRaw: before, confirmed: true }), { code: "INVALID_ENTRY" });
    assert.equal(invalid.storage.raw, before); assert.equal(invalid.storage.writes.length, 0);
  }
});

test("deleting the only saved day leaves an empty records map and never removes the storage key", async () => {
  const f = fixture({ [DATE]: day() });
  await f.store.deleteDay({ date: DATE, expectedRaw: f.storage.raw, confirmed: true });
  assert.equal(f.storage.raw, "{}"); assert.equal(f.storage.writes.length, 1);
});

test("deletion waits on the shared lock and stops if any confirmed snapshot changed", async () => {
  const f = fixture({ [DATE]: day() }), raw = f.storage.raw, release = await hold(f.locks);
  const deletion = f.store.deleteDay({ date: DATE, expectedRaw: raw, confirmed: true });
  const external = JSON.stringify({ [DATE]: day(), [OTHER]: day() }); f.storage.raw = external;
  const rejected = assert.rejects(deletion, { code: "STALE" }); await release(); await rejected;
  assert.equal(f.storage.raw, external); assert.equal(f.storage.writes.length, 0);
});

test("duplicate deletions and stale queued input cannot restore a deleted record", async () => {
  const entry = day(), f = fixture({ [DATE]: entry }), raw = f.storage.raw;
  const second = api.createStore({ storage: f.storage, transfer, locks: f.locks, isSecureContext: true });
  const results = await Promise.allSettled([
    f.store.deleteDay({ date: DATE, expectedRaw: raw, confirmed: true }),
    second.deleteDay({ date: DATE, expectedRaw: raw, confirmed: true }),
    save(second, DATE, day({ squat: 5 }), entry)
  ]);
  assert.equal(results[0].status, "fulfilled");
  for (const result of results.slice(1)) assert.equal(result.reason.code, "STALE");
  assert.equal(f.storage.raw, "{}"); assert.equal(f.storage.writes.length, 1);
});

test("a canceled queued deletion never writes after the lock becomes available", async () => {
  const f = fixture({ [DATE]: day() }), raw = f.storage.raw, release = await hold(f.locks), controller = new AbortController();
  const pending = f.store.deleteDay({ date: DATE, expectedRaw: raw, confirmed: true }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "ABORTED" }); controller.abort(); await rejected; await release();
  assert.equal(f.storage.raw, raw); assert.equal(f.storage.writes.length, 0);
});

test("deletion write failures and uncertain verification never report verified success or retry", async () => {
  for (const mode of ["write", "readback", "mismatch"]) {
    const f = fixture({ [DATE]: day(), [OTHER]: day() }), raw = f.storage.raw, write = f.storage.setItem;
    f.storage.setItem = function (...args) {
      if (mode === "write") throw Error("quota");
      write.apply(this, args);
      if (mode === "mismatch") this.raw = raw;
    };
    if (mode === "readback") f.storage.getItem = function () { if (this.writes.length) throw Error("denied"); return this.raw; };
    await assert.rejects(f.store.deleteDay({ date: DATE, expectedRaw: raw, confirmed: true }), { code: mode === "write" ? "WRITE_FAILED" : "VERIFY_FAILED" });
    assert.equal(f.storage.writes.length, mode === "write" ? 0 : 1);
    assert.deepEqual(JSON.parse(f.storage.raw)[OTHER], day());
  }
});

test("single save is verified, retains types/blank/zero/unknown data and never adds metadata", async () => {
  const entry = day({ weight: "0", bodyFat: "", walkSeconds: "0", kids: false, future: { keep: true } });
  const f = fixture(null); const result = await save(f.store, DATE, entry);
  assert.equal(result.outcome, "verified"); assert.equal(result.date, DATE); assert.equal(result.generation, 1);
  assert.deepEqual(JSON.parse(f.storage.raw), { [DATE]: entry }); assert.equal(f.storage.writes.length, 1);
  assert.equal(f.locks.state().held, 0);
});
test("default browser-style timers retain their global receiver", async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (...args) { assert.equal(this, globalThis); return originalSet(...args); };
  globalThis.clearTimeout = function (...args) { assert.equal(this, globalThis); return originalClear(...args); };
  try { const f = fixture(); await save(f.store, DATE, day()); assert.equal(f.storage.writes.length, 1); assert.deepEqual(f.locks.state(), { held: 0, pending: 0 }); }
  finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
test("existing date and partial legacy records survive another day's save", async () => {
  const old = { weight: "56.200", unknown: [1, "0"] }; const f = fixture({ [OTHER]: old });
  await save(f.store, DATE, day()); assert.deepEqual(JSON.parse(f.storage.raw)[OTHER], old);
  assert.equal(Object.keys(JSON.parse(f.storage.raw)).length, 2);
});
test("a confirmed save can be read by a newly created application instance", async () => {
  const f = fixture(); await save(f.store, DATE, day({ squat: 10 }));
  assert.deepEqual(transfer.readSnapshot(f.storage.raw).records[DATE], day({ squat: 10 }));
});
test("same-date sequential saves use the last verified baseline", async () => {
  const f = fixture(); const first = await save(f.store, DATE, day({ squat: 5 }));
  await save(f.store, DATE, day({ squat: 15, weight: "56.2" }), first.records[DATE], 2);
  assert.deepEqual(JSON.parse(f.storage.raw)[DATE], day({ squat: 15, weight: "56.2" }));
});
test("two instances save different days without overwriting stale full snapshots", async () => {
  const f = fixture(); const second = api.createStore({ storage: f.storage, transfer, locks: f.locks, isSecureContext: true });
  await Promise.all([save(f.store, DATE, day({ weight: "56" })), save(second, OTHER, day({ bodyFat: "16" }))]);
  assert.deepEqual(JSON.parse(f.storage.raw), { [DATE]: day({ weight: "56" }), [OTHER]: day({ bodyFat: "16" }) });
  assert.equal(f.storage.writes.length, 2); assert.deepEqual(f.locks.state(), { held: 0, pending: 0 });
});
for (const [name, changes] of [["same field", { weight: "57" }], ["different field of same date", { squat: 10 }]]) {
  test(`conflict in ${name} stops the stale day instead of silently merging`, async () => {
    const original = day({ weight: "55" }), f = fixture({ [DATE]: original });
    const results = await Promise.allSettled([save(f.store, DATE, day({ weight: "56" }), original), save(f.store, DATE, day({ ...original, ...changes }), original)]);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "STALE");
    assert.equal(JSON.parse(f.storage.raw)[DATE].weight, "56"); assert.equal(f.storage.writes.length, 1);
  });
}
test("latest request is selected after lock acquisition", async () => {
  const f = fixture(); const release = await hold(f.locks); let entry = day({ squat: 5 });
  const job = f.store.saveDay(() => ({ date: DATE, entry, expected: undefined, generation: 3 }));
  entry = day({ squat: 15, plank: 60, weight: "56.2" }); await release(); const result = await job;
  assert.deepEqual(result.records[DATE], entry); assert.equal(f.storage.writes.length, 1);
});
test("external different date is reread inside the lock and retained", async () => {
  const f = fixture(); const release = await hold(f.locks);
  const job = save(f.store, DATE, day()); f.storage.raw = JSON.stringify({ [OTHER]: day({ squat: 10 }) });
  await release(); await job; assert.equal(JSON.parse(f.storage.raw)[OTHER].squat, 10);
});
test("a nonparticipating update between read and final check stops the write", async () => {
  const f = fixture(); let reads = 0; const external = JSON.stringify({ [OTHER]: day() });
  f.storage.getItem = () => { if (++reads === 2) f.storage.raw = external; return f.storage.raw; };
  await assert.rejects(save(f.store, DATE, day()), { code: "STALE" }); assert.equal(f.storage.raw, external); assert.equal(f.storage.writes.length, 0);
});
for (const secure of [false, true]) test(`API unavailable (secure=${secure}) never falls back or reads storage`, async () => {
  const f = fixture({}, { isSecureContext: secure, locks: {} });
  await assert.rejects(save(f.store, DATE, day()), { code: "LOCK_UNAVAILABLE" });
  assert.equal(f.storage.writes.length, 0); assert.equal(f.storage.reads.length, 0);
});
test("HTTP blocks writes even if a request-shaped object is present", async () => {
  const f = fixture({}, { isSecureContext: false });
  await assert.rejects(save(f.store, DATE, day()), { code: "LOCK_UNAVAILABLE" }); assert.equal(f.storage.writes.length, 0);
});
test("denied API property is unavailable rather than an uncaught startup error", async () => {
  const locks = Object.defineProperty({}, "request", { get() { throw Error("denied"); } });
  const f = fixture({}, { locks }); assert.equal(f.store.supported(), false);
  await assert.rejects(save(f.store, DATE, day()), { code: "LOCK_UNAVAILABLE" }); assert.equal(f.storage.writes.length, 0);
});
for (const type of ["throw", "reject"]) test(`lock ${type} is propagated without writes`, async () => {
  const f = fixture({}, { locks: { request() { if (type === "throw") throw Error("lock failed"); return Promise.reject(Error("lock rejected")); } } });
  await assert.rejects(save(f.store, DATE, day()), { code: "LOCK_FAILED", phase: "lock", outcome: "not-written" });
  assert.equal(f.storage.writes.length, 0);
});
test("lock timeout aborts its queued request and cannot write later", async () => {
  const f = fixture({}, { timeoutMs: 15 }); const release = await hold(f.locks);
  await assert.rejects(save(f.store, DATE, day()), { code: "LOCK_TIMEOUT" });
  assert.equal(f.locks.state().pending, 0); await release(); await tick(); assert.equal(f.storage.writes.length, 0);
});
test("page cancellation aborts waiting save with no delayed write", async () => {
  const f = fixture(); const release = await hold(f.locks); const job = save(f.store, DATE, day());
  f.store.cancelPending(); await assert.rejects(job, { code: "ABORTED" }); await release(); await tick(); assert.equal(f.storage.writes.length, 0);
});
test("already aborted external signal is not submitted as a write", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.saveDay(() => ({ date: DATE, entry: day() }), { signal: controller.signal }), { code: "ABORTED" });
  assert.equal(f.storage.writes.length, 0);
});
test("delayed timer does not permit an expired queue entry to write", async () => {
  const f = fixture({}, { timeoutMs: 5, timers: { setTimeout() { return 1; }, clearTimeout() {} } });
  const release = await hold(f.locks); const job = save(f.store, DATE, day());
  const rejected = assert.rejects(job, { code: "LOCK_TIMEOUT" }); await new Promise(resolve => setTimeout(resolve, 15)); await release(); await rejected;
  assert.equal(f.storage.writes.length, 0);
});
for (const invalid of ["{broken", "[]", '{"2041-02-29":{}}', '{"2041-05-10":{"kids":"false"}}', '{"2041-05-10":{"weight":"1","weight":"2"}}']) {
  test(`invalid persisted JSON/structure is never silently replaced: ${invalid}`, async () => {
    const f = fixture(); f.storage.raw = invalid;
    await assert.rejects(save(f.store, DATE, day()), { code: "INVALID_STORAGE" }); assert.equal(f.storage.raw, invalid); assert.equal(f.storage.writes.length, 0);
  });
}
for (const phase of ["initial", "final"]) test(`storage read exception at ${phase} prevents writing`, async () => {
  const f = fixture(); let reads = 0; f.storage.getItem = () => { if (++reads === (phase === "initial" ? 1 : 2)) throw Error("denied"); return f.storage.raw; };
  await assert.rejects(save(f.store, DATE, day()), { code: "READ_FAILED" }); assert.equal(f.storage.writes.length, 0);
});
for (const name of ["QuotaExceededError", "SecurityError"]) test(`${name} preserves bytes, releases lock, and permits explicit retry`, async () => {
  const original = { [OTHER]: day() }, f = fixture(original), originalRaw = f.storage.raw;
  const write = f.storage.setItem; f.storage.setItem = () => { throw Object.assign(Error(name), { name }); };
  await assert.rejects(save(f.store, DATE, day()), { code: "WRITE_FAILED" }); assert.equal(f.storage.raw, originalRaw); assert.equal(f.locks.state().held, 0);
  f.storage.setItem = write; await save(f.store, DATE, day()); assert.equal(Object.keys(JSON.parse(f.storage.raw)).length, 2);
});
for (const kind of ["read", "mismatch", "corrupt"]) test(`read-back ${kind} returns unknown outcome, no rollback or retry`, async () => {
  const f = fixture(); const set = f.storage.setItem;
  f.storage.setItem = function (...args) { set.apply(this, args); if (kind === "mismatch") this.raw = "{}"; if (kind === "corrupt") this.raw = "{bad"; };
  if (kind === "read") f.storage.getItem = function () { if (this.writes.length) throw Error("readback"); return this.raw; };
  await assert.rejects(save(f.store, DATE, day()), { code: "VERIFY_FAILED", outcome: "unknown" }); assert.equal(f.storage.writes.length, 1); assert.equal(f.locks.state().held, 0);
});
test("operation rejection releases lock before a later save", async () => {
  const f = fixture(); await assert.rejects(f.store.saveDay(() => { throw Error("unexpected"); }), { code: "LOCK_FAILED" });
  await save(f.store, DATE, day()); assert.equal(f.storage.writes.length, 1);
});
for (const mode of ["JSON", "CSV"]) {
  test(`${mode} import followed by normal save preserves both new dates`, async () => {
    const f = fixture(null), plan = transfer.createPlan(null, { [OTHER]: day({ weight: "56" }) });
    const imported = f.store.commitImport(plan, {}, confirmed), normal = save(f.store, DATE, day({ squat: 10 }));
    await Promise.all([imported, normal]); assert.equal(Object.keys(JSON.parse(f.storage.raw)).length, 2);
  });
  test(`${mode} preview stale after normal save stops whole import`, async () => {
    const f = fixture(null), plan = transfer.createPlan(null, { [OTHER]: day() });
    const normal = save(f.store, DATE, day()), imported = f.store.commitImport(plan, {}, confirmed);
    await normal; await assert.rejects(imported, { code: "STALE" }); assert.deepEqual(Object.keys(JSON.parse(f.storage.raw)), [DATE]);
  });
}
test("double import writes only once and rejects the stale second plan", async () => {
  const f = fixture(null), plan = transfer.createPlan(null, { [DATE]: day() });
  const results = await Promise.allSettled([f.store.commitImport(plan, {}, confirmed), f.store.commitImport(plan, {}, confirmed)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "STALE"); assert.equal(f.storage.writes.length, 1);
});
test("import choices are frozen while waiting for lock", async () => {
  const old = day({ weight: "55" }), f = fixture({ [DATE]: old }), release = await hold(f.locks);
  const plan = transfer.createPlan(f.storage.raw, { [DATE]: day({ weight: "56" }) }), choices = { [DATE]: "keep" };
  const job = f.store.commitImport(plan, choices, confirmed); choices[DATE] = "replace"; await release(); await job;
  assert.equal(JSON.parse(f.storage.raw)[DATE].weight, "55"); assert.equal(f.storage.writes.length, 0);
});
test("cancelled import never commits after lock release", async () => {
  const f = fixture(null), release = await hold(f.locks), plan = transfer.createPlan(null, { [DATE]: day() });
  const job = f.store.commitImport(plan, {}, confirmed); f.store.cancelPending(); await assert.rejects(job, { code: "ABORTED" }); await release(); assert.equal(f.storage.raw, null);
});
test("empty import writes no generated dates", async () => {
  const f = fixture(null), plan = transfer.createPlan(null, {}); const result = await f.store.commitImport(plan, {}, confirmed);
  assert.equal(result.counts.after, 0); assert.equal(f.storage.raw, null); assert.equal(f.storage.writes.length, 0);
});
test("import needs both confirmations before acquiring lock", async () => {
  const f = fixture(null), plan = transfer.createPlan(null, { [DATE]: day() });
  for (const confirmation of [{}, { backupConfirmed: true }, { finalConfirmed: true }]) await assert.rejects(f.store.commitImport(plan, {}, confirmation), { code: "CONFIRMATION" });
  assert.equal(f.storage.reads.length, 0); assert.equal(f.storage.writes.length, 0);
});
test("save key is fixed and no acknowledgement/settings key is touched", async () => {
  assert.throws(() => fixture({}, { key: "exercise-record.attention-acknowledgements.v1" }));
  const f = fixture(); await save(f.store, DATE, day()); assert(f.storage.reads.every(key => key === KEY));
});
for (const entry of [day({ squat: NaN }), day({ standing: Infinity }), day({ kids: "false" }), day({ weight: 0 })]) {
  test("invalid draft is rejected before write and never confused with uncertain persistence", async () => {
    const f = fixture(); await assert.rejects(save(f.store, DATE, entry), { code: "INVALID_ENTRY", phase: "validate", outcome: "not-written" });
    assert.equal(f.storage.writes.length, 0); assert.deepEqual(f.locks.state(), { held: 0, pending: 0 });
  });
}
