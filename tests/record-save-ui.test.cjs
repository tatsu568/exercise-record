"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { createLocks } = require("./helpers/record-locks.cjs");
const save = require("../record-save.js");
// Reuse the existing restore UI's mock-only fixture, without registering its tests.
const fixturePath = path.join(__dirname, "restore-ui.test.cjs");
let fixtureSource = fs.readFileSync(fixturePath, "utf8").split("\ntest(")[0];
assert(fixtureSource.includes("function app("));
fixtureSource = fixtureSource.replace("function app(records = {})", "function app(records = {}, options = {})")
  .replace("const store = {", "const store = options.storage || {")
  .replace("locks: createLocks()", "locks: options.locks || createLocks()")
  .replace("isSecureContext: true", "isSecureContext: options.secure !== false")
  .replace("vm.runInNewContext(source, context);", 'if (options.deniedProperty) Object.defineProperty(context, "localStorage", {get() {throw new Error("storage getter denied");}}); vm.runInNewContext(source, context);');
const fixtureContext = { require: createRequire(fixturePath), __dirname, module: { exports: {} }, Blob, Date, AbortController, console };
vm.runInNewContext(fixtureSource + "\nmodule.exports={app,ready,day,backup};", fixtureContext);
const { app, ready, day, backup } = fixtureContext.module.exports;
const DATE = "2041-05-10", NEXT = "2041-05-11";
const tick = () => new Promise(resolve => setImmediate(resolve));
function instance(records = {}, options = {}) { const a = app(records, options); a.hooks.loadDate(DATE); return a; }
async function hold(locks) {
  let release, acquired; const gate = new Promise(r => { release = r; }), ready = new Promise(r => { acquired = r; });
  const job = locks.request(save.LOCK_NAME, { mode: "exclusive" }, async () => { acquired(); await gate; });
  await ready; return async () => { release(); await job; };
}

