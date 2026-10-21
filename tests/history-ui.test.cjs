"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { File } = require("node:buffer");
const transfer = require("../record-transfer.js"), csv = require("../numbers-csv.js"), view = require("../history-view.js"), history = require("../record-history.js");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "script.js"), "utf8").replace(/\}\)\(\);\s*$/, "globalThis.hooks = { loadDate, saveCurrentEntry, switchDate, previewBackup, prepareRestoreBackup, applyRestore, cancelRestore };\n})();");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
class Element {
  constructor(tag = "div", attrs = "") {
    this.tag = tag; this.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ""; this.type = /\btype="([^"]*)"/.exec(attrs)?.[1] || "text";
    this.hidden = /\shidden\b/.test(attrs); this.disabled = false; this.checked = false; this.children = []; this.events = {}; this.dataset = {}; this.style = {};
    this.textContent = ""; this.classList = { add() {}, remove() {} }; this.focusCalls = []; this.scrollCalls = [];
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  focus(options) { this.focusCalls.push(options); } blur() {} remove() {}
  scrollIntoView(options) { this.scrollCalls.push(options); }
  click() { return this.events.click?.({ target: this }); }
}
class Input extends Element {}
function app(records = {}, today = "2032-10-19", browserBoot = false, secureContext = true) {
  const elements = new Map(), work = [], steps = [], shared = [], clipboard = [], listeners = {}, frames = [], scrollCalls = [], registrations = [];
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set("#" + match[3], match[1] === "input" ? new Input(match[1], match[2]) : new Element(match[1], match[2]));
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const item = new Element("button", match[1]), w = /data-work="([^"]+)"/.exec(match[1]), s = /data-step="([^"]+)"/.exec(match[1]);
    if (w) { item.dataset.work = w[1]; work.push(item); }
    if (s) { item.dataset.step = s[1]; item.dataset.delta = /data-delta="([^"]+)"/.exec(match[1])[1]; steps.push(item); }
  }
  const get = (selector) => { assert.ok(elements.has(selector), selector); return elements.get(selector); };
  const store = { raw: typeof records === "string" || records === null ? records : JSON.stringify(records), writes: 0, fail: false,
    getItem(key) { assert.equal(key, "exercise-record.entries.v1"); return this.raw; },
    setItem(key, value) { assert.equal(key, "exercise-record.entries.v1"); this.writes++; if (this.fail) throw Error("quota"); this.raw = value; },
    clear() { assert.fail("must not clear records"); }, removeItem() { assert.fail("must not remove records"); } };
  const window = { isSecureContext: secureContext, confirm: () => true, scrollY: 0,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, requestAnimationFrame(fn) { frames.push(fn); },
    scrollTo(options) { scrollCalls.push({ ...options, inputVisible: !get("#input-screen").hidden, date: get("#record-date").value }); this.scrollY = options.top; } };
  const document = { querySelector: get, querySelectorAll: (selector) => selector === "[data-work]" ? work : selector === "[data-step]" ? steps : [],
    createElement: (tag) => new Element(tag), body: { append() {} }, activeElement: null };
  const navigator = { canShare: () => true, share: async (data) => shared.push(data), clipboard: { write: async (data) => clipboard.push(data), writeText: async (data) => clipboard.push(data) },
    serviceWorker: { register: async (url) => { registrations.push(url); } } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [today + "T12:00:00"])); } }
  const context = { window, document, navigator, localStorage: store, RecordTransfer: transfer, NumbersCsv: csv, HTMLInputElement: Input,
    Date: Clock, File, Blob, ClipboardItem: class { constructor(data) { this.data = data; } }, console: { warn() {}, error() {} }, setTimeout() { return 1; }, clearTimeout() {} };
  vm.createContext(context); vm.runInContext(source, context);
  let screen;
  if (browserBoot) {
    const modules = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => new URL(match[1], "http://example.test/exercise-record/").pathname.split("/").at(-1));
    for (const file of modules.filter((name) => ["record-history.js", "history-view.js"].includes(name))) vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    screen = { open: () => get("#history-show").click(), close: () => get("#input-show").click() };
  } else screen = view.mount({ document, window, storage: store, input: window.RecordHistoryInput, today: () => today });
  return { get: (id) => get("#" + id), store, screen, hooks: context.hooks, shared, clipboard, steps, work, window, scrollCalls, registrations,
    flushFrame() { frames.splice(0).forEach((fn) => fn()); },
    flushFrames() { for (let turn = 0; frames.length && turn < 10; turn++) frames.splice(0).forEach((fn) => fn()); assert.equal(frames.length, 0); },
    emit(name, event) { (listeners[name] || []).forEach((fn) => fn(event)); } };
}
function dates(instance) { return instance.get("history-calendar").children.filter((child) => child.tag === "button"); }
function select(instance, date) { const button = dates(instance).find((item) => item.dataset.date === date); assert.ok(button, date); button.click(); }
function text(node) { return [node.textContent, ...node.children.map(text)].join("\n"); }
async function ready(instance) {
  await instance.get("restore-prebackup").click(); instance.get("restore-backup-confirm").checked = true; instance.get("restore-final-confirm").checked = true;
  instance.get("restore-final-confirm").events.change();
}

