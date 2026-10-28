"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const model = require("../app-settings.js");
function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, writes: [], failWrite: false, failRead: false, afterWrite: null,
    getItem(key) { if (this.failRead) throw Error("read"); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw Error("quota"); this.writes.push(key); values.set(key, value); this.afterWrite?.(key, value); },
    removeItem() { assert.fail("no delete"); }, clear() { assert.fail("no clear"); } };
}
const source = (group, values = {}) => ({ ...model.draft(group), ...values });
const encoded = (group, changes = {}) => JSON.stringify({ schemaVersion: 1, values: { ...model.DEFAULTS[group], ...changes } });

test("exercise goals start unset, normalize nonpositive/invalid values and persist only in their independent key", () => {
  const storage = memory({ "exercise-record.entries.v1": "record bytes" }), store = model.createStore(storage);
  assert(Object.values(store.read("exerciseGoals").values).every(v => v === null)); assert.equal(storage.writes.length, 0);
  for (const raw of ["", " ", "0", "-1", "abc", "Infinity", "0x10"]) assert.equal(model.validate("exerciseGoals", source("exerciseGoals", { squat: raw })).values.squat, null);
  const input = source("exerciseGoals", { squat: "80", march: "10", plank: "60", standing: "15.5", walkSteps: "10000", distance: "1.25" });
  assert.equal(store.save("exerciseGoals", input).ok, true);
  assert.deepEqual(model.createStore(storage).read("exerciseGoals").values, { squat: 80, march: 10, plank: 60, standing: 15.5, walkSteps: 10000, distance: 1.25 });
  assert.deepEqual(storage.writes, [model.KEYS.exerciseGoals]); assert.equal(storage.values.get("exercise-record.entries.v1"), "record bytes");
  assert.equal(store.save("exerciseGoals", source("exerciseGoals")).ok, true); assert(Object.values(store.read("exerciseGoals").values).every(v => v === null));
});

test("exercise goal corruption, failed writes and failed readback keep confirmed settings and protect stored bytes", () => {
  const raw = "{broken", storage = memory({ [model.KEYS.exerciseGoals]: raw }), store = model.createStore(storage);
  assert.equal(store.read("exerciseGoals").needsRepair, true); assert.equal(store.save("exerciseGoals", source("exerciseGoals", { squat: "80" })).ok, false);
  assert.equal(storage.values.get(model.KEYS.exerciseGoals), raw); assert.equal(storage.writes.length, 0);
  assert.equal(store.save("exerciseGoals", source("exerciseGoals", { squat: "80" }), { repair: true }).ok, true);
  storage.failWrite = true; assert.equal(store.save("exerciseGoals", source("exerciseGoals", { squat: "90" })).ok, false); assert.equal(store.read("exerciseGoals").values.squat, 80);
  storage.failWrite = false; storage.afterWrite = () => { storage.failRead = true; };
  assert.equal(store.save("exerciseGoals", source("exerciseGoals", { squat: "90" })).ok, false); storage.failRead = false;
  assert.equal(store.read("exerciseGoals").values.squat, 80); assert.equal(store.read("exerciseGoals").uncertain, true);
});

