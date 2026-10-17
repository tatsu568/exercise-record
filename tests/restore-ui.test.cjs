"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { File } = require("node:buffer");
const transfer = require("../record-transfer.js");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "script.js"), "utf8").replace(/\}\)\(\);\s*$/, "globalThis.hooks = { previewBackup, prepareRestoreBackup, applyRestore, cancelRestore, saveCurrentEntry, loadDate, switchDate, exerciseRow, bodyRow, weeklyCopyText, weeklyBodyCopyText };\n})();");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const backup = (records) => ({ text: async () => JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-03-01T01:02:03.000Z", records }) });

class Element {
  constructor(tag = "div", attrs = "") {
    this.tag = tag; this.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || "";
    this.type = /\btype="([^"]*)"/.exec(attrs)?.[1] || "text";
    this.checked = false; this.disabled = /\sdisabled\b/.test(attrs); this.hidden = /\shidden\b/.test(attrs);
    this.dataset = {}; this.style = {}; this.children = []; this.events = {}; this.textContent = "";
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  focus() {} blur() {} scrollIntoView() {} remove() {}
  click() { return this.events.click?.({ target: this }); }
}
class Input extends Element {}

function app(records = {}) {
  const elements = new Map(), work = [], steps = [], created = [], shared = [], clipboard = [];
  for (const match of html.matchAll(/<([a-z-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    elements.set("#" + match[3], match[1] === "input" ? new Input(match[1], match[2]) : new Element(match[1], match[2]));
  }
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const element = new Element("button", match[1]);
    const workValue = /data-work="([^"]+)"/.exec(match[1]);
    const stepValue = /data-step="([^"]+)"/.exec(match[1]);
    if (workValue) { element.dataset.work = workValue[1]; work.push(element); }
    if (stepValue) { element.dataset.step = stepValue[1]; element.dataset.delta = /data-delta="([^"]+)"/.exec(match[1])[1]; steps.push(element); }
  }
  const get = (selector) => { assert(elements.has(selector), "HTML is missing " + selector); return elements.get(selector); };
  const listeners = {};
  const store = { raw: JSON.stringify(records), writes: 0, fail: false,
    getItem() { return this.raw; }, setItem(_key, value) { this.writes++; if (this.fail) throw new Error("quota"); this.raw = value; },
    removeItem() { assert.fail("must not delete storage"); }
  };
  const window = { isSecureContext: true, confirm: () => true, addEventListener(name, fn) { listeners[name] = fn; } };
  const navigator = { canShare: () => true, share: async (data) => { shared.push(data); }, clipboard: { write: async (items) => clipboard.push(items), writeText: async (text) => clipboard.push(text) } };
  const document = { querySelector: get, querySelectorAll: (selector) => selector === "[data-work]" ? work : selector === "[data-step]" ? steps : [],
    createElement(tag) { const node = new Element(tag); created.push(node); return node; }, body: { append() {} }, activeElement: null };
  const context = { document, window, navigator, localStorage: store, RecordTransfer: transfer, HTMLInputElement: Input,
    Blob, File, ClipboardItem: class { constructor(data) { this.data = data; } }, Date,
    console: { warn() {}, error() {} }, setTimeout() { return 1; }, clearTimeout() {} };
  vm.runInNewContext(source, context);
  return { hooks: context.hooks, get, store, window, navigator, shared, clipboard, listeners, created, steps, work };
}

async function ready(instance) {
  await instance.hooks.prepareRestoreBackup();
  assert.equal(instance.get("#restore-backup-confirm").disabled, false);
  instance.get("#restore-backup-confirm").checked = true;
  instance.get("#restore-final-confirm").checked = true;
  instance.get("#restore-final-confirm").events.change();
}

test("file not selected, read failure, invalid JSON, and cancel do not change records", async () => {
  const instance = app({ "2032-02-28": day() }), original = instance.store.raw;
  await instance.hooks.previewBackup(undefined);
  for (const file of [{ text: async () => { throw new Error("read failure"); } }, { text: async () => "{broken" }]) {
    await instance.hooks.previewBackup(file);
    assert.match(instance.get("#restore-status").textContent, /エラー1件/);
    instance.hooks.cancelRestore();
  }
  assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
});