test("pending form is unsaved and cannot navigate until exact latest data is verified", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry(); await tick();
  assert.match(a.window.RecordHistoryInput.canBrowse(), /未保存|保存待ち/); assert.notEqual(a.get("#save-status").textContent, "保存済み");
  assert.equal(a.store.writes, 0); await release(); assert.equal(await job, true);
  assert.equal(a.window.RecordHistoryInput.canBrowse(), ""); assert.equal(JSON.parse(a.store.raw)[DATE].weight, "56.2");
});
test("rapid input while lock is queued is coalesced to the latest whole day", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#weight").value = "56"; const job = a.hooks.saveCurrentEntry(); await tick();
  a.steps.find(button => button.dataset.step === "squat" && button.dataset.delta === "5").events.click();
  a.steps.find(button => button.dataset.step === "plank" && button.dataset.delta === "30").events.click();
  a.get("#weight").value = "56.2"; a.get("#walk-seconds").value = "0"; a.hooks.saveCurrentEntry();
  await release(); await job; const record = JSON.parse(a.store.raw)[DATE];
  assert.equal(record.squat, 5); assert.equal(record.plank, 30); assert.equal(record.weight, "56.2"); assert.equal(record.walkSeconds, "0");
  assert.equal(a.store.writes, 1);
});
test("date change freezes original form, waits for save, and preserves original date key", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry(); const moving = a.hooks.switchDate(NEXT);
  assert.equal(a.get("#record-date").value, DATE); assert.equal(a.get("#entry-fields").disabled, true);
  await release(); await job; assert.equal(await moving, true);
  assert.equal(a.get("#record-date").value, NEXT); assert.equal(a.get("#entry-fields").disabled, false);
  assert.deepEqual(Object.keys(JSON.parse(a.store.raw)), [DATE]); assert.equal(JSON.parse(a.store.raw)[DATE].weight, "56.2");
});
test("rapid second date navigation cannot redirect the pending first navigation", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  const moving = a.hooks.switchDate(NEXT); assert.equal(await a.hooks.switchDate("2041-05-12"), false);
  await release(); await moving; assert.equal(a.get("#record-date").value, NEXT);
});
test("failed date navigation retains draft, original date and navigation protection", async () => {
  const a = instance(); a.store.fail = true; a.get("#weight").value = "56.2";
  assert.equal(await a.hooks.switchDate(NEXT), false);
  assert.equal(a.get("#record-date").value, DATE); assert.equal(a.get("#weight").value, "56.2"); assert.equal(a.store.raw, "{}");
  assert.equal(a.get("#entry-fields").disabled, false); assert.match(a.window.RecordHistoryInput.canBrowse(), /未保存/);
});
test("write failure keeps editable fields; explicit retry verifies and clears unsaved state", async () => {
  const a = instance(); a.store.fail = true; a.get("#weight").value = "56.2";
  assert.equal(await a.hooks.saveCurrentEntry(), false); assert.equal(a.get("#save-retry").hidden, false);
  assert.equal(a.get("#save-retry").disabled, false); assert.equal(a.get("#weight").value, "56.2");
  a.store.fail = false; await a.get("#save-retry").click();
  assert.equal(JSON.parse(a.store.raw)[DATE].weight, "56.2"); assert.equal(a.get("#save-retry").hidden, true);
  assert.equal(a.window.RecordHistoryInput.canBrowse(), "");
});
test("earlier completion cannot label later input as saved or redraw it", async () => {
  const a = instance(); let injected = false; const originalWrite = a.store.setItem;
  const successes = []; const status = a.get("#save-status"); let statusText = status.textContent;
  Object.defineProperty(status, "textContent", { get: () => statusText, set(value) { statusText = value; if (value === "保存済み") successes.push(a.get("#weight").value); } });
  a.store.setItem = function (...args) { originalWrite.apply(this, args); if (!injected) { injected = true; a.get("#weight").value = "57.1"; a.hooks.saveCurrentEntry(); } };
  a.get("#weight").value = "56.2"; await a.hooks.saveCurrentEntry();
  assert.equal(a.store.writes, 2); assert.equal(a.get("#weight").value, "57.1"); assert.equal(JSON.parse(a.store.raw)[DATE].weight, "57.1");
  assert.deepEqual(successes, ["57.1"]);
});
test("same-day external update preserves both saved external value and unsaved form", async () => {
  const original = day({ weight: "55" }), locks = createLocks(), release = await hold(locks), a = instance({ [DATE]: original }, { locks });
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry(); await tick();
  a.store.raw = JSON.stringify({ [DATE]: day({ weight: "57" }) }); a.listeners.storage({ key: save.KEY });
  await release(); assert.equal(await job, false);
  assert.equal(a.get("#weight").value, "56.2"); assert.equal(JSON.parse(a.store.raw)[DATE].weight, "57"); assert.equal(a.store.writes, 0);
  assert.match(a.get("#save-status").textContent, /同じ日付/); assert.equal(a.get("#save-retry").disabled, true);
});
test("different-day external storage event does not discard or block safe local draft", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#body-fat").value = "16.4"; const job = a.hooks.saveCurrentEntry(); await tick();
  a.store.raw = JSON.stringify({ [NEXT]: day({ squat: 10 }) }); a.listeners.storage({ key: save.KEY });
  await release(); assert.equal(await job, true); assert.equal(JSON.parse(a.store.raw)[NEXT].squat, 10); assert.equal(JSON.parse(a.store.raw)[DATE].bodyFat, "16.4");
});
test("read-back uncertainty retains form and stops automatic retry and date movement", async () => {
  const a = instance(); a.store.setItem = function () { this.writes++; this.raw = "{}"; };
  a.get("#weight").value = "56.2"; assert.equal(await a.hooks.saveCurrentEntry(), false);
  assert.match(a.get("#save-status").textContent, /変更済みの可能性/); assert.equal(a.get("#save-retry").disabled, true);
  await a.hooks.saveCurrentEntry(); await a.hooks.switchDate(NEXT);
  assert.equal(a.store.writes, 1); assert.equal(a.get("#record-date").value, DATE); assert.equal(a.get("#weight").value, "56.2");
});
test("pagehide aborts queued save without a later hidden write", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry(); await tick(); a.listeners.pagehide();
  assert.equal(await job, false); await release(); await tick(); assert.equal(a.store.writes, 0);
  assert.equal(a.get("#weight").value, "56.2"); assert.equal(a.get("#save-retry").disabled, false);
});
test("beforeunload warns for pending input but does not bypass the lock to write", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  let prevented = false; const cleanEvent = { preventDefault() { prevented = true; } }; a.listeners.beforeunload(cleanEvent); assert.equal(prevented, false);
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry(); await tick();
  a.listeners.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(a.store.writes, 0);
  await release(); await job;
});
test("HTTP permits read-only date viewing but never silently saves edited input", async () => {
  const a = instance({ [NEXT]: day({ weight: "55" }) }, { secure: false });
  await a.hooks.switchDate(NEXT); assert.equal(a.get("#weight").value, "55"); assert.equal(a.store.writes, 0);
  a.get("#weight").value = "56.2"; assert.equal(await a.hooks.saveCurrentEntry(), false);
  await a.hooks.switchDate(DATE); assert.equal(a.get("#record-date").value, NEXT); assert.equal(a.get("#weight").value, "56.2");
  assert.equal(a.store.writes, 0); assert.match(a.get("#save-status").textContent, /HTTPS/);
});
test("pending ordinary input blocks import preview without discarding form", async () => {
  const locks = createLocks(), release = await hold(locks), a = instance({}, { locks });
  a.get("#weight").value = "56.2"; const job = a.hooks.saveCurrentEntry();
  await a.hooks.previewBackup(backup({ [NEXT]: day() })); assert.match(a.get("#restore-status").textContent, /保存エラー/);
  assert.equal(a.get("#weight").value, "56.2"); await release(); await job;
  assert.deepEqual(Object.keys(JSON.parse(a.store.raw)), [DATE]);
});
test("pending import blocks double apply, cancel and ordinary autosave until verified", async () => {
  const locks = createLocks(), a = instance({}, { locks }); await a.hooks.previewBackup(backup({ [NEXT]: day({ weight: "56" }) })); await ready(a);
  const release = await hold(locks), applying = a.hooks.applyRestore(); await tick();
  await a.hooks.applyRestore(); a.hooks.cancelRestore(); assert.equal(await a.hooks.saveCurrentEntry(), false);
  assert.equal(a.get("#restore-cancel").disabled, true); assert.equal(a.get("#entry-fields").disabled, true); assert.equal(a.store.writes, 0);
  await release(); await applying; assert.equal(a.store.writes, 1); assert.equal(a.get("#restore-cancel").disabled, false);
  assert.match(a.get("#restore-status").textContent, /読み戻し照合が完了/);
});
test("cancel page while import is queued cannot write after lock becomes available", async () => {
  const locks = createLocks(), a = instance({}, { locks }); await a.hooks.previewBackup(backup({ [NEXT]: day() })); await ready(a);
  const release = await hold(locks), applying = a.hooks.applyRestore(); await tick(); a.listeners.pagehide(); await applying; await release();
  assert.equal(a.store.writes, 0); assert.equal(a.store.raw, "{}"); assert.equal(a.get("#restore-apply").disabled, true);
});
test("two application instances retain different day edits on shared mock storage", async () => {
  const locks = createLocks(), a = instance({}, { locks }), b = instance({}, { locks, storage: a.store });
  b.hooks.loadDate(NEXT); a.get("#weight").value = "56.2"; b.get("#body-fat").value = "16.4";
  assert.deepEqual(await Promise.all([a.hooks.saveCurrentEntry(), b.hooks.saveCurrentEntry()]), [true, true]);
  assert.equal(JSON.parse(a.store.raw)[DATE].weight, "56.2"); assert.equal(JSON.parse(a.store.raw)[NEXT].bodyFat, "16.4");
});
test("normal write before waiting import invalidates its preview and preserves new record", async () => {
  const locks = createLocks(), a = instance({}, { locks }), b = instance({}, { locks, storage: a.store });
  await a.hooks.previewBackup(backup({ [NEXT]: day() })); await ready(a);
  const release = await hold(locks); b.get("#weight").value = "56.2"; const normal = b.hooks.saveCurrentEntry(); await tick();
  const importing = a.hooks.applyRestore(); await release(); await normal; await importing;
  assert.equal(a.store.writes, 1); assert.deepEqual(Object.keys(JSON.parse(a.store.raw)), [DATE]); assert.equal(a.get("#restore-apply").disabled, true);
});