test("history opens in today's month; input, calendar and details never write", () => {
  const instance = app({ "2032-10-18": day({ squat: 15 }) }), before = instance.store.raw;
  instance.screen.open(); assert.equal(instance.get("history-month").textContent, "2032年10月");
  assert.equal(instance.get("input-screen").hidden, true); assert.equal(instance.get("history-screen").hidden, false);
  select(instance, "2032-10-18"); assert.equal(instance.get("history-detail").hidden, false);
  instance.get("history-detail-close").click(); assert.equal(instance.get("history-detail").hidden, true);
  instance.get("history-month-prev").click(); instance.get("history-month-next").click();
  instance.get("history-list").events.scroll?.(); instance.screen.close();
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});
test("calendar marks saved/default/missing/today/selection without relying on color", () => {
  const instance = app({ "2032-10-18": day(), "2032-10-19": day({ kids: true }) }); instance.screen.open();
  const find = (date) => dates(instance).find((item) => item.dataset.date === date);
  assert.equal(find("2032-10-18").children[1].textContent, "△");
  assert.equal(find("2032-10-19").children[1].textContent, "●");
  assert.equal(find("2032-10-19")["aria-current"], "date");
  select(instance, "2032-10-20"); assert.equal(find("2032-10-20")["aria-pressed"], "true");
  assert.match(find("2032-10-20")["aria-label"], /保存記録なし/);
  assert.equal(instance.store.writes, 0);
});
test("month navigation handles year ends and leap February", () => {
  const instance = app({}, "2032-01-15"); instance.screen.open(); instance.get("history-month-prev").click();
  assert.equal(instance.get("history-month").textContent, "2031年12月"); instance.get("history-month-next").click(); instance.get("history-month-next").click();
  assert.equal(dates(instance).length, 29); assert.equal(instance.store.writes, 0);
});
test("list is monthly and descending, with accurate saved and default counts", () => {
  const instance = app({ "2032-10-18": day(), "2032-10-19": day({ weight: "0" }), "2032-09-30": day() }); instance.screen.open();
  const rows = instance.get("history-list").children;
  assert.deepEqual(rows.map((item) => item.children[0].dataset.date), ["2032-10-19", "2032-10-18"]);
  assert.match(text(instance.get("history-count")), /保存2日[\s\S]*初期値のみの可能性1日/);
  rows[1].children[0].click(); assert.match(instance.get("history-detail-state").textContent, /初期値のみ/);
});
test("all 13 fields retain zeros, empty fields, false and decimal text in 12 display rows", () => {
  const instance = app({ "2032-10-18": day({ weight: "51.2300", bodyFat: "0", distance: "0.00", walkSteps: "0" }) }); instance.screen.open(); select(instance, "2032-10-18");
  const values = instance.get("history-detail-values"); assert.equal(values.children.length, 12);
  const content = text(values); for (const value of ["51.2300 kg", "0 %", "0.00 km", "0 歩", "空欄", "なし"]) assert.ok(content.includes(value), value);
  assert.doesNotMatch(content, /文字列|数値|真偽値|OFF（false）/);
  assert.equal(instance.store.writes, 0);
});
test("partial, invalid and missing records show original states without supplementation", () => {
  const instance = app({ "2032-10-18": { weight: "0" }, "2032-10-19": day({ weight: 0 }) }), before = instance.store.raw;
  instance.screen.open(); select(instance, "2032-10-18"); assert.match(text(instance.get("history-detail-values")), /項目なし/);
  assert.equal(instance.get("history-edit").hidden, true);
  select(instance, "2032-10-19"); assert.match(text(instance.get("history-detail-values")), /不正な値：0（number）/);
  select(instance, "2032-10-20"); assert.match(text(instance.get("history-detail-values")), /保存記録はありません/);
  assert.equal(instance.get("history-edit").hidden, true); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});
test("empty storage permits browsing without generating records", () => {
  for (const initial of [null, {}]) {
    const instance = app(initial), before = instance.store.raw; instance.screen.open(); select(instance, "2032-10-20");
    assert.match(text(instance.get("history-count")), /保存0日/); instance.screen.close();
    assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  }
});
test("corrupt storage and read failures show safe errors, never initialize", () => {
  for (const raw of ["{broken", "[]", '{"2032-02-30":{}}']) {
    const instance = app(raw); instance.screen.open(); assert.equal(instance.get("history-status").dataset.error, "true");
    assert.equal(dates(instance).length, 0); instance.screen.close(); assert.equal(instance.store.raw, raw); assert.equal(instance.store.writes, 0);
  }
  const instance = app(); instance.store.getItem = () => { throw Error("denied"); }; instance.screen.open();
  assert.match(instance.get("history-status").textContent, /denied/); assert.equal(instance.store.writes, 0);
});
test("opening a saved day in input bypasses save-on-switch and preserves all records", () => {
  const instance = app({ "2032-10-18": day({ squat: 15, weight: "51.2" }) }), before = instance.store.raw;
  instance.screen.open(); select(instance, "2032-10-18"); instance.get("history-edit").click();
  assert.equal(instance.get("history-screen").hidden, true); assert.equal(instance.get("record-date").value, "2032-10-18");
  assert.equal(instance.get("squat-value").value, "15回"); assert.equal(instance.get("weight").value, "51.2");
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});
test("unsaved input blocks browsing without losing the current form", () => {
  const instance = app(); instance.get("weight").value = "51.25"; instance.store.fail = true; instance.hooks.saveCurrentEntry();
  const writes = instance.store.writes; instance.screen.open();
  assert.equal(instance.get("history-screen").hidden, true); assert.equal(instance.get("weight").value, "51.25");
  assert.equal(instance.store.writes, writes); assert.match(instance.get("toast").textContent, /未保存/);
});
test("hidden input cannot save or switch dates while browsing", () => {
  const instance = app({ "2032-10-18": day() }), before = instance.store.raw; instance.screen.open();
  const date = instance.get("record-date").value; instance.hooks.saveCurrentEntry(); instance.hooks.switchDate("2032-10-18");
  assert.equal(instance.get("record-date").value, date); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});