test("preview defaults to keep; input and date navigation cannot autosave until cancel", async () => {
  const instance = app({ "2032-02-28": day({ weight: "52" }) }), original = instance.store.raw;
  instance.hooks.loadDate("2032-02-28");
  await instance.hooks.previewBackup(backup({ "2032-02-28": day({ weight: "53" }), "2032-02-29": day() }));
  assert.equal(instance.created.find((node) => node.tag === "select").value, "keep");
  assert.equal(instance.get("#entry-fields").disabled, true);
  assert.equal(instance.get("#restore-apply").disabled, true);
  instance.hooks.saveCurrentEntry(); instance.hooks.switchDate("2032-02-29");
  assert.equal(instance.get("#record-date").value, "2032-02-28");
  instance.hooks.cancelRestore();
  assert.equal(instance.get("#entry-fields").disabled, false);
  assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
});

test("backup cancellation, missing confirmations, and final dialog cancellation all block writing", async () => {
  const instance = app();
  await instance.hooks.previewBackup(backup({ "2032-02-29": day() }));
  instance.navigator.share = async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; };
  await instance.hooks.prepareRestoreBackup();
  assert.equal(instance.get("#restore-backup-confirm").disabled, true);
  instance.hooks.applyRestore(); assert.equal(instance.store.writes, 0);
  instance.navigator.share = async () => {};
  await instance.hooks.prepareRestoreBackup();
  instance.get("#restore-final-confirm").checked = true;
  instance.hooks.applyRestore(); assert.equal(instance.store.writes, 0);
  await ready(instance); instance.window.confirm = () => false;
  instance.hooks.applyRestore(); assert.equal(instance.store.writes, 0);
});

test("confirmed day replacement writes once, reads back, and refreshes the selected date without autosaving it", async () => {
  const instance = app({ "2032-02-28": day({ weight: "52", basal: "1200" }) });
  instance.hooks.loadDate("2032-02-28");
  await instance.hooks.previewBackup(backup({ "2032-02-28": { weight: "0", future: "keep" }, "2032-02-29": day() }));
  const select = instance.created.find((node) => node.tag === "select"); select.value = "replace"; select.events.change();
  await ready(instance); instance.hooks.applyRestore();
  assert.equal(instance.store.writes, 1);
  assert.deepEqual(JSON.parse(instance.store.raw)["2032-02-28"], { weight: "0", future: "keep" });
  assert.equal(instance.get("#weight").value, "0"); assert.equal(instance.get("#basal").value, "");
  assert.equal(instance.get("#entry-fields").disabled, false);
  assert.match(instance.get("#restore-status").textContent, /読み戻し照合が完了/);
});

test("storage update event invalidates preview; a silent update is also caught immediately before write", async () => {
  for (const event of [false, true]) {
    const instance = app(); await instance.hooks.previewBackup(backup({ "2032-02-29": day() })); await ready(instance);
    const external = JSON.stringify({ "2032-02-27": day({ squat: 15 }) }); instance.store.raw = external;
    if (event) instance.listeners.storage({ key: "exercise-record.entries.v1" });
    instance.hooks.applyRestore();
    assert.equal(instance.store.writes, 0); assert.equal(instance.store.raw, external);
    assert.equal(instance.get("#restore-apply").disabled, true);
    instance.hooks.cancelRestore(); assert.equal(instance.store.raw, external);
  }
});

test("late file read completion after cancellation does not reopen preview or save anything", async () => {
  const instance = app(); let resolve;
  const reading = instance.hooks.previewBackup({ text: () => new Promise((done) => { resolve = done; }) });
  instance.hooks.cancelRestore(); resolve(await backup({ "2032-02-29": day() }).text()); await reading;
  assert.equal(instance.get("#restore-panel").hidden, true); assert.equal(instance.store.writes, 0);
});