test("conflict stays stopped after external value returns to baseline and keeps later edits", async () => {
  const original = day({ weight: "55" }), a = instance({ [DATE]: original });
  a.store.raw = JSON.stringify({ [DATE]: day({ weight: "57" }) });
  a.get("#weight").value = "56.2"; assert.equal(await a.hooks.saveCurrentEntry(), false);
  a.store.raw = JSON.stringify({ [DATE]: original });
  a.get("#body-fat").value = "16.4"; assert.equal(await a.hooks.saveCurrentEntry(), false);
  await a.steps.find(button => button.dataset.step === "squat" && button.dataset.delta === "5").events.click();
  assert.equal(a.get("#body-fat").value, "16.4"); assert.equal(a.get("#weight").value, "56.2"); assert.equal(a.store.writes, 0);
});
test("editing after read-back uncertainty does not lose typed fields on stepper render", async () => {
  const a = instance(); a.store.setItem = function () { this.writes++; this.raw = "{}"; };
  a.get("#weight").value = "56.2"; await a.hooks.saveCurrentEntry();
  a.get("#weight").value = "57.1"; await a.hooks.saveCurrentEntry();
  await a.steps.find(button => button.dataset.step === "squat" && button.dataset.delta === "5").events.click();
  assert.equal(a.get("#weight").value, "57.1"); assert.equal(a.store.writes, 1); assert.match(a.get("#save-status").textContent, /変更済みの可能性/);
});
test("corrupt startup storage remains untouched and typed input blocks navigation", async () => {
  const storage = { raw: "{broken", writes: 0, getItem() { return this.raw; }, setItem() { this.writes++; } };
  const a = instance({}, { storage }); a.get("#weight").value = "56.2"; await a.hooks.saveCurrentEntry();
  assert.match(a.window.RecordHistoryInput.canBrowse(), /未保存/);
  await a.steps.find(button => button.dataset.step === "squat" && button.dataset.delta === "5").events.click();
  assert.equal(a.get("#weight").value, "56.2"); assert.equal(storage.raw, "{broken"); assert.equal(storage.writes, 0);
});
test("record input bridge survives a denied localStorage property without data loss", async () => {
  const a = instance({}, { deniedProperty: true }); a.get("#weight").value = "56.2";
  assert.equal(await a.hooks.saveCurrentEntry(), false); assert.equal(a.store.writes, 0);
  assert.equal(a.get("#weight").value, "56.2"); assert.match(a.window.RecordHistoryInput.canBrowse(), /未保存/);
});
test("retry control retains a touch target and space above the fixed input toolbar", () => {
  const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
  assert.match(css, /#save-retry\s*\{[^}]*margin-bottom:\s*calc\(72px\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
  const a = instance(); assert.equal(a.get("#save-retry").hidden, true);
});