test("input changes appear when history is reopened", () => {
  const instance = app({ "2032-10-18": day() }); instance.hooks.loadDate("2032-10-18");
  instance.get("weight").value = "52.300"; instance.hooks.saveCurrentEntry(); const writes = instance.store.writes;
  instance.screen.open(); select(instance, "2032-10-18"); assert.match(text(instance.get("history-detail-values")), /52.300 kg/);
  instance.screen.close(); instance.screen.open(); assert.equal(instance.store.writes, writes);
});
test("storage notifications and PWA resume refresh read-only history", () => {
  const instance = app(); instance.screen.open();
  instance.store.raw = JSON.stringify({ "2032-10-18": day({ walkSteps: "0" }) }); instance.emit("storage", { key: "exercise-record.entries.v1" });
  assert.match(text(instance.get("history-count")), /保存1日/);
  instance.store.raw = JSON.stringify({ "2032-10-18": day(), "2032-10-19": day() }); instance.emit("pageshow");
  assert.match(text(instance.get("history-count")), /保存2日/); assert.equal(instance.store.writes, 0);
});
test("stale snapshots cannot be opened as an old input form", () => {
  const instance = app({ "2032-10-18": day({ weight: "50" }) }); instance.screen.open(); select(instance, "2032-10-18");
  instance.store.raw = JSON.stringify({ "2032-10-18": day({ weight: "51" }) }); instance.get("history-edit").click();
  assert.equal(instance.get("history-screen").hidden, false); assert.match(instance.get("history-status").textContent, /変わりました/);
  assert.match(text(instance.get("history-detail-values")), /51 kg/); assert.equal(instance.store.writes, 0);
});
test("returning to input reloads an external update without writing stale values", () => {
  const instance = app({ "2032-10-18": day({ weight: "50" }) }); instance.hooks.loadDate("2032-10-18"); instance.screen.open();
  instance.store.raw = JSON.stringify({ "2032-10-18": day({ weight: "51" }) }); instance.screen.close();
  assert.equal(instance.get("weight").value, "51"); assert.equal(instance.store.writes, 0);
});
test("JSON restore preview cannot overlap history and restored records appear after completion", async () => {
  const instance = app();
  const file = { text: async () => JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-10-19T00:00:00.000Z", records: { "2032-10-18": day({ weight: "51" }) } }) };
  await instance.hooks.previewBackup(file); assert.equal(instance.get("history-show").disabled, true);
  instance.screen.open(); assert.equal(instance.get("history-screen").hidden, true);
  await ready(instance); instance.get("restore-apply").click(); const writes = instance.store.writes;
  assert.equal(writes, 1); instance.screen.open(); select(instance, "2032-10-18");
  assert.match(text(instance.get("history-detail-values")), /51 kg/); assert.equal(instance.store.writes, writes);
});
test("CSV imported records become visible without a second write", async () => {
  const instance = app(), cells = Array(15).fill(""); cells[1] = cells[11] = "10/18"; cells[6] = "12"; cells[12] = "51.00";
  const document = [csv.HEADERS.join(","), cells.join(",")].join("\n");
  await instance.get("csv-file").events.change({ target: { files: [{ name: "fictional.csv", arrayBuffer: async () => new TextEncoder().encode(document).buffer }] } });
  instance.get("csv-year").value = "2032"; instance.get("csv-start-date").value = "2032-10-01"; instance.get("csv-end-date").value = "2032-10-31";
  instance.get("csv-year-confirm").checked = true; instance.get("csv-preview-button").click();
  await ready(instance); instance.get("restore-apply").click(); assert.equal(instance.store.writes, 1);
  instance.screen.open(); select(instance, "2032-10-18"); assert.match(text(instance.get("history-detail-values")), /51.00 kg/); assert.equal(instance.store.writes, 1);
});
test("normal input, dates, four copies and backup survive history navigation", async () => {
  const instance = app({ "2032-10-18": day({ squat: 10 }) }); instance.screen.open(); select(instance, "2032-10-18"); instance.get("history-edit").click();
  instance.steps.find((item) => item.dataset.step === "squat" && item.dataset.delta === "5").click();
  assert.equal(JSON.parse(instance.store.raw)["2032-10-18"].squat, 15);
  instance.get("next-day").click(); assert.equal(instance.get("record-date").value, "2032-10-19");
  for (const id of ["copy-exercise", "copy-body", "copy-weekly", "copy-weekly-body"]) await instance.get(id).click();
  assert.equal(instance.clipboard.length, 4); assert.deepEqual(Object.keys(instance.clipboard[0][0].data), ["text/html", "text/plain"]);
  assert.equal((await instance.clipboard[0][0].data["text/plain"].text()).split("\t").length, 9);
  assert.equal((await instance.clipboard[1][0].data["text/plain"].text()).split("\t").length, 3);
  const writes = instance.store.writes; await instance.get("backup-export").click();
  assert.equal(JSON.parse(await instance.shared.at(-1).files[0].text()).records["2032-10-18"].squat, 15); assert.equal(instance.store.writes, writes);
});
test("browser script order automatically mounts the history UI against the existing input bridge", () => {
  const instance = app({ "2032-10-18": day({ weight: "51" }) }, "2032-10-19", true);
  instance.screen.open(); assert.equal(instance.get("history-month").textContent, "2032年10月");
  select(instance, "2032-10-18"); instance.get("history-edit").click();
  assert.equal(instance.get("record-date").value, "2032-10-18"); assert.equal(instance.store.writes, 0);
});
test("closing a detail returns focus and scroll to the calendar", () => {
  const instance = app(); instance.screen.open(); instance.get("history-detail-close").click();
  assert.equal(instance.get("history-month").scrollCalls.at(-1).block, "start"); assert.equal(instance.store.writes, 0);
});
test("history layout is scoped, bounded to seven columns and has no fixed horizontal width", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.history-weekdays, \.history-calendar\s*\{[^}]*repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.history-day\s*\{[^}]*min-width: 0[^}]*min-height: 52px/);
  assert.match(css, /#history-screen\[hidden\]/);
  assert.ok(html.indexOf('id="history-calendar"') < html.indexOf('id="history-list"'));
  assert.ok(html.indexOf('id="history-list"') < html.indexOf('id="history-detail"'));
});