test("unsaved input after a normal write failure prevents restore from discarding that form", async () => {
  const instance = app(); instance.hooks.loadDate("2032-02-28"); instance.store.fail = true; instance.get("#weight").value = "60";
  instance.hooks.saveCurrentEntry(); const original = instance.store.raw;
  instance.hooks.switchDate("2032-02-29");
  assert.equal(instance.get("#record-date").value, "2032-02-28");
  await instance.hooks.previewBackup(backup({ "2032-02-29": day() }));
  assert.match(instance.get("#restore-status").textContent, /保存エラー/);
  assert.equal(instance.get("#weight").value, "60"); assert.equal(instance.store.raw, original);
});

test("pre-restore backup shares only the existing JSON and does not save missing dates", async () => {
  const records = { "2032-02-28": day({ distance: "0", weight: "0" }) }, instance = app(records);
  await instance.hooks.previewBackup(backup({ "2032-02-29": day() }));
  await instance.hooks.prepareRestoreBackup();
  assert.deepEqual(Object.keys(instance.shared[0]), ["files"]);
  const json = JSON.parse(await instance.shared[0].files[0].text());
  assert.deepEqual(json.records, records); assert.equal(instance.store.writes, 0);
});

test("write failure and read-back mismatch stop UI persistence without rollback", async () => {
  for (const mismatch of [false, true]) {
    const instance = app({ "2032-02-28": day() }), original = instance.store.raw;
    await instance.hooks.previewBackup(backup({ "2032-02-29": day() })); await ready(instance);
    const external = JSON.stringify({ "2032-02-27": day({ weight: "0" }) });
    if (mismatch) instance.store.setItem = function () { this.writes++; this.raw = external; };
    else instance.store.fail = true;
    instance.hooks.applyRestore();
    assert.equal(instance.store.raw, mismatch ? external : original);
    assert.equal(instance.store.writes, 1);
    instance.hooks.saveCurrentEntry(); assert.equal(instance.store.writes, 1);
    assert.equal(instance.get("#restore-apply").disabled, true);
    if (mismatch) assert.match(instance.get("#save-status").textContent, /自動保存を停止/);
    instance.hooks.cancelRestore(); assert.equal(instance.store.writes, 1);
  }
});

test("corrupt existing storage cannot be replaced by selecting a backup", async () => {
  const instance = app(); instance.store.raw = "{broken";
  instance.listeners.storage({ key: "exercise-record.entries.v1" });
  await instance.hooks.previewBackup(backup({ "2032-02-29": day() }));
  assert.equal(instance.store.writes, 0); assert.equal(instance.store.raw, "{broken");
  assert.match(instance.get("#restore-status").textContent, /安全に確認できません/);
});

test("four copy formats and normal steppers/date-save behavior survive restoration", async () => {
  const instance = app({ "2032-03-01": day({ work: "出社", kids: true, squat: 10, march: 2, plank: 60, walkSteps: "1234", weight: "50", bodyFat: "0" }) });
  instance.hooks.loadDate("2032-03-01");
  const exercise = JSON.stringify(instance.hooks.exerciseRow()), body = JSON.stringify(instance.hooks.bodyRow());
  const week = instance.hooks.weeklyCopyText("2032-03-08"), weeklyBody = instance.hooks.weeklyBodyCopyText("2032-03-08");
  assert.equal(JSON.parse(exercise).length, 9); assert.equal(JSON.parse(body).length, 3);
  assert.equal(week.split("\n")[0].split("\t").length, 10);
  await instance.get("#copy-exercise").click(); await instance.get("#copy-body").click();
  assert.deepEqual(Object.keys(instance.clipboard[0][0].data), ["text/html", "text/plain"]);
  await instance.hooks.previewBackup(backup({ "2032-04-01": day({ weight: "51" }) })); await ready(instance); instance.hooks.applyRestore();
  assert.equal(JSON.stringify(instance.hooks.exerciseRow()), exercise); assert.equal(JSON.stringify(instance.hooks.bodyRow()), body);
  assert.equal(instance.hooks.weeklyCopyText("2032-03-08"), week); assert.equal(instance.hooks.weeklyBodyCopyText("2032-03-08"), weeklyBody);
  const button = instance.steps.find((node) => node.dataset.step === "squat" && node.dataset.delta === "10"); button.click();
  assert.equal(JSON.parse(instance.store.raw)["2032-03-01"].squat, 20);
  instance.hooks.switchDate("2032-04-01"); assert.equal(instance.get("#weight").value, "51");
});