test("missing settings use independent immutable defaults without writes", () => {
  const storage = memory(), store = model.createStore(storage);
  assert.deepEqual(store.read("goals").values, { weightMin: 56, weightMax: 56.9, bodyFatMin: 16, bodyFatMax: 16.9 });
  assert.deepEqual(store.getAttention().values, { weightMin: 45, weightMax: 70, bodyFatMin: 10, bodyFatMax: 30, compareDays: 10, weightChange: 3, bodyFatChange: 3 });
  const value = store.read("goals").values; value.weightMin = 1;
  assert.equal(store.getTargets().weight.min, 56); assert.equal(storage.writes.length, 0);
});
for (const input of ["56", "56.0", "56.9"]) test(`accept decimal setting ${input}`, () => {
  const result = model.validate("goals", source("goals", { weightMin: input, weightMax: "60" }));
  assert.equal(result.valid, true); assert.equal(result.values.weightMin, Number(input));
});
for (const input of ["", " ", "56.95", "3.25", "56.00", "NaN", "Infinity", "1e2", "0x38", "-1", "0", "１", "56kg", "1e309"]) {
  test(`reject invalid decimal without rounding ${JSON.stringify(input)}`, () => {
    const original = source("goals", { weightMin: input });
    assert.equal(model.validate("goals", original).valid, false); assert.equal(original.weightMin, input);
  });
}
test("upper and lower equality is valid; reversed limits fail for each measurement and group", () => {
  for (const group of ["goals", "attention"]) for (const prefix of ["weight", "bodyFat"]) {
    assert.equal(model.validate(group, source(group, { [prefix + "Min"]: "20", [prefix + "Max"]: "20" })).valid, true);
    assert.equal(model.validate(group, source(group, { [prefix + "Min"]: "21", [prefix + "Max"]: "20" })).valid, false);
  }
});
for (const input of ["1", "365"]) test(`comparison day boundary ${input}`, () => {
  assert.equal(model.validate("attention", source("attention", { compareDays: input })).valid, true);
});
for (const input of ["0", "366", "1.0", "1.1", "", "-1", "Infinity"]) test(`invalid comparison days ${input}`, () => {
  assert.equal(model.validate("attention", source("attention", { compareDays: input })).valid, false);
});
for (const field of model.fields("attention")) test(`attention ${field} rejects zero and excess precision`, () => {
  assert.equal(model.validate("attention", source("attention", { [field]: "0" })).valid, false);
  assert.equal(model.validate("attention", source("attention", { [field]: "3.25" })).valid, false);
});
test("goals may lie outside attention ranges; no cross-group constraint", () => {
  assert.equal(model.validate("goals", source("goals", { weightMin: "100", weightMax: "110" })).valid, true);
});
test("saved numeric schema round-trips and survives a new store instance", () => {
  const storage = memory(), store = model.createStore(storage);
  assert.equal(store.save("goals", source("goals", { weightMin: "54" })).ok, true);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(JSON.parse(storage.values.get(model.KEYS.goals)), { schemaVersion: 1, values: { ...model.DEFAULTS.goals, weightMin: 54 } });
  assert.equal(model.createStore(storage).getTargets().weight.min, 54);
});
test("independent saves touch only their own key and preserve record bytes", () => {
  const storage = memory({ "exercise-record.entries.v1": "fictional record bytes", [model.KEYS.attention]: encoded("attention") });
  const store = model.createStore(storage), before = storage.values.get(model.KEYS.attention);
  assert.equal(store.save("goals", source("goals")).ok, true);
  assert.equal(storage.values.get(model.KEYS.attention), before);
  assert.equal(store.save("attention", source("attention", { compareDays: "20" })).ok, true);
  assert.equal(store.getTargets().weight.min, 56);
  assert.deepEqual(storage.writes, [model.KEYS.goals, model.KEYS.attention]);
  assert.equal(storage.values.get("exercise-record.entries.v1"), "fictional record bytes");
});
for (const [label, raw] of [["JSON", "{broken"], ["array", "[]"], ["version", '{"schemaVersion":2,"values":{}}'],
  ["missing field", '{"schemaVersion":1,"values":{}}'], ["wrong type", encoded("goals", { weightMin: "56" })],
  ["unknown value", encoded("goals", { extra: 1 })], ["unknown envelope", '{"schemaVersion":1,"extra":2,"values":{}}'],
  ["non-finite", encoded("goals", { weightMin: null })], ["range", encoded("goals", { weightMin: 70 })]]) {
  test(`protect ${label} data and require explicit repair`, () => {
    const storage = memory({ [model.KEYS.goals]: raw }), store = model.createStore(storage);
    const result = store.read("goals"); assert.equal(result.needsRepair, true); assert.ok(result.error);
    assert.equal(store.getTargets().weight.min, 56); assert.equal(storage.values.get(model.KEYS.goals), raw);
    assert.equal(store.save("goals", source("goals")).ok, false); assert.equal(storage.writes.length, 0);
    assert.equal(store.save("goals", source("goals"), { repair: true }).ok, true);
    assert.equal(storage.writes.length, 1);
  });
}
test("write failure keeps last targets, draft and permits retry", () => {
  const storage = memory({ [model.KEYS.goals]: encoded("goals") }), store = model.createStore(storage); store.read("goals");
  const input = source("goals", { weightMin: "54" }); storage.failWrite = true;
  assert.equal(store.save("goals", input).ok, false); assert.equal(store.getTargets().weight.min, 56);
  assert.equal(input.weightMin, "54"); storage.failWrite = false;
  assert.equal(store.save("goals", input).ok, true); assert.equal(store.getTargets().weight.min, 54);
});
for (const mode of ["throw", "mismatch"]) test(`readback ${mode} never activates unconfirmed settings`, () => {
  const storage = memory({ [model.KEYS.goals]: encoded("goals") }), store = model.createStore(storage); store.read("goals");
  storage.afterWrite = (key) => { if (mode === "throw") storage.failRead = true; else storage.values.set(key, "{changed"); };
  const result = store.save("goals", source("goals", { weightMin: "54" }));
  assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.match(result.error, /書き込み済みの可能性/);
  storage.failRead = false; assert.equal(store.getTargets().weight.min, 56);
  assert.equal(store.read("attention").values.compareDays, 10);
  if (mode === "throw") {
    storage.afterWrite = null; assert.equal(store.save("goals", source("goals", { weightMin: "54" })).ok, true);
    assert.equal(store.getTargets().weight.min, 54);
  }
});
test("unreadable settings cannot be auto-overwritten", () => {
  const storage = memory(), store = model.createStore(storage); storage.failRead = true;
  assert.ok(store.read("goals").error); assert.equal(store.save("goals", source("goals")).ok, false);
  assert.equal(storage.writes.length, 0);
});
test("external settings update stops stale save and is reread on cancel/reopen", () => {
  const storage = memory(), store = model.createStore(storage); store.read("goals");
  storage.values.set(model.KEYS.goals, encoded("goals", { weightMin: 54 }));
  assert.equal(store.save("goals", source("goals")).ok, false); assert.equal(storage.writes.length, 0);
  assert.equal(store.read("goals").values.weightMin, 54);
});
test("invalid draft never writes; equivalent numeric formatting is not dirty", () => {
  const storage = memory(), store = model.createStore(storage);
  assert.equal(store.save("goals", source("goals", { weightMin: "56.95" })).ok, false);
  assert.equal(model.changed("goals", source("goals", { weightMin: "56" }), model.DEFAULTS.goals), false);
  assert.equal(model.changed("goals", source("goals", { weightMin: "" }), model.DEFAULTS.goals), true);
  assert.equal(storage.writes.length, 0);
});