const walkTimeCases = [
  ["minutes and seconds", "27", "15", "27分15秒"],
  ["another complete time", "12", "34", "12分34秒"],
  ["minutes only", "27", "", "27分"],
  ["seconds only", "", "15", "15秒"],
  ["both explicit zero", "0", "0", "0分0秒"],
  ["zero minutes only", "0", "", "0分"],
  ["zero seconds only", "", "0", "0秒"],
  ["both blank", "", "", "空欄"],
  ["leading zeros unchanged", "027", "015", "027分015秒"],
  ["valid integer decimal strings unchanged", "27.0", "15.0", "27.0分15.0秒"]
];
for (const [name, minutes, seconds, expected] of walkTimeCases) {
  test(`single walk time row: ${name}`, () => {
    const records = { "2032-10-18": day({ walkMinutes: minutes, walkSeconds: seconds, distance: "1.2300", walkSteps: "2500" }) };
    const instance = app(records), before = instance.store.raw;
    instance.screen.open(); select(instance, "2032-10-18");
    const rows = instance.get("history-detail-values").children;
    const timeRows = rows.filter((row) => row.children[0]?.textContent === "散歩・時間");
    assert.equal(timeRows.length, 1); assert.equal(timeRows[0].children[1].textContent, expected);
    assert.equal(timeRows[0].children[1].children.length, 0);
    assert.deepEqual(rows.filter((row) => row.children[0]?.textContent.startsWith("散歩・")).map((row) => row.children[0].textContent), ["散歩・時間", "散歩・距離", "散歩・歩数"]);
    assert.equal(rows.find((row) => row.children[0].textContent === "散歩・距離").children[1].textContent, "1.2300 km");
    assert.equal(rows.find((row) => row.children[0].textContent === "散歩・歩数").children[1].textContent, "2500 歩");
    assert.equal(history.describe(records, "2032-10-18").fields.length, 13);
    instance.screen.close();
    assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
    const saved = JSON.parse(instance.store.raw)["2032-10-18"];
    assert.equal(saved.walkMinutes, minutes); assert.equal(saved.walkSeconds, seconds);
    assert.equal(typeof saved.walkMinutes, "string"); assert.equal(typeof saved.walkSeconds, "string");
  });
}

test("combined time retains invalid values, types and missing-field warnings", () => {
  const cases = [
    [day({ walkMinutes: "1.5", walkSeconds: "15" }), /分：不正な値："1.5"（string）/],
    [day({ walkMinutes: "27", walkSeconds: "59.5" }), /秒：不正な値："59.5"（string）/],
    [day({ walkSeconds: "60" }), /秒：不正な値："60"（string）/],
    [day({ walkMinutes: 0 }), /分：不正な値：0（number）/],
    [day({ walkSeconds: false }), /秒：不正な値：false（boolean）/],
    [day({ walkMinutes: undefined, walkSeconds: "15" }), /分：項目なし（補完していません）.*秒：15 秒/],
    [day({ walkMinutes: "27", walkSeconds: undefined }), /分：27 分.*秒：項目なし（補完していません）/],
    [day({ walkMinutes: undefined, walkSeconds: undefined }), /分：項目なし（補完していません）.*秒：項目なし（補完していません）/]
  ];
  for (const [entry, expected] of cases) {
    const instance = app({ "2032-10-18": entry }), before = instance.store.raw;
    instance.screen.open(); select(instance, "2032-10-18");
    const row = instance.get("history-detail-values").children.find((item) => item.children[0]?.textContent === "散歩・時間");
    assert.match(row.children[1].textContent, expected);
    assert.match(instance.get("history-detail-state").textContent, /要確認/); assert.equal(instance.get("history-edit").hidden, true);
    assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  }
});

