"use strict";
const RecordSave = require("../record-save.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { File } = require("node:buffer");
const transfer = require("../record-transfer.js");
const csv = require("../numbers-csv.js");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8").replace(/\}\)\(\);\s*$/, "globalThis.hooks = { loadDate, saveCurrentEntry, switchDate };\n})();");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const row = (date = "2/29", values = {}) => {
  const cells = Array(15).fill(""); cells[1] = date; cells[11] = date;
  for (const [index, value] of Object.entries(values)) cells[index] = value;
  return cells;
};
const csvFile = (rows) => {
  const text = [csv.HEADERS, ...rows].map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  return { name: "fictional.csv", arrayBuffer: async () => new TextEncoder().encode(text).buffer };
};
class Element {
  constructor(tag = "div", attrs = "") {
    this.tag = tag; this.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ""; this.type = /\btype="([^"]*)"/.exec(attrs)?.[1] || "text";
    this.checked = false; this.disabled = /\sdisabled\b/.test(attrs); this.hidden = /\shidden\b/.test(attrs);
    this.dataset = {}; this.style = {}; this.children = []; this.events = {}; this.textContent = ""; this.classList = { add() {}, remove() {} };
    this.scrollTop = 0; this.open = false; this.focusCalls = []; this.scrollCalls = [];
  }
  addEventListener(name, fn) { this.events[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  focus(options) { this.focusCalls.push(options); }
  blur() {} scrollIntoView(options) { this.scrollCalls.push(options); } remove() {}
  click() { return this.events.click?.({ target: this }); }
}
class Input extends Element {}
function app(records = {}) {
  const elements = new Map(), work = [], steps = [], created = [], shared = [], clipboard = [], listeners = {}, frames = [];
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set("#" + match[3], match[1] === "input" ? new Input(match[1], match[2]) : new Element(match[1], match[2]));
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const element = new Element("button", match[1]), workValue = /data-work="([^"]+)"/.exec(match[1]), stepValue = /data-step="([^"]+)"/.exec(match[1]);
    if (workValue) { element.dataset.work = workValue[1]; work.push(element); }
    if (stepValue) { element.dataset.step = stepValue[1]; element.dataset.delta = /data-delta="([^"]+)"/.exec(match[1])[1]; steps.push(element); }
  }
  const get = (selector) => { assert(elements.has(selector), selector); return elements.get(selector); };
  const store = { raw: JSON.stringify(records), writes: 0, fail: false,
    getItem() { return this.raw; }, setItem(_key, value) { this.writes++; if (this.fail) throw Error("quota"); this.raw = value; }, removeItem() { assert.fail("must not remove records"); } };
  const navigator = { locks: createLocks(), canShare: () => true, share: async (data) => { shared.push(data); }, clipboard: { write: async (value) => clipboard.push(value), writeText: async (value) => clipboard.push(value) } };
  const window = { isSecureContext: true, confirm: () => true, addEventListener(name, fn) { listeners[name] = fn; }, requestAnimationFrame(fn) { frames.push(fn); } };
  const document = { querySelector: get, querySelectorAll: (selector) => selector === "[data-work]" ? work : selector === "[data-step]" ? steps : [], createElement(tag) { const node = new Element(tag); created.push(node); return node; }, body: { append() {} }, activeElement: null };
  const context = { document, window, navigator, localStorage: store, RecordTransfer: transfer, RecordSave, AbortController, NumbersCsv: csv, HTMLInputElement: Input, File, Blob, Date,
    ClipboardItem: class { constructor(data) { this.data = data; } }, console: { warn() {}, error() {} }, setTimeout() { return 1; }, clearTimeout() {} };
  vm.runInNewContext(script, context);
  return { get, store, shared, clipboard, listeners, created, window, navigator, hooks: context.hooks, flushFrames() { frames.splice(0).forEach((fn) => fn()); } };
}
async function select(instance, file = csvFile([row("2/29", { 12: "0" })])) {
  await instance.get("#csv-file").events.change({ target: { files: file ? [file] : [] } });
}
function preview(instance) {
  instance.get("#csv-year").value = "2032"; instance.get("#csv-start-date").value = "2032-01-01"; instance.get("#csv-end-date").value = "2032-12-31";
  instance.get("#csv-year-confirm").checked = true; instance.get("#csv-preview-button").click();
}
async function ready(instance) {
  await instance.get("#restore-prebackup").click();
  assert.equal(instance.get("#restore-backup-confirm").disabled, false);
  instance.get("#restore-backup-confirm").checked = true; instance.get("#restore-final-confirm").checked = true;
  instance.get("#restore-final-confirm").events.change();
}
test("CSV selection/settings/conversion/preview/cancel never write; normal input and date locked", async () => {
  const instance = app({ "2032-02-28": day({ weight: "50" }) }), original = instance.store.raw;
  instance.hooks.loadDate("2032-02-28"); await select(instance, null); assert.equal(instance.store.writes, 0);
  await select(instance); assert.equal(instance.get("#entry-fields").disabled, true); assert.equal(instance.get("#restore-start").disabled, true);
  (await instance.hooks.saveCurrentEntry()); (await instance.hooks.switchDate("2032-03-01"));
  assert.equal(instance.get("#record-date").value, "2032-02-28"); preview(instance);
  assert.equal(instance.get("#restore-preview").hidden, false); assert.equal(instance.get("#restore-apply").disabled, true);
  assert.match(instance.get("#csv-summary").textContent, /変換成功：1日/);
  assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
  instance.get("#restore-cancel").click(); assert.equal(instance.get("#entry-fields").disabled, false); assert.equal(instance.store.raw, original);
});
test("CSV requires base-year acknowledgment and changing settings revokes the old plan", async () => {
  const instance = app(); await select(instance); preview(instance); await ready(instance);
  instance.get("#csv-year").events.input();
  assert.equal(instance.get("#csv-year-confirm").checked, false); assert.equal(instance.get("#restore-preview").hidden, true);
  await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
  instance.get("#csv-preview-button").click(); assert.match(instance.get("#restore-status").textContent, /基準年/);
});
test("CSV malformed bytes/header, file read errors, conversion errors and no-file cancel preserve data", async () => {
  for (const file of [{ name: "fictional.csv", arrayBuffer: async () => new Uint8Array([0x82, 0xa0]).buffer }, { name: "fictional.csv", arrayBuffer: async () => new TextEncoder().encode("wrong,header").buffer }, { name: "fictional.csv", arrayBuffer: async () => { throw Error("read error"); } }]) {
    const instance = app(); await select(instance, file); assert.equal(instance.get("#restore-apply").disabled, true); assert.equal(instance.store.writes, 0);
  }
  const instance = app(); await select(instance, csvFile([row("2/29", { 10: "1km不明" })])); preview(instance);
  assert.equal(instance.get("#restore-preview").hidden, true); assert.match(instance.get("#csv-errors").children[0].textContent, /論理行2/);
  assert.equal(instance.get("#csv-rows").children.length, 1); await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
});
test("CSV conflict defaults keep; differences explicitly warn about lost values", async () => {
  const instance = app({ "2032-02-29": day({ weight: "50", basal: "1200", squat: 10 }) });
  await select(instance); preview(instance);
  const choice = instance.created.find((node) => node.tag === "select"); assert.equal(choice.value, "keep");
  assert.ok(choice.children.some((option) => option.textContent === "CSVで置換"));
  assert.ok(instance.created.some((node) => /既存値は空欄・0・OFF/.test(node.textContent)));
  await ready(instance); await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
  choice.value = "replace"; choice.events.change(); assert.equal(instance.get("#restore-final-confirm").checked, false);
  instance.get("#restore-final-confirm").checked = true; instance.get("#restore-final-confirm").events.change(); await instance.get("#restore-apply").click();
  assert.equal(instance.store.writes, 1); assert.equal(JSON.parse(instance.store.raw)["2032-02-29"].basal, "");
  assert.match(instance.get("#restore-status").textContent, /CSV取り込みと読み戻し照合が完了/);
});
test("standing-only requires per-day selection, resets confirmations and does not generate other days", async () => {
  const instance = app(); await select(instance, csvFile([row("2/28"), row("2/29", { 6: "10" })])); preview(instance);
  assert.match(instance.get("#restore-summary").textContent, /記録日数：0日/);
  const checkbox = instance.created.find((node) => node.type === "checkbox"); assert.equal(checkbox.checked, false);
  checkbox.checked = true; checkbox.events.change(); assert.match(instance.get("#restore-summary").textContent, /記録日数：1日/);
  await ready(instance); await instance.get("#restore-apply").click();
  assert.deepEqual(Object.keys(JSON.parse(instance.store.raw)), ["2032-02-29"]);
});
test("all converted rows are paginated with raw and converted values, including walk and body", async () => {
  const instance = app();
  await select(instance, csvFile(Array.from({ length: 23 }, (_v, index) => row(`3/${index + 1}`, { 10: "1km,2:03,500歩", 12: "0" })))); preview(instance);
  assert.equal(instance.get("#csv-rows").children.length, 10); assert.match(instance.get("#csv-page-label").textContent, /1〜10／23/);
  assert.ok(instance.created.some((node) => node.tag === "pre" && node.textContent.includes('"walkSeconds": "3"')));
  assert.ok(instance.created.some((node) => node.tag === "pre" && node.textContent.includes('M 体重："0"')));
  instance.get("#csv-page-next").click(); instance.get("#csv-page-next").click();
  assert.equal(instance.get("#csv-rows").children.length, 3); assert.match(instance.get("#csv-page-label").textContent, /21〜23／23/);
  assert.equal(instance.get("#csv-page-next").disabled, true); instance.get("#csv-page-prev").click(); assert.equal(instance.get("#csv-rows").children.length, 10);
  assert.equal(instance.store.writes, 0);
});
test("CSV requires saved pre-backup acknowledgment, both checkboxes and final dialog", async () => {
  const instance = app(); await select(instance); preview(instance);
  await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
  instance.navigator.share = async () => { const error = Error("cancel"); error.name = "AbortError"; throw error; };
  await instance.get("#restore-prebackup").click(); assert.equal(instance.get("#restore-backup-confirm").disabled, true);
  instance.navigator.share = async (data) => { instance.shared.push(data); }; await ready(instance);
  const saved = JSON.parse(await instance.shared[0].files[0].text()); assert.deepEqual(saved.records, {});
  instance.window.confirm = () => false; await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
  instance.window.confirm = () => true; await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 1);
});
test("CSV storage changes during config, preview and pre-backup invalidate the candidate", async () => {
  for (const phase of ["config", "preview", "backup", "silent"]) {
    const instance = app(); await select(instance);
    if (phase !== "config") preview(instance);
    if (phase === "silent") await ready(instance);
    const external = JSON.stringify({ "2032-02-28": day({ weight: "0" }) });
    if (phase === "backup") instance.navigator.share = async () => { instance.store.raw = external; };
    else instance.store.raw = external;
    if (phase === "config" || phase === "preview") instance.listeners.storage({ key: "exercise-record.entries.v1" });
    if (phase === "backup") await instance.get("#restore-prebackup").click();
    await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0); assert.equal(instance.store.raw, external);
  }
});
test("CSV quota failure/read-back mismatch stop without deletion or automatic rollback", async () => {
  for (const mismatch of [false, true]) {
    const instance = app({ "2032-02-28": day() }), original = instance.store.raw;
    await select(instance); preview(instance); await ready(instance);
    if (mismatch) instance.store.setItem = function () { this.writes++; this.raw = "{}"; }; else instance.store.fail = true;
    await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 1); assert.equal(instance.store.raw, mismatch ? "{}" : original);
    (await instance.hooks.saveCurrentEntry()); assert.equal(instance.store.writes, 1); assert.equal(instance.get("#restore-apply").disabled, true);
  }
});
test("late CSV read after cancel cannot restore a stale preview", async () => {
  const instance = app(); let resolve;
  const reading = select(instance, { name: "fictional.csv", arrayBuffer: () => new Promise((done) => { resolve = done; }) });
  instance.get("#restore-cancel").click(); resolve(await csvFile([row()]).arrayBuffer()); await reading;
  assert.equal(instance.get("#restore-panel").hidden, true); assert.equal(instance.store.writes, 0);
});
test("after CSV commit JSON export/restore and four copy formats remain available", async () => {
  const instance = app({ "2032-02-28": day({ squat: 10 }) }); instance.hooks.loadDate("2032-02-28");
  await select(instance); preview(instance); await ready(instance); await instance.get("#restore-apply").click();
  await instance.get("#backup-export").click();
  assert.equal(Object.keys(JSON.parse(await instance.shared.at(-1).files[0].text()).records).length, 2);
  for (const id of ["copy-exercise", "copy-body", "copy-weekly", "copy-weekly-body"]) await instance.get(`#${id}`).click();
  assert.deepEqual(Object.keys(instance.clipboard[0][0].data), ["text/html", "text/plain"]);
  const plain = await instance.clipboard[0][0].data["text/plain"].text(); assert.equal(plain.split("\t").length, 9);
  assert.equal((await instance.clipboard[1][0].data["text/plain"].text()).split("\t").length, 3);
  const file = { text: async () => JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-03-01T00:00:00.000Z", records: { "2032-03-01": day({ weight: "51" }) } }) };
  await instance.get("#restore-file").events.change({ target: { files: [file] } }); await ready(instance); await instance.get("#restore-apply").click();
  assert.equal(Object.keys(JSON.parse(instance.store.raw)).length, 3);
});

test("header-only CSV and period with no records never generate dates or write", async () => {
  for (const rows of [[], [row("2/29")], [row("2/29", { 12: "0" })]]) {
    const instance = app(); await select(instance, csvFile(rows)); preview(instance);
    if (rows[0]?.[12]) {
      instance.get("#csv-start-date").value = "2032-03-01"; instance.get("#csv-year-confirm").checked = true;
      instance.get("#csv-preview-button").click();
    }
    assert.equal(instance.get("#restore-apply").disabled, true); await instance.get("#restore-apply").click();
    assert.equal(instance.store.raw, "{}"); assert.equal(instance.store.writes, 0);
  }
});

test("year input errors can be corrected and re-previewed without selecting the file again", async () => {
  const instance = app(); await select(instance); instance.get("#csv-preview-button").click();
  assert.equal(instance.get("#restore-preview").hidden, true); preview(instance);
  assert.equal(instance.get("#restore-preview").hidden, false); assert.equal(instance.store.writes, 0);
});

test("corrupt current storage and unsaved normal input both block CSV imports", async () => {
  const corrupt = app(); corrupt.store.raw = "{broken"; corrupt.listeners.storage({ key: "exercise-record.entries.v1" });
  await select(corrupt); assert.equal(corrupt.store.raw, "{broken"); assert.equal(corrupt.store.writes, 0);
  const unsaved = app(); unsaved.store.fail = true; unsaved.get("#weight").value = "55"; (await unsaved.hooks.saveCurrentEntry());
  const writes = unsaved.store.writes; await select(unsaved);
  assert.equal(unsaved.get("#weight").value, "55"); assert.equal(unsaved.store.writes, writes);
});

test("storage read failure during CSV preview fails closed without writing", async () => {
  const instance = app(); await select(instance); instance.store.getItem = () => { throw Error("blocked"); }; preview(instance);
  assert.match(instance.get("#restore-status").textContent, /停止/); await instance.get("#restore-apply").click(); assert.equal(instance.store.writes, 0);
});

test("CSV conflict pages retain per-day choices, and in-flight backups cannot be started twice", async () => {
  const records = Object.fromEntries(Array.from({ length: 12 }, (_v, index) => [`2032-03-${String(index + 1).padStart(2, "0")}`, day({ weight: "50" })]));
  const instance = app(records); await select(instance, csvFile(Array.from({ length: 12 }, (_v, index) => row(`3/${index + 1}`, { 12: "51" })))); preview(instance);
  const choices = () => {
    const result = [];
    const visit = (node) => { if (node.tag === "select") result.push(node); for (const child of node.children || []) visit(child); };
    visit(instance.get("#restore-conflicts")); return result;
  };
  assert.equal(choices().length, 10); choices()[0].value = "replace"; choices()[0].events.change();
  instance.get("#csv-page-next").click(); assert.equal(choices().length, 2);
  instance.get("#csv-page-prev").click(); assert.equal(choices()[0].value, "replace");
  let resolve, shares = 0;
  instance.navigator.share = () => { shares++; return new Promise((done) => { resolve = done; }); };
  const pending = instance.get("#restore-prebackup").click(); instance.get("#csv-page-next").click();
  assert.equal(instance.get("#restore-prebackup").disabled, true); await instance.get("#restore-prebackup").click(); assert.equal(shares, 1);
  resolve(); await pending; assert.equal(instance.store.writes, 0);
});

const conflictDate = (dayNumber) => `2032-03-${String(dayNumber).padStart(2, "0")}`;
function conflictFixture(total = 31, conflicts = [2, 15, 31], same = []) {
  const rows = Array.from({ length: total }, (_value, index) => row(`3/${index + 1}`, { 6: "12", 12: "51" }));
  const records = Object.fromEntries(conflicts.map((number) => [conflictDate(number), day({ standing: 12, weight: "50" })]));
  for (const number of same) records[conflictDate(number)] = day({ standing: 12, weight: "51" });
  return { rows, records };
}
async function conflictApp(fixture = conflictFixture()) {
  const instance = app(fixture.records);
  await select(instance, csvFile(fixture.rows)); preview(instance);
  return instance;
}
function descendants(node, predicate) {
  const result = [];
  for (const child of node.children || []) {
    if (predicate(child)) result.push(child);
    result.push(...descendants(child, predicate));
  }
  return result;
}
const conflictLinks = (instance) => instance.get("#csv-conflict-links").children.map((item) => item.children[0]);
const conflictDates = (instance) => conflictLinks(instance).map((button) => button.dataset.conflictDate);
function conflictCard(instance, dayNumber) {
  const card = descendants(instance.get("#restore-conflicts"), (node) => node.id === `csv-conflict-${conflictDate(dayNumber)}`)[0];
  assert.ok(card, `missing conflict card ${dayNumber}`);
  return { card, details: descendants(card, (node) => node.tag === "details")[0], heading: descendants(card, (node) => node.tag === "summary")[0], choice: descendants(card, (node) => node.tag === "select")[0] };
}
function jump(instance, dayNumber) {
  const link = conflictLinks(instance).find((button) => button.dataset.conflictDate === conflictDate(dayNumber));
  assert.ok(link, `missing conflict link ${dayNumber}`); link.click();
  return conflictCard(instance, dayNumber);
}

test("conflict index hides zero conflicts and excludes new and fully matching dates", async () => {
  const instance = await conflictApp(conflictFixture(3, [], [2]));
  assert.equal(instance.get("#csv-conflict-index").hidden, true); assert.deepEqual(conflictDates(instance), []);
  assert.match(instance.get("#restore-summary").textContent, /新規追加：2日／完全一致：1日／競合：0日/);
  assert.equal(instance.store.writes, 0);
});

test("one conflict displays one labeled jump button using the existing classification", async () => {
  const instance = await conflictApp(conflictFixture(3, [2], [1]));
  assert.equal(instance.get("#csv-conflict-index").hidden, false);
  assert.equal(instance.get("#csv-conflict-heading").textContent, "競合している記録：1日");
  assert.deepEqual(conflictDates(instance), [conflictDate(2)]);
  assert.equal(conflictLinks(instance)[0].children[0].textContent, "2032/03/02");
  assert.equal(conflictLinks(instance)[0].children[1].textContent, "詳細を見る");
});

test("all three conflicts on separate pages are listed chronologically on every page", async () => {
  const instance = await conflictApp(conflictFixture(31, [31, 2, 15]));
  const expected = [2, 15, 31].map(conflictDate);
  assert.deepEqual(conflictDates(instance), expected);
  jump(instance, 31); instance.flushFrames(); assert.deepEqual(conflictDates(instance), expected);
  assert.equal(instance.get("#csv-conflict-heading").textContent, "競合している記録：3日");
});

test("jump from first to last page opens the right details then scrolls after rendering", async () => {
  const instance = await conflictApp(); const target = jump(instance, 31);
  assert.equal(instance.get("#csv-page-label").textContent, "31〜31／31");
  assert.equal(target.details.open, true); assert.equal(target.card.scrollCalls.length, 0);
  instance.flushFrames();
  assert.equal(target.card.scrollCalls.length, 1); assert.equal(target.card.scrollCalls[0].block, "start");
  assert.equal(target.heading.focusCalls[0].preventScroll, true);
});

test("jump from last to first page locates the exact date", async () => {
  const instance = await conflictApp(); jump(instance, 31); instance.flushFrames();
  const target = jump(instance, 2); instance.flushFrames();
  assert.equal(instance.get("#csv-page-label").textContent, "1〜10／31");
  assert.equal(target.card.dataset.conflictDate, conflictDate(2)); assert.equal(target.details.open, true);
  assert.equal(target.card.scrollCalls.length, 1);
});

test("multiple conflicts on the same page each open and scroll without changing page", async () => {
  const instance = await conflictApp(conflictFixture(10, [2, 5]));
  const first = jump(instance, 2); instance.flushFrames(); const second = jump(instance, 5); instance.flushFrames();
  assert.equal(instance.get("#csv-page-label").textContent, "1〜10／10");
  assert.equal(first.details.open, true); assert.equal(second.details.open, true);
  assert.equal(first.card.scrollCalls.length, 1); assert.equal(second.card.scrollCalls.length, 1);
});

test("jump changes only position; replacement choices still update exact counts", async () => {
  const instance = await conflictApp(conflictFixture(31, [2, 15, 31], [10]));
  const original = instance.store.raw, before = instance.get("#restore-totals").textContent;
  const target = jump(instance, 15); instance.flushFrames();
  assert.equal(instance.get("#restore-totals").textContent, before);
  target.choice.value = "replace"; target.choice.events.change();
  assert.match(instance.get("#restore-totals").textContent, /追加27件・置換1件・スキップ3件（うち一致1件）/);
  assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
});

test("A to B to A preserves replacement, differences, backup and final confirmation", async () => {
  const instance = await conflictApp(); const first = jump(instance, 2); instance.flushFrames();
  const diffText = descendants(first.details, (node) => node.tag === "code").map((node) => node.textContent);
  first.choice.value = "replace"; first.choice.events.change(); await ready(instance);
  const totals = instance.get("#restore-totals").textContent;
  jump(instance, 31); instance.flushFrames(); const returned = jump(instance, 2); instance.flushFrames();
  assert.equal(returned.choice.value, "replace");
  assert.deepEqual(descendants(returned.details, (node) => node.tag === "code").map((node) => node.textContent), diffText);
  assert.equal(instance.get("#restore-totals").textContent, totals);
  assert.equal(instance.get("#restore-backup-confirm").checked, true); assert.equal(instance.get("#restore-final-confirm").checked, true);
  assert.equal(instance.store.writes, 0);
});

test("standing-only inclusion survives jumps and normal page navigation", async () => {
  const fixture = conflictFixture(); fixture.rows[0] = row("3/1", { 6: "10" });
  const instance = await conflictApp(fixture);
  const checkbox = descendants(instance.get("#csv-rows"), (node) => node.type === "checkbox")[0];
  checkbox.checked = true; checkbox.events.change();
  const totals = instance.get("#restore-totals").textContent;
  jump(instance, 31); instance.flushFrames(); jump(instance, 2); instance.flushFrames();
  assert.equal(descendants(instance.get("#csv-rows"), (node) => node.type === "checkbox")[0].checked, true);
  instance.get("#csv-page-next").click(); instance.get("#csv-page-prev").click();
  assert.equal(descendants(instance.get("#csv-rows"), (node) => node.type === "checkbox")[0].checked, true);
  assert.equal(instance.get("#restore-totals").textContent, totals);
});

test("ordinary next/previous page buttons retain jump-selected replacement", async () => {
  const instance = await conflictApp(); const target = jump(instance, 15); instance.flushFrames();
  target.choice.value = "replace"; target.choice.events.change();
  instance.get("#csv-page-next").click(); instance.get("#csv-page-prev").click();
  assert.equal(conflictCard(instance, 15).choice.value, "replace");
  assert.equal(instance.get("#csv-page-label").textContent, "11〜20／31");
});

test("jump uses full CSV positions including unrecorded and out-of-period rows", async () => {
  const fixture = conflictFixture(); for (let index = 0; index < 10; index++) fixture.rows[index] = row(`3/${index + 1}`);
  const instance = await conflictApp(fixture);
  instance.get("#csv-start-date").value = "2032-03-11"; instance.get("#csv-start-date").events.input();
  instance.get("#csv-year-confirm").checked = true; instance.get("#csv-preview-button").click();
  assert.deepEqual(conflictDates(instance), [15, 31].map(conflictDate));
  jump(instance, 15); instance.flushFrames(); assert.equal(instance.get("#csv-page-label").textContent, "11〜20／31");
});

test("cancel clears all links and cancels a queued scroll without writing", async () => {
  const instance = await conflictApp(), original = instance.store.raw;
  const oldLink = conflictLinks(instance).at(-1), target = jump(instance, 31);
  instance.get("#restore-cancel").click(); instance.flushFrames(); oldLink.click();
  assert.equal(instance.get("#csv-conflict-index").hidden, true); assert.deepEqual(conflictDates(instance), []);
  assert.equal(target.card.scrollCalls.length, 0); assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
});

test("CSV re-selection cannot reuse dates or handlers from a previous file", async () => {
  const instance = await conflictApp(), oldLink = conflictLinks(instance).at(-1);
  instance.get("#restore-cancel").click(); await select(instance, csvFile([row("3/15", { 6: "12", 12: "52" })]));
  assert.deepEqual(conflictDates(instance), []); preview(instance); assert.deepEqual(conflictDates(instance), [conflictDate(15)]);
  oldLink.click(); assert.equal(instance.get("#csv-page-label").textContent, "1〜1／1"); assert.equal(instance.store.writes, 0);
});

test("year changes clear old index and rebuild only current year conflicts", async () => {
  const instance = await conflictApp(), oldLink = conflictLinks(instance).at(-1);
  instance.get("#csv-year").value = "2033"; instance.get("#csv-year").events.input();
  assert.deepEqual(conflictDates(instance), []);
  instance.get("#csv-start-date").value = "2033-01-01"; instance.get("#csv-end-date").value = "2033-12-31";
  instance.get("#csv-year-confirm").checked = true; instance.get("#csv-preview-button").click();
  assert.deepEqual(conflictDates(instance), []); assert.equal(instance.get("#csv-conflict-index").hidden, true);
  oldLink.click(); assert.equal(instance.get("#csv-page-label").textContent, "1〜10／31"); assert.equal(instance.store.writes, 0);
});

test("period changes rebuild the index and reject an old out-of-period jump", async () => {
  const instance = await conflictApp(), oldLink = conflictLinks(instance).at(-1);
  instance.get("#csv-end-date").value = "2032-03-10"; instance.get("#csv-end-date").events.input();
  assert.deepEqual(conflictDates(instance), []);
  instance.get("#csv-year-confirm").checked = true; instance.get("#csv-preview-button").click();
  assert.deepEqual(conflictDates(instance), [conflictDate(2)]); oldLink.click();
  assert.equal(instance.get("#csv-page-label").textContent, "1〜10／31"); assert.equal(instance.store.writes, 0);
});

test("re-preview resets choices safely and invalidates pending scrolls and old handlers", async () => {
  const instance = await conflictApp(), oldLink = conflictLinks(instance).at(-1);
  const target = jump(instance, 31); target.choice.value = "replace"; target.choice.events.change();
  instance.get("#csv-preview-button").click(); instance.flushFrames(); oldLink.click();
  assert.equal(target.card.scrollCalls.length, 0); assert.equal(instance.get("#csv-page-label").textContent, "1〜10／31");
  const current = jump(instance, 31); instance.flushFrames(); assert.equal(current.choice.value, "keep");
  assert.equal(instance.get("#restore-final-confirm").checked, false); assert.equal(instance.store.writes, 0);
});

test("latest jump wins when several links are tapped before the next frame", async () => {
  const instance = await conflictApp(), first = jump(instance, 2), last = jump(instance, 31);
  instance.flushFrames(); assert.equal(first.card.scrollCalls.length, 0); assert.equal(last.card.scrollCalls.length, 1);
  assert.equal(instance.get("#csv-page-label").textContent, "31〜31／31");
});

test("storage update invalidates index and prevents an already queued jump", async () => {
  const instance = await conflictApp(), original = instance.store.raw, target = jump(instance, 15);
  instance.listeners.storage({ key: "exercise-record.entries.v1" }); instance.flushFrames();
  assert.deepEqual(conflictDates(instance), []); assert.equal(target.card.scrollCalls.length, 0);
  assert.equal(instance.store.raw, original); assert.equal(instance.store.writes, 0);
});

test("many conflicts remain accessible through the complete index and reduced-motion scroll", async () => {
  const instance = await conflictApp(conflictFixture(31, Array.from({ length: 31 }, (_value, index) => index + 1)));
  instance.window.matchMedia = () => ({ matches: true });
  assert.equal(conflictLinks(instance).length, 31); instance.get("#csv-conflict-links").scrollTop = 200;
  const target = jump(instance, 31); instance.flushFrames();
  assert.equal(instance.get("#csv-conflict-links").scrollTop, 200);
  assert.equal(target.card.scrollCalls[0].behavior, "auto"); assert.equal(target.details.open, true);
});

test("JSON restore keeps its own conflict UI and never shows the CSV index", async () => {
  const instance = await conflictApp(); instance.get("#restore-cancel").click();
  const file = { text: async () => JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-03-01T00:00:00.000Z", records: { [conflictDate(2)]: day({ standing: 12, weight: "52" }) } }) };
  await instance.get("#restore-file").events.change({ target: { files: [file] } });
  assert.equal(instance.get("#csv-conflict-index").hidden, true); assert.deepEqual(conflictDates(instance), []);
  const choice = descendants(instance.get("#restore-conflicts"), (node) => node.tag === "select")[0];
  assert.equal(choice.value, "keep"); assert.ok(choice.children.some((node) => node.textContent === "バックアップで置換"));
  assert.equal(instance.store.writes, 0);
});