test("opening saved input scrolls to page top only after the input screen has rendered", () => {
  const instance = app({ "2032-10-18": day({ work: "在宅", squat: 15, weight: "51.2300" }) }), before = instance.store.raw;
  instance.screen.open(); select(instance, "2032-10-18"); instance.window.scrollY = 1400;
  instance.get("history-edit").click();
  assert.equal(instance.get("input-screen").hidden, false); assert.equal(instance.get("record-date").value, "2032-10-18");
  assert.equal(instance.get("weight").value, "51.2300"); assert.equal(instance.get("squat-value").value, "15回");
  assert.equal(instance.scrollCalls.length, 0); instance.flushFrame(); assert.equal(instance.scrollCalls.length, 0);
  instance.flushFrame(); assert.equal(instance.scrollCalls.length, 1);
  assert.deepEqual(instance.scrollCalls[0], { top: 0, left: 0, behavior: "auto", inputVisible: true, date: "2032-10-18" });
  assert.equal(instance.window.scrollY, 0); assert.equal(instance.get("record-date").focusCalls.length, 0);
  for (const id of ["walk-minutes", "walk-seconds", "distance", "weight"]) assert.equal(instance.get(id).focusCalls.length, 0);
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});

test("ordinary input/date navigation and history month selection do not get page-top scrolling", () => {
  const instance = app({ "2032-10-18": day() }); instance.screen.open(); select(instance, "2032-10-18");
  instance.get("history-month-prev").click(); instance.get("history-month-next").click(); instance.flushFrames();
  assert.equal(instance.scrollCalls.length, 0); instance.screen.close(); instance.flushFrames();
  assert.equal(instance.scrollCalls.length, 0);
  instance.get("previous-day").click(); instance.get("next-day").click(); instance.flushFrames();
  assert.equal(instance.scrollCalls.length, 0);
});

test("a queued page-top scroll is cancelled if history reopens before painting", () => {
  const instance = app({ "2032-10-18": day() }); instance.screen.open(); select(instance, "2032-10-18");
  instance.get("history-edit").click(); instance.screen.open(); instance.flushFrames();
  assert.equal(instance.get("history-screen").hidden, false); assert.equal(instance.scrollCalls.length, 0); assert.equal(instance.store.writes, 0);
});

test("missing, invalid and stale records never navigate or queue a page-top scroll", () => {
  for (const entry of [null, day({ walkSeconds: "60" }), day()]) {
    const instance = app(entry === null ? {} : { "2032-10-18": entry }); instance.screen.open(); select(instance, "2032-10-18");
    if (entry && entry.walkSeconds === "") instance.store.raw = JSON.stringify({ "2032-10-18": day({ weight: "52" }) });
    const before = instance.store.raw; instance.get("history-edit").click(); instance.flushFrames();
    assert.equal(instance.get("history-screen").hidden, false); assert.equal(instance.scrollCalls.length, 0);
    assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  }
});

test("page-top scroll has a timer fallback when animation-frame scheduling is unavailable", async () => {
  const instance = app({ "2032-10-18": day() }); instance.window.requestAnimationFrame = undefined;
  instance.screen.open(); select(instance, "2032-10-18"); instance.get("history-edit").click();
  assert.equal(instance.scrollCalls.length, 0); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.scrollCalls.length, 1); assert.equal(instance.scrollCalls[0].behavior, "auto"); assert.equal(instance.store.writes, 0);
});

function detailValue(instance, label) {
  const row = instance.get("history-detail-values").children.find((item) => item.tag === "dl" && item.children[0].textContent === label);
  assert.ok(row, label); return row.children[1];
}

test("normal string details contain values only, not type-label elements", () => {
  const instance = app({ "2032-10-18": day({ work: "出社", weight: "51.2300", bodyFat: "16.50", basal: "1234" }) });
  instance.screen.open(); select(instance, "2032-10-18");
  for (const [label, expected] of [["勤務区分", "出社"], ["体重", "51.2300 kg"], ["体脂肪率", "16.50 %"], ["基礎代謝", "1234 kcal"]]) {
    const value = detailValue(instance, label); assert.equal(value.textContent, expected); assert.equal(value.children.length, 0);
  }
  assert.doesNotMatch(text(instance.get("history-detail-values")), /文字列|数値|真偽値/); assert.equal(instance.store.writes, 0);
});

test("normal numeric details keep zero, values and units without type-label elements", () => {
  const instance = app({ "2032-10-18": day({ standing: 15, squat: 0, march: 2, plank: 60 }) });
  instance.screen.open(); select(instance, "2032-10-18");
  for (const [label, expected] of [["スタンディング", "15"], ["スクワット", "0 回"], ["足踏み", "2 回"], ["プランク", "60 秒"]]) {
    const value = detailValue(instance, label); assert.equal(value.textContent, expected); assert.equal(value.children.length, 0);
  }
  assert.equal(instance.store.writes, 0);
});

test("valid booleans display presence/absence and stay booleans in unchanged storage", () => {
  for (const kids of [false, true]) {
    const instance = app({ "2032-10-18": day({ kids }) }), before = instance.store.raw;
    instance.screen.open(); select(instance, "2032-10-18");
    const value = detailValue(instance, "子供と動く"); assert.equal(value.textContent, kids ? "あり" : "なし"); assert.equal(value.children.length, 0);
    instance.screen.close(); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
    assert.equal(JSON.parse(instance.store.raw)["2032-10-18"].kids, kids);
    assert.equal(typeof JSON.parse(instance.store.raw)["2032-10-18"].kids, "boolean");
  }
});

test("all thirteen source fields remain intact across twelve compact detail rows", () => {
  const entry = day({ work: "在宅", kids: false, standing: 15, squat: 10, march: 2, plank: 90,
    walkMinutes: "27", walkSeconds: "15", distance: "1.2300", walkSteps: "2500", weight: "51.2300", bodyFat: "0", basal: "" });
  const instance = app({ "2032-10-18": entry }), before = instance.store.raw;
  instance.screen.open(); select(instance, "2032-10-18");
  const expected = [["勤務区分", "在宅"], ["子供と動く", "なし"], ["スタンディング", "15"], ["スクワット", "10 回"], ["足踏み", "2 回"], ["プランク", "90 秒"],
    ["散歩・時間", "27分15秒"], ["散歩・距離", "1.2300 km"], ["散歩・歩数", "2500 歩"], ["体重", "51.2300 kg"], ["体脂肪率", "0 %"], ["基礎代謝", "空欄"]];
  const rows = instance.get("history-detail-values").children;
  assert.deepEqual(rows.map((row) => row.children.map((cell) => cell.textContent)), expected);
  assert(rows.every((row) => row.children[1].children.length === 0));
  assert.equal(history.describe({ "2032-10-18": entry }, "2032-10-18").fields.length, 13);
  instance.get("history-edit").click(); instance.flushFrames();
  assert.equal(instance.window.scrollY, 0); assert.equal(instance.get("record-date").value, "2032-10-18");
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});

test("removing normal labels never hides missing-field or invalid-type warnings", () => {
  for (const [entry, label, expected] of [
    [day({ weight: 0 }), "体重", /不正な値：0（number）/],
    [day({ kids: "false" }), "子供と動く", /不正な値："false"（string）/],
    [day({ kids: undefined }), "子供と動く", /項目なし（補完していません）/],
    [day({ weight: undefined }), "体重", /項目なし（補完していません）/],
    [day({ walkMinutes: "1.5", walkSeconds: "0" }), "散歩・時間", /分：不正な値："1.5"（string）.*秒：0 秒/],
    [day({ walkMinutes: undefined, walkSeconds: "15" }), "散歩・時間", /分：項目なし（補完していません）.*秒：15 秒/]
  ]) {
    const instance = app({ "2032-10-18": entry }), before = instance.store.raw;
    instance.screen.open(); select(instance, "2032-10-18");
    assert.match(detailValue(instance, label).textContent, expected);
    assert.match(instance.get("history-detail-state").textContent, /要確認/);
    assert.match(text(instance.get("history-detail-values")), /入力画面への移動を停止/);
    assert.equal(instance.get("history-edit").hidden, true); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  }
});

test("detail styles reserve no row or spacing for removed type labels", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.doesNotMatch(css, /\.history-value small\s*\{/);
  assert.match(css, /\.history-value\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1.1fr\)[^}]*column-gap: 10px/);
  assert.match(css, /\.history-value\s*\{[^}]*padding: 8px 0[^}]*overflow-wrap: anywhere/);
});

test("history renderer and stylesheet have resource version URLs independent of the HTML query", () => {
  const scriptRef = /<script src="(history-view\.js[^"]*)"/.exec(html)[1];
  const cssRef = /<link rel="stylesheet" href="([^"]+)"/.exec(html)[1];
  for (const [reference, file] of [[scriptRef, "history-view.js"], [cssRef, "style.css"]]) {
    const normal = new URL(reference, "http://example.test/exercise-record/");
    const htmlQuery = new URL(reference, "http://example.test/exercise-record/?ui-check=20261020");
    assert.equal(normal.href, htmlQuery.href); assert.ok(normal.searchParams.get("v"));
    assert.notEqual(normal.href, new URL(file, "http://example.test/exercise-record/").href);
    assert.equal(normal.pathname, `/exercise-record/${file}`);
  }
});

test("versioned history renderer is used by browser initialization and shows no normal type labels", () => {
  const instance = app({ "2032-10-18": day({ kids: false, squat: 15, weight: "51.20" }) }, "2032-10-19", true), before = instance.store.raw;
  instance.screen.open(); select(instance, "2032-10-18");
  assert.equal(detailValue(instance, "子供と動く").textContent, "なし");
  assert.equal(detailValue(instance, "スクワット").textContent, "15 回");
  assert.doesNotMatch(text(instance.get("history-detail-values")), /文字列|数値|真偽値|OFF（false）/);
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});

test("an insecure HTTP context does not register the Service Worker", () => {
  for (const secure of [false, true]) {
    const instance = app({}, "2032-10-19", false, secure); instance.emit("load");
    assert.deepEqual(instance.registrations, secure ? ["./service-worker.js"] : []);
    assert.equal(instance.store.writes, 0);
  }
});

test("offline cache includes exact versioned asset URLs and keeps the existing cache lifecycle", async () => {
  const origin = "https://example.test/exercise-record/", events = {}, saved = new Map(), deleted = [];
  const httpCache = new Map([[new URL("script.js", origin).href, "old public input script"]]);
  const downloads = [];
  class WorkerRequest extends Request {
    constructor(reference, options) { super(new URL(reference, origin), options); }
  }
  let pending, networkCalls = 0, skipped = false, claimed = false;
  const self = { location: { origin: "https://example.test" }, addEventListener: (type, fn) => { events[type] = fn; },
    skipWaiting: () => { skipped = true; }, clients: { claim: () => { claimed = true; } } };
  const cache = { addAll: async (files) => {
    for (const reference of files) {
      assert(reference instanceof WorkerRequest);
      assert.equal(reference.cache, "reload");
      const url = new URL(reference.url);
      const file = url.pathname.slice("/exercise-record/".length) || "index.html";
      // Model a fresh HTTP cache: default requests can return the old input bridge.
      const body = reference.cache === "default" && httpCache.has(url.href)
        ? httpCache.get(url.href) : fs.readFileSync(path.join(root, file), "utf8");
      httpCache.set(url.href, body); downloads.push(url.href);
      saved.set(url.href, { ok: true, body });
    }
  } };
  const caches = { open: async (name) => { assert.equal(name, "exercise-record-v17"); return cache; },
    keys: async () => ["exercise-record-v16", "exercise-record-v17", "other-cache"], delete: async (name) => { deleted.push(name); },
    match: async (request) => saved.get(request.url) };
  const context = { self, caches, URL, Request: WorkerRequest, fetch: async () => { networkCalls++; throw Error("offline"); } };
  Object.defineProperty(context, "localStorage", { get() { assert.fail("Service Worker must not access records"); } });
  vm.runInNewContext(fs.readFileSync(path.join(root, "service-worker.js"), "utf8"), context);
  events.install({ waitUntil: (promise) => { pending = promise; } }); await pending;
  assert.equal(httpCache.get(new URL("script.js", origin).href), fs.readFileSync(path.join(root, "script.js"), "utf8"));
  assert.equal(downloads.length, 11);
  const refs = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]);
  refs.push(/<link rel="stylesheet" href="([^"]+)"/.exec(html)[1]);
  for (const reference of refs) {
    const url = new URL(reference, origin);
    events.fetch({ request: { method: "GET", url: url.href }, respondWith: (promise) => { pending = promise; } });
    const response = await pending; assert.equal(response.ok, true);
    assert.equal(response.body, fs.readFileSync(path.join(root, url.pathname.slice("/exercise-record/".length)), "utf8"));
  }
  assert.equal(networkCalls, 0);
  events.activate({ waitUntil: (promise) => { pending = promise; } }); await pending;
  assert.deepEqual(deleted, ["exercise-record-v16"]); assert(skipped && claimed);
});


function listButton(instance, date) {
  return instance.get("history-list").children.map((item) => item.children[0]).find((button) => button.dataset?.date === date);
}
function joined(node) { return text(node).replace(/\n/g, ""); }

for (const [name, entry, expected] of [
  ["saved", day({ kids: true }), "● 保存済み"],
  ["default-only", day(), "△ 初期値のみの可能性"],
  ["review", day({ weight: 0 }), "! 要確認"]
]) {
  test(`monthly header groups date and unchanged state: ${name}`, () => {
    const instance = app({ "2032-10-18": entry }), before = instance.store.raw;
    instance.screen.open();
    const button = listButton(instance, "2032-10-18"), header = button.children[0];
    assert.equal(header.className, "history-list-header");
    assert.equal(header.children[0].tag, "strong"); assert.equal(header.children[0].textContent, "2032/10/18（月）");
    assert.equal(header.children[1].textContent, expected);
    button.click(); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  });
}

test("monthly count renders two explicit rows with all four real counts", () => {
  const instance = app({ "2032-10-17": day({ kids: true }), "2032-10-18": day(), "2032-10-19": day({ weight: 0 }) });
  instance.screen.open();
  const rows = instance.get("history-count").children;
  assert.equal(rows.length, 2); assert(rows.every((row) => row.className === "history-count-row"));
  assert.deepEqual(rows.map(joined), ["保存3日 / 初期値と異なる保存値1日", "初期値のみの可能性1日 / 要確認1日"]);
  assert(rows.every((row) => row.children[0].children.length === 2 && !joined(row).endsWith("/")));
  assert.equal(instance.store.writes, 0);
});

test("empty month retains both count rows and does not generate a record", () => {
  const instance = app(null); instance.screen.open();
  assert.deepEqual(instance.get("history-count").children.map(joined), ["保存0日 / 初期値と異なる保存値0日", "初期値のみの可能性0日 / 要確認0日"]);
  assert.equal(instance.store.raw, null); assert.equal(instance.store.writes, 0);
});

test("monthly cards have three separate ordered groups and show complete measurement values", () => {
  const instance = app({ "2032-10-18": day({ work: "在宅", march: 1, walkMinutes: "20", walkSeconds: "10", distance: "2.5", walkSteps: "2500", weight: "55.5", bodyFat: "16.5", basal: "1300" }) });
  const before = instance.store.raw; instance.screen.open();
  const button = listButton(instance, "2032-10-18"), groups = button.children.slice(1);
  assert.equal(groups.length, 3); assert(groups.every((group) => group.className === "history-summary-group"));
  assert.deepEqual(groups.map(joined), ["勤務：在宅 / 子供：なし / スタンディング：10", "スクワット：0回 / 足踏み：1回 / プランク：0秒", "散歩：20:10,2.5km,2500歩 / 身体：55.5kg,16.5%"]);
  assert.deepEqual(groups.map((group) => group.children[0].children.length), [3, 3, 2]);
  assert.doesNotMatch(joined(button), /1300|…/);
  button.click(); assert.equal(detailValue(instance, "散歩・時間").textContent, "20分10秒");
  assert.equal(detailValue(instance, "基礎代謝").textContent, "1300 kcal");
  instance.get("history-edit").click(); instance.flushFrames(); assert.equal(instance.window.scrollY, 0);
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});

for (const kids of [true, false]) {
  test(`children are presence/absence in monthly list and details: ${kids}`, () => {
    const instance = app({ "2032-10-18": day({ kids }) }), before = instance.store.raw; instance.screen.open();
    const button = listButton(instance, "2032-10-18");
    assert.match(joined(button.children[1]), kids ? /子供：あり/ : /子供：なし/);
    button.click(); assert.equal(detailValue(instance, "子供と動く").textContent, kids ? "あり" : "なし");
    instance.get("history-month-prev").click(); instance.get("history-month-next").click(); instance.screen.close();
    assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
    assert.equal(typeof JSON.parse(instance.store.raw)["2032-10-18"].kids, "boolean");
  });
}

test("missing and invalid children stay warnings in both views", () => {
  for (const missing of [true, false]) {
    const entry = day({ kids: "false" }); if (missing) delete entry.kids;
    const instance = app({ "2032-10-18": entry }), before = instance.store.raw; instance.screen.open();
    const button = listButton(instance, "2032-10-18"); assert.match(joined(button.children[1]), /子供：要確認/);
    button.click(); assert.match(detailValue(instance, "子供と動く").textContent, missing ? /項目なし/ : /不正な値/);
    assert.equal(instance.get("history-edit").hidden, true); assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
  }
});

test("basal-only records show no listed body values while retaining the detailed basal value", () => {
  const instance = app({ "2032-10-18": day({ basal: "1234" }) }); instance.screen.open();
  const button = listButton(instance, "2032-10-18"); assert.equal(joined(button.children[3]), "散歩：なし / 身体：なし");
  button.click(); assert.equal(detailValue(instance, "基礎代謝").textContent, "1234 kcal"); assert.equal(instance.store.writes, 0);
});

test("long decimal strings are not rounded or elided in monthly cards", () => {
  const instance = app({ "2032-10-18": day({ distance: "1.2345678900", weight: "55.1234567890", bodyFat: "16.1234567890" }) });
  instance.screen.open(); const group = listButton(instance, "2032-10-18").children[3];
  for (const value of ["1.2345678900km", "55.1234567890kg", "16.1234567890%"]) assert(joined(group).includes(value));
  assert.doesNotMatch(joined(group), /…/); assert.equal(instance.store.writes, 0);
});

test("monthly layout wraps whole items and clips only decorative row-edge separators", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.history-list-header\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.history-joined-flow\s*\{[^}]*flex-wrap: wrap[^}]*margin-left: calc\(-1 \* var\(--history-join-gap\)\)/);
  assert.match(css, /\.history-joined-item\s*\{[^}]*min-width: 0[^}]*max-width: calc\(100% - var\(--history-join-gap\)\)[^}]*margin-left: var\(--history-join-gap\)/);
  assert.match(css, /\.history-joined-separator\s*\{[^}]*position: absolute[^}]*right: 100%[^}]*white-space: pre/);
  assert.match(css, /\.history-count-row, \.history-summary-group, \.history-summary-values\s*\{[^}]*overflow: hidden/);
  assert.match(css, /\.history-summary-part\s*\{[^}]*white-space: nowrap/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis|line-clamp/);
});


function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test("monthly separators are separate decoration with exact spaces and no prefix in value text", () => {
  const instance = app({ "2032-10-18": day({ walkMinutes: "27", walkSeconds: "15", distance: "1.98", walkSteps: "2464", weight: "55.5", bodyFat: "16.5" }) });
  instance.screen.open(); const button = listButton(instance, "2032-10-18");
  const groups = button.children.slice(1), count = instance.get("history-count");
  assert.deepEqual(count.children.map(joined), ["保存1日 / 初期値と異なる保存値1日", "初期値のみの可能性0日 / 要確認0日"]);
  assert.equal(joined(groups[2]), "散歩：27:15,1.98km,2464歩 / 身体：55.5kg,16.5%");
  const all = descendants(button).concat(descendants(count));
  const separators = all.filter((item) => item.className === "history-joined-separator");
  assert.equal(separators.filter((item) => item.textContent === " / ").length, 7);
  assert.equal(separators.filter((item) => item.textContent === ",").length, 3);
  assert(separators.every((item) => item["aria-hidden"] === "true"));
  assert(all.filter((item) => item.className === "history-summary-part").every((item) => !/^[\s/,]|[/,]$/.test(item.textContent)));
  assert.doesNotMatch(joined(groups[2]), /／|、|\s,|,\s/);
  button.click(); assert.equal(detailValue(instance, "散歩・時間").textContent, "27分15秒");
  assert.equal(detailValue(instance, "体重").textContent, "55.5 kg");
  assert.equal(detailValue(instance, "体脂肪率").textContent, "16.5 %");
  assert.equal(instance.store.writes, 0);
});

test("monthly ASCII formatting does not alter detail warning punctuation or saved values", () => {
  const instance = app({ "2032-10-18": day({ walkMinutes: "1.5", walkSeconds: "0", kids: true }) }), before = instance.store.raw;
  instance.screen.open(); const button = listButton(instance, "2032-10-18");
  assert.equal(joined(button.children[3]), "散歩：要確認 / 身体：なし");
  button.click(); assert.match(detailValue(instance, "散歩・時間").textContent, /分：不正な値："1.5"（string） ／ 秒：0 秒/);
  assert.equal(detailValue(instance, "子供と動く").textContent, "あり");
  assert.equal(instance.store.raw, before); assert.equal(instance.store.writes, 0);
});

test("updated monthly assets use one shared new identifier and keep unpublished cache v17", () => {
  const version = "0.3-history-separators-20261021", worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  for (const file of ["record-history.js", "history-view.js", "style.css"]) {
    assert(html.includes(`${file}?v=${version}`)); assert(worker.includes(`./${file}?v=${version}`));
  }
  assert(worker.includes('const CACHE_NAME = "exercise-record-v17"'));
});
