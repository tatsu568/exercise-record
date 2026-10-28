"use strict";
const RecordSave = require("../record-save.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { File } = require("node:buffer");
const transfer = require("../record-transfer.js"), csv = require("../numbers-csv.js"), history = require("../history-view.js");
const navigationModule = require("../app-navigation.js"), graph = require("../graph-view.js"), model = require("../body-graph.js");
const acknowledgements = require("../attention-acknowledgements.js"), appSettings = require("../app-settings.js");
const root = path.join(__dirname, ".."), html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8").replace(/\}\)\(\);\s*$/, "globalThis.hooks={saveCurrentEntry,loadDate,switchDate,previewBackup,previewCsv,applyRestore,cancelRestore};\n})();");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });
const fixture = () => ({ "2032-05-01": day({ weight: "56.2", bodyFat: "16.1" }), "2032-05-02": day({ weight: "56.1" }),
  "2032-05-10": day({ weight: "55.9", bodyFat: "16.5" }) });
const descendants = (element) => [element, ...element.children.flatMap(descendants)];
const text = (element) => [element.textContent, ...element.children.map(text)].join(" ");
const byClass = (element, name) => descendants(element).filter((item) => (item.attrs.class || item.className || "").split(" ").includes(name));

function app(records = fixture(), options = {}) {
  const now = { value: options.today || "2032-05-15" }, viewport = { width: options.width || 375 };
  const elements = new Map(), work = [], steps = [], listeners = {}, frames = [], scrolls = [], copies = [], shares = [];
  class Element {
    constructor(tag = "div", attrs = "") {
      this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.dataset = {}; this.style = {};
      this.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ""; this.type = /\btype="([^"]*)"/.exec(attrs)?.[1] || "text";
      this.hidden = /\shidden\b/.test(attrs); this.disabled = /\sdisabled\b/.test(attrs); this.checked = false; this.textContent = ""; this.focusCalls = [];
      this.classList = { add() {}, remove() {} };
    }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; this.textContent = ""; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name]; }
    focus(args) { this.focusCalls.push(args); document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    remove() {}
    scrollIntoView(args) { scrolls.push(args); }
    getBoundingClientRect() {
      if (this.bounds) return this.bounds;
      return { left: 0, top: 0, width: this.tag === "svg" ? Number(this.attrs.width) : viewport.width - 58,
        height: this.tag === "svg" ? Number(this.attrs.height) : 224 };
    }
    fire(name, event = {}) { let result; for (const fn of this.events[name] || []) result = fn({ target: this, preventDefault() {}, ...event }); return result; }
    click() { if (!this.disabled) return this.fire("click"); }
  }
  class Input extends Element {}
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[3], match[1] === "input" ? new Input(match[1], match[2]) : new Element(match[1], match[2]));
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const button = new Element("button", match[1]), w = /data-work="([^"]+)"/.exec(match[1]), s = /data-step="([^"]+)"/.exec(match[1]);
    if (w) { button.dataset.work = w[1]; work.push(button); }
    if (s) { button.dataset.step = s[1]; button.dataset.delta = /data-delta="([^"]+)"/.exec(match[1])[1]; steps.push(button); }
  }
  const get = (id) => { assert.ok(elements.has(id), id); return elements.get(id); };
  const extras = new Map(Object.entries(options.extras || {}));
  const store = { raw: typeof records === "string" || records === null ? records : JSON.stringify(records), writes: 0, failWrite: false, failRead: false,
    extras, ackWrites: 0, failAckRead: false, failAckWrite: false, failAckVerify: false,
    getItem(key) { if (key === acknowledgements.KEY) { if (this.failAckRead || (this.failAckVerify && this.ackWrites)) throw Error("ack read"); return extras.get(key) ?? null; }
      if (Object.values(appSettings.KEYS).includes(key)) return extras.get(key) ?? null;
      assert.equal(key, "exercise-record.entries.v1"); if (this.failRead) throw Error("read failed"); return this.raw; },
    setItem(key, value) { if (key === acknowledgements.KEY) { if (this.failAckWrite) throw Error("ack quota"); this.ackWrites++; extras.set(key, value); return; }
      assert.equal(key, "exercise-record.entries.v1"); if (this.failWrite) throw Error("quota"); this.writes++; this.raw = value; },
    clear() { assert.fail("no clear"); }, removeItem() { assert.fail("no remove"); } };
  const window = { isSecureContext: true, confirm: () => true, scrollY: 0,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, requestAnimationFrame(fn) { frames.push(fn); },
    scrollTo(args) { this.scrollY = args.top; scrolls.push(args); } };
  const document = { activeElement: null, documentElement: { get clientWidth() { return viewport.width; } },
    querySelector: (selector) => get(selector.slice(1)), querySelectorAll: (selector) => selector === "[data-work]" ? work : selector === "[data-step]" ? steps : [],
    createElement: (tag) => new Element(tag), createElementNS: (namespace, tag) => { assert.equal(namespace, "http://www.w3.org/2000/svg"); return new Element(tag); }, body: { append() {} } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now.value + "T12:00:00"])); } }
  const context = { document, window, localStorage: store, RecordTransfer: transfer, RecordSave, AbortController, NumbersCsv: csv, HTMLInputElement: Input, Date: Clock,
    navigator: { locks: createLocks(), share: async (data) => shares.push(data), canShare: () => true, clipboard: { write: async (data) => copies.push(data), writeText: async (data) => copies.push(data) } },
    File, Blob, ClipboardItem: class { constructor(data) { this.data = data; } }, setTimeout() { return 1; }, clearTimeout() {}, console: { error() {}, warn() {} } };
  vm.createContext(context); vm.runInContext(script, context);
  let nav, graphView, historyView;
  if (options.browserBoot) {
    for (const ref of [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1])) {
      const file = ref.split("?")[0];
      if (["record-transfer.js", "numbers-csv.js", "script.js"].includes(file)) continue;
      vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    }
    nav = context.RecordAppNavigation; graphView = context.RecordGraphView;
  } else {
    nav = navigationModule.mount({ document, input: window.RecordHistoryInput });
    historyView = history.mount({ document, window, storage: store, input: window.RecordHistoryInput, navigation: nav, today: () => now.value });
    graphView = graph.mount({ document, window, storage: store, navigation: nav, today: () => now.value,
      acknowledgementStore: acknowledgements.createStore({ storage: store, locks: options.locks || createLocks(), isSecureContext: true }),
      ...(options.attention ? { getAttentionSettings: options.attention } : {}), ...(options.targets ? { getTargets: options.targets } : {}) });
  }
  return { get, store, nav, graphView, historyView, hooks: context.hooks, now, viewport, steps, copies, shares, window, document, scrolls,
    open() { get("graph-show").click(); }, mode(value) { get("graph-period").value = value; get("graph-period").fire("change"); },
    emit(name, event = {}) { for (const fn of listeners[name] || []) fn(event); },
    flush() { for (let loop = 0; frames.length && loop < 10; loop++) frames.splice(0).forEach((fn) => fn()); assert.equal(frames.length, 0); } };
}
const points = (a, field = "weight") => byClass(a.get(`graph-${field}-plot`), "graph-point");
const attentionFixture = () => ({ "2041-01-01": day({ weight: "60", bodyFat: "16" }), "2041-01-02": day({ weight: "80", bodyFat: "35" }) });
const attentionApp = (options = {}) => app(attentionFixture(), { today: "2041-01-03", ...options });
const toggleAttention = (a, field = "weight") => a.get(`graph-${field}-attention`).children.find(item => item.tag === "button");
const svg = (a, field = "weight") => a.get(`graph-${field}-plot`).children[0];
function select(a, field, index) { svg(a, field).fire("click", { target: points(a, field)[index] }); }
function custom(a, start, end) { a.mode("custom"); a.get("graph-start-date").value = start; a.get("graph-end-date").value = end; a.get("graph-apply-dates").click(); }
function swipe(a, from = [100, 180], to = [220, 185], target = {}) {
  const screen = a.get("graph-screen"), touch = ([clientX, clientY]) => ({ clientX, clientY });
  screen.fire("touchstart", { target, touches: [touch(from)] });
  screen.fire("touchmove", { touches: [touch(to)], preventDefault() { assert.fail("leave scrolling native"); } });
  screen.fire("touchend", { touches: [], changedTouches: [touch(to)] });
}

test("one shared measurement row navigates the union of dates and hides highlights for absent values", () => {
  const a = app({ "2041-01-01": day({ weight: "56.1" }), "2041-01-03": day({ bodyFat: "16.1" }),
    "2041-01-05": day({ weight: "56.2", bodyFat: "16.2" }) }, { today: "2041-01-06" }), before = a.store.raw;
  a.open(); assert.equal(a.graphView.getState().selectedDate, "2041-01-05");
  a.get("graph-point-previous").click(); assert.equal(a.graphView.getState().selectedDate, "2041-01-03");
  assert.equal(a.get("graph-selected").textContent, "2041/1/3　—　16.1%");
  assert.equal(byClass(svg(a, "weight"), "graph-selection")[0].attrs.visibility, "hidden");
  assert.equal(byClass(svg(a, "bodyFat"), "graph-selection")[0].attrs.visibility, "visible");
  a.get("graph-point-previous").click(); assert.equal(a.get("graph-point-previous").disabled, true);
  assert.equal(a.get("graph-selected").textContent, "2041/1/1　56.1kg　—");
  assert.equal(byClass(svg(a, "bodyFat"), "graph-selection")[0].attrs.visibility, "hidden");
  select(a, "bodyFat", 0); assert.equal(a.graphView.getState().selectedDate, "2041-01-03");
  select(a, "weight", 1); assert.equal(a.graphView.getState().selectedDate, "2041-01-05");
  custom(a, "2041-01-01", "2041-01-03"); assert.equal(a.graphView.getState().selectedDate, "2041-01-03");
  assert.equal(a.get("graph-point-next").disabled, true);
  custom(a, "2041-01-02", "2041-01-02"); assert.equal(a.graphView.getState().selectedDate, null);
  assert.equal(a.get("graph-selected").textContent, "記録なし"); assert.equal(a.get("graph-point-previous").disabled, true);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("graph has one single-line selection row after both chart cards and no per-chart measurement controls", () => {
  assert.equal((html.match(/id="graph-selected"/g) || []).length, 1);
  assert.equal((html.match(/>前の測定<\/button>/g) || []).length, 1); assert.equal((html.match(/>次の測定<\/button>/g) || []).length, 1);
  assert.doesNotMatch(html, /id="graph-(?:weight|bodyFat)-(?:selected|previous|next)"/);
  const section = html.slice(html.indexOf('<section id="graph-screen"'), html.indexOf('<section id="summary-screen"'));
  assert.ok(section.indexOf('id="graph-weight-heading"') < section.indexOf('id="graph-bodyFat-heading"'));
  assert.ok(section.indexOf('id="graph-bodyFat-heading"') < section.indexOf('id="graph-selected"'));
  assert.match(section, /id="graph-bodyFat-attention"[^>]*><\/div>\s*<\/section>\s*<section class="card graph-shared-selection" aria-labelledby="graph-selected-heading">\s*<h3 id="graph-selected-heading">選択中の測定<\/h3>\s*<p id="graph-selected"/);
  assert.match(section, /id="graph-selected"[^>]*>[^<]*<\/p>\s*<div class="graph-point-actions">\s*<button id="graph-point-previous"[^>]*>前の測定<\/button>\s*<button id="graph-point-next"[^>]*>次の測定<\/button>\s*<\/div>\s*<\/section>\s*<\/section>/);
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.graph-selected\s*\{[^}]*white-space: nowrap;[^}]*overflow-x: auto/);
  assert.match(html, /<option value="all" selected>/);
});

test("graph swipes reuse period controls, retain manual mode and stop at latest/all/custom or hidden screens", () => {
  const a = app(), before = a.store.raw; a.open(); const all = a.graphView.getState();
  swipe(a); assert.deepEqual(a.graphView.getState(), all);
  a.mode("1m"); swipe(a); assert.equal(a.graphView.getState().offset, -1); assert.equal(a.graphView.getState().mode, "1m");
  swipe(a, [250, 180], [130, 185]); assert.equal(a.graphView.getState().offset, 0);
  swipe(a, [250, 180], [130, 185]); assert.equal(a.graphView.getState().offset, 0);
  assert.equal(a.graphView.getState().selectedDate, "2032-05-10");
  a.mode("custom"); const customState = a.graphView.getState(); swipe(a); assert.deepEqual(a.graphView.getState(), customState);
  a.mode("3m"); a.get("input-show").click(); swipe(a); assert.equal(a.graphView.getState().offset, 0);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("period swipes ignore scrolling, small/diagonal movements, screen edges, controls, plots and multi-touch", () => {
  const a = app(); a.open(); a.mode("3m");
  for (const [from, to, target] of [[[100,180],[104,300]], [[100,180],[160,240]], [[100,180],[135,183]], [[10,180],[130,180]],
    [[365,180],[245,180]], [[100,180],[220,180], { closest(selector) { assert.match(selector, /button/); return {}; } }],
    [[100,180],[220,180], { closest(selector) { assert.match(selector, /\.graph-plot/); return {}; } }]]) {
    swipe(a, from, to, target); assert.equal(a.graphView.getState().offset, 0);
  }
  const screen = a.get("graph-screen");
  screen.fire("touchstart", { touches: [{ clientX:100,clientY:180 }, { clientX:120,clientY:180 }] });
  screen.fire("touchend", { changedTouches: [{ clientX:220,clientY:180 }] }); assert.equal(a.graphView.getState().offset, 0);
  screen.fire("touchstart", { touches: [{ clientX:100,clientY:180 }] }); screen.fire("touchcancel");
  screen.fire("touchend", { changedTouches: [{ clientX:220,clientY:180 }] }); assert.equal(a.graphView.getState().offset, 0);
  swipe(a); screen.fire("touchend", { changedTouches: [{ clientX:220,clientY:180 }] }); assert.equal(a.graphView.getState().offset, -1);
  assert.equal(a.store.writes, 0);
});

test("all six screen transitions show one screen, correct tabs and zero writes", () => {
  const a = app(), before = a.store.raw;
  for (const name of ["history", "graph", "input", "graph", "history", "input"]) {
    a.get(name + "-show").click(); assert.equal(a.nav.current(), name);
    for (const id of ["input", "history", "graph"]) {
      assert.equal(a.get(id + "-screen").hidden, id !== name);
      assert.equal(a.get(id + "-show").attrs["aria-pressed"], String(id === name));
    }
  }
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("attention shows both reasons, counts one point per metric, confirms and manually releases without record writes", async () => {
  const a = attentionApp(), before = a.store.raw; a.open();
  for (const field of ["weight", "bodyFat"]) {
    assert.match(a.get(`graph-${field}-attention-count`).textContent, /1件/);
    assert.equal(a.get(`graph-${field}-attention-count`).dataset.empty, "false");
    assert.equal(byClass(svg(a, field), "graph-attention-mark").length, 1);
    assert.match(text(a.get(`graph-${field}-attention`)), /固定上限/); assert.match(text(a.get(`graph-${field}-attention`)), /前回/);
  }
  await toggleAttention(a).click();
  assert.match(a.get("graph-weight-attention-count").textContent, /0件/); assert.equal(points(a).length, 2);
  assert.equal(a.get("graph-weight-attention-count").dataset.empty, "true");
  assert.equal(byClass(svg(a), "graph-attention-mark").length, 0); assert.equal(toggleAttention(a).textContent, "未確認に戻す");
  assert.match(a.get("graph-bodyFat-attention-count").textContent, /1件/);
  await toggleAttention(a).click(); assert.match(a.get("graph-weight-attention-count").textContent, /1件/);
  assert.equal(a.get("graph-weight-attention-count").dataset.empty, "false");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("confirmation survives reload, changed value, non-attention and changed conditions for the same date/field", async () => {
  let settings = { ...appSettings.DEFAULTS.attention };
  const a = attentionApp({ attention: () => ({ values: settings }) }); a.open(); await toggleAttention(a).click();
  for (const weight of ["81", "60", "80"]) {
    const records = attentionFixture(); records["2041-01-02"].weight = weight; a.store.raw = JSON.stringify(records); a.graphView.refresh();
    assert.equal(toggleAttention(a).textContent, "未確認に戻す"); assert.match(a.get("graph-weight-attention-count").textContent, /0件/);
  }
  settings = { ...settings, weightMax: 90, weightChange: 100 }; a.graphView.refresh();
  assert.equal(toggleAttention(a).textContent, "未確認に戻す"); settings = { ...appSettings.DEFAULTS.attention }; a.graphView.refresh();
  assert.match(a.get("graph-weight-attention-count").textContent, /0件/);
  const b = attentionApp({ extras: Object.fromEntries(a.store.extras) }); b.open();
  assert.equal(toggleAttention(b).textContent, "未確認に戻す"); assert.equal(toggleAttention(b, "bodyFat").textContent, "確認済みにする");
});

test("pending confirmation is not optimistically shown as saved and period changes retain the captured target", async () => {
  const locks = createLocks(); let release, acquired; const ready = new Promise(r => acquired = r);
  const held = locks.request(RecordSave.LOCK_NAME, { mode: "exclusive" }, async () => { acquired(); await new Promise(r => release = r); });
  await ready; const a = attentionApp({ locks }); a.open(); const job = toggleAttention(a).click();
  assert.equal(toggleAttention(a).disabled, true); assert.match(a.get("graph-weight-attention-count").textContent, /1件/);
  custom(a, "2041-01-01", "2041-01-01"); release(); await held; await job;
  assert.equal(a.graphView.getState().selectedDate, "2041-01-01");
  assert.deepEqual(acknowledgements.parse(a.store.extras.get(acknowledgements.KEY)), { "2041-01-02": { weight: true } });
  custom(a, "2041-01-02", "2041-01-02"); assert.match(a.get("graph-weight-attention-count").textContent, /0件/);
});

for (const kind of ["write", "verify"]) test(`confirmation ${kind} failure is visible and never falsely confirmed`, async () => {
  const a = attentionApp(); a.open(); a.store[kind === "write" ? "failAckWrite" : "failAckVerify"] = true;
  await toggleAttention(a).click(); assert.equal(a.get("graph-ack-status").dataset.error, "true");
  assert.match(a.get("graph-ack-status").textContent, /保存|照合/);
  assert.equal(toggleAttention(a).textContent, "確認済みにする");
  assert.match(a.get("graph-weight-attention-count").textContent, kind === "write" ? /1件/ : /確認状態不明/);
  assert.equal(a.store.writes, 0);
});

test("corrupt confirmation is unknown rather than zero; ordinary record saving remains independent", async () => {
  const a = attentionApp({ extras: { [acknowledgements.KEY]: "{broken" } }); a.open();
  assert.match(a.get("graph-weight-attention-count").textContent, /確認状態不明/); assert.equal(toggleAttention(a).disabled, true);
  assert.equal(a.store.ackWrites, 0); a.get("input-show").click(); a.hooks.loadDate("2041-01-02"); a.get("weight").value = "81";
  assert.equal(await a.hooks.saveCurrentEntry(), true); assert.equal(a.store.extras.get(acknowledgements.KEY), "{broken");
  assert.equal(JSON.parse(a.store.raw)["2041-01-02"].weight, "81");
});

test("unreadable confirmation and invalid attention settings do not invent a zero count or remove chart data", () => {
  const a = attentionApp(); a.store.failAckRead = true; a.open(); assert.match(a.get("graph-weight-attention-count").textContent, /確認状態不明/);
  const b = attentionApp({ attention: () => ({ values: appSettings.DEFAULTS.attention, error: "設定破損" }) }); b.open();
  assert.match(b.get("graph-weight-attention-count").textContent, /判定できません/); assert.match(b.get("graph-settings-status").textContent, /設定破損/);
  assert.equal(a.get("graph-weight-attention-count").dataset.empty, "false");
  assert.equal(b.get("graph-weight-attention-count").dataset.empty, "false");
  assert.equal(points(b).length, 2); assert.equal(b.store.writes, 0);
  const c = app(); c.open(); assert.equal(c.get("graph-weight-attention-count").dataset.empty, "true");
  c.store.raw = "{broken"; c.graphView.refresh(); assert.equal(c.get("graph-weight-attention-count").dataset.empty, "false");
});

test("real script order boots the three-tab browser modules", () => {
  const a = app(fixture(), { browserBoot: true }); a.open();
  assert.equal(a.nav.current(), "graph"); assert.equal(points(a).length, 3); assert.equal(a.store.writes, 0);
});

test("history month and selected detail survive a graph round-trip", () => {
  const a = app(); a.get("history-show").click(); a.get("history-month-prev").click();
  const dayButton = a.get("history-calendar").children.find((item) => item.dataset.date === "2032-04-10"); dayButton.click();
  a.open(); a.get("history-show").click();
  assert.equal(a.get("history-month").textContent, "2032年4月"); assert.match(a.get("history-detail-heading").textContent, /2032\/4\/10/);
  assert.equal(a.store.writes, 0);
});

test("history edit still opens the saved date and scrolls input to top without saving", () => {
  const a = app(); a.get("history-show").click();
  a.get("history-calendar").children.find((item) => item.dataset.date === "2032-05-01").click();
  a.get("history-edit").click(); a.flush();
  assert.equal(a.nav.current(), "input"); assert.equal(a.get("record-date").value, "2032-05-01");
  assert.equal(a.scrolls.at(-1).top, 0); assert.equal(a.store.writes, 0);
});

test("late history scroll never runs after switching to graph", () => {
  const a = app(); a.get("history-show").click();
  a.get("history-calendar").children.find((item) => item.dataset.date === "2032-05-01").click();
  a.get("history-edit").click(); a.open(); const count = a.scrolls.length; a.flush(); assert.equal(a.scrolls.length, count);
});

test("graph and history suppress normal saves; returning to input permits autosave", async () => {
  const a = app(); a.open(); assert.equal((await a.hooks.saveCurrentEntry()), false);
  a.get("history-show").click(); assert.equal((await a.hooks.saveCurrentEntry()), false);
  a.get("input-show").click(); a.get("weight").value = "57.5"; await a.get("weight").fire("input");
  assert.equal(a.store.writes, 1); assert.equal(JSON.parse(a.store.raw)["2032-05-15"].weight, "57.5");
  a.open(); assert.equal(points(a).length, 4);
});

test("unsaved input after a write failure blocks graph and history without discarding it", async () => {
  const a = app(); a.store.failWrite = true; a.get("weight").value = "57.5"; await a.get("weight").fire("input");
  assert.equal(a.nav.show("graph"), false); assert.equal(a.nav.show("history"), false);
  assert.equal(a.nav.current(), "input"); assert.equal(a.get("weight").value, "57.5"); assert.equal(a.store.writes, 0);
});

for (const mode of ["json", "csv"]) test(`${mode} preview blocks graph even if its disabled button is bypassed`, async () => {
  const a = app();
  if (mode === "json") await a.hooks.previewBackup(new File([JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-05-15T00:00:00.000Z", records: fixture() })], "fictional.json"));
  else await a.hooks.previewCsv(new File(["fictional"], "fictional.csv"));
  assert.equal(a.get("graph-show").disabled, true); assert.equal(a.nav.show("graph"), false);
  assert.equal(a.nav.current(), "input"); assert.equal(a.store.writes, 0);
  a.hooks.cancelRestore(); assert.equal(a.get("graph-show").disabled, false); a.open(); assert.equal(a.nav.current(), "graph");
});

test("initial all-period and latest common measurement selection use both fields", () => {
  const a = app(); a.open(); const state = a.graphView.getState();
  assert.deepEqual(state.range, { start: "2032-05-01", end: "2032-05-10" });
  assert.equal(state.mode, "all"); assert.equal(state.selectedDate, "2032-05-10");
  assert.match(a.get("graph-selected").textContent, /2032\/5\/10.*55\.9kg.*16\.5%/);
  assert.equal(a.get("graph-next").disabled, true); assert.equal(a.store.writes, 0);
});

for (const [mode, start] of [["1m", "2032-04-16"], ["3m", "2032-02-16"], ["6m", "2031-11-16"], ["1y", "2031-05-16"]]) {
  test(`${mode} mode uses the established calculation API`, () => {
    const a = app(); a.open(); a.get("graph-previous").click(); a.mode(mode);
    assert.deepEqual(a.graphView.getState().range, { start, end: "2032-05-15" }); assert.equal(a.graphView.getState().offset, 0);
  });
}

test("month-end navigation and latest reset preserve mode without drift", () => {
  const a = app(fixture(), { today: "2032-03-31" }); a.open(); a.mode("3m");
  a.get("graph-previous").click(); assert.equal(a.graphView.getState().range.end, "2032-02-29");
  a.get("graph-previous").click(); assert.equal(a.graphView.getState().range.end, "2032-01-31");
  a.get("graph-next").click(); a.get("graph-next").click(); assert.equal(a.graphView.getState().range.end, "2032-03-31");
  a.get("graph-next").click(); assert.equal(a.graphView.getState().offset, 0);
  a.get("graph-previous").click(); a.get("graph-latest").click(); assert.equal(a.graphView.getState().mode, "3m"); assert.equal(a.graphView.getState().offset, 0);
});

test("all-period combines metrics, disables period controls and retains both frames", () => {
  const a = app({ "2032-01-10": day({ bodyFat: "16" }), "2032-05-10": day({ weight: "56" }) }); a.open(); a.mode("all");
  assert.deepEqual(a.graphView.getState().range, { start: "2032-01-10", end: "2032-05-10" });
  for (const id of ["graph-previous", "graph-next", "graph-latest"]) assert.equal(a.get(id).disabled, true);
  assert.equal(points(a).length, 1); assert.equal(points(a, "bodyFat").length, 1);
});

test("custom range includes both boundaries and allows a single day", () => {
  const a = app(); a.open(); custom(a, "2032-05-01", "2032-05-02"); assert.equal(points(a).length, 2);
  custom(a, "2032-05-01", "2032-05-01"); assert.equal(points(a).length, 1);
  assert.equal(a.get("graph-previous").disabled, true); assert.equal(a.get("graph-next").disabled, true);
});

for (const [start, end] of [["2032-05-10", "2032-05-01"], ["2031-02-29", "2032-05-01"], ["", "2032-05-01"]]) {
  test(`invalid custom range ${start} to ${end} never changes the applied range`, () => {
    const a = app(); a.open(); a.mode("custom"); const before = JSON.stringify(a.graphView.getState().range);
    a.get("graph-start-date").value = start; a.get("graph-end-date").value = end; a.get("graph-apply-dates").click();
    assert.equal(JSON.stringify(a.graphView.getState().range), before); assert.equal(a.get("graph-status").dataset.error, "true"); assert.equal(a.store.writes, 0);
  });
}

test("manual period/selection survive tab changes but a new mount starts at all", () => {
  const a = app(); a.open(); a.mode("1m"); select(a, "weight", 0);
  a.get("history-show").click(); a.get("input-show").click(); a.open();
  assert.equal(a.graphView.getState().mode, "1m"); assert.equal(a.graphView.getState().selectedDate, "2032-05-01");
  const b = app(); b.open(); assert.equal(b.graphView.getState().mode, "all");
});

test("midnight refresh updates latest, preserves historical/custom and recalculates all", () => {
  const a = app(); a.open(); a.mode("3m"); a.get("input-show").click(); a.now.value = "2032-05-16"; a.open(); assert.equal(a.graphView.getState().range.end, "2032-05-16");
  a.get("graph-previous").click(); const old = JSON.stringify(a.graphView.getState().range);
  a.get("input-show").click(); a.now.value = "2032-05-17"; a.open(); assert.equal(JSON.stringify(a.graphView.getState().range), old);
  custom(a, "2032-05-01", "2032-05-02"); a.get("input-show").click(); a.now.value = "2032-05-18"; a.open(); assert.equal(a.graphView.getState().range.end, "2032-05-02");
  a.mode("all"); a.get("input-show").click(); a.store.raw = JSON.stringify({ ...fixture(), "2032-05-17": day({ weight: "55.8" }) });
  a.open(); assert.equal(a.graphView.getState().range.end, "2032-05-17");
});

test("empty periods still permit period navigation while point controls are disabled", () => {
  const a = app({}); a.open(); a.mode("3m"); assert.equal(a.get("graph-previous").disabled, false); a.get("graph-previous").click();
  assert.equal(a.graphView.getState().offset, -1); assert.equal(a.get("graph-next").disabled, false);
  for (const field of ["weight", "bodyFat"]) {
    assert.equal(a.get(`graph-${field}-empty`).hidden, false); assert.equal(a.get(`graph-${field}-summary`).hidden, true);
    assert.equal(a.get("graph-point-previous").disabled, true); assert.equal(a.get("graph-point-next").disabled, true);
  }
  a.mode("all"); assert.equal(a.graphView.getState().range, null); assert.equal(a.store.writes, 0);
});

test("SVG contains every valid point, actual day spacing, axes, line, band and guide", () => {
  const a = app(); a.open(); custom(a, "2032-05-01", "2032-05-10");
  const circles = points(a), xs = circles.map((point) => Number(point.attrs.cx));
  assert.equal(circles.length, 3); assert.ok(Math.abs((xs[2] - xs[1]) / (xs[1] - xs[0]) - 8) < 1e-9);
  for (const name of ["graph-axis", "graph-axis-label", "graph-measurement-line", "graph-target-band", "graph-guide", "graph-selection"]) assert.ok(byClass(svg(a), name).length > 0);
  assert.equal(a.get("graph-weight-goal").textContent, "目標：56.0〜56.9kg"); assert.equal(a.get("graph-bodyFat-goal").textContent, "目標：16.0〜16.9%");
  assert.doesNotMatch(text(a.get("graph-screen")), /目標達成|目標範囲内/);
});

test("zero is excluded and positive outliers remain visible independently", () => {
  const a = app({ "2032-05-01": day({ weight: "0", bodyFat: "" }), "2032-05-02": day({ weight: "556.3", bodyFat: 16.5 }) }); a.open();
  assert.equal(points(a).length, 1); assert.equal(points(a, "bodyFat").length, 0);
  assert.equal(byClass(svg(a), "graph-measurement-line").length, 0);
  assert.match(text(a.get("graph-weight-summary")), /556\.3kg/); assert.match(text(a.get("graph-weight-summary")), /—/);
  assert.equal(a.get("graph-bodyFat-empty").hidden, false);
});

test("exact statistics and percentage point units are displayed", () => {
  const a = app(); a.open(); assert.match(text(a.get("graph-weight-summary")), /−0\.3kg/);
  assert.match(text(a.get("graph-bodyFat-summary")), /\+0\.4pt/);
  assert.doesNotMatch(text(a.get("graph-weight-summary")), /0000000/);
});

test("tap selection updates both highlights and the single measurement row", () => {
  const a = app(); a.open(); select(a, "weight", 0);
  assert.equal(a.graphView.getState().selectedDate, "2032-05-01");
  assert.match(a.get("graph-selected").textContent, /2032\/5\/1.*56\.2kg.*16\.1%/);
  assert.equal(byClass(svg(a, "bodyFat"), "graph-selection")[0].dataset.date, "2032-05-01");
  assert.equal(byClass(svg(a), "graph-selection")[0].dataset.date, "2032-05-01");
  assert.equal(byClass(svg(a), "graph-guide")[0].attrs.x1, points(a)[0].attrs.cx); assert.equal(a.store.writes, 0);
});

test("measured SVG fallback coordinates select small points without preventing scroll", () => {
  const a = app(); a.open(); const point = points(a)[0];
  svg(a).fire("click", { clientX: Number(point.attrs.cx) + 7, clientY: Number(point.attrs.cy) + 5 });
  assert.equal(a.graphView.getState().selectedDate, "2032-05-01");
  svg(a).fire("click", { clientX: -500, clientY: -500 }); assert.equal(a.graphView.getState().selectedDate, "2032-05-01");
});

test("nearest-point ties are deterministic and distant taps do not select", () => {
  const values = [{ date: "a", x: 10, y: 10 }, { date: "b", x: 12, y: 10 }];
  assert.equal(graph.nearestPoint(values, 11, 10).date, "a"); assert.equal(graph.nearestPoint(values, 12, 10).date, "b");
  assert.equal(graph.nearestPoint(values, 100, 100), null); assert.equal(graph.nearestPoint(values, NaN, 1), null);
});

test("point controls and keyboard reach all points and stop at both boundaries", () => {
  const a = app(); a.open(); assert.equal(a.get("graph-point-next").disabled, true);
  a.get("graph-point-previous").click(); assert.equal(a.graphView.getState().selectedDate, "2032-05-02");
  svg(a).fire("keydown", { key: "ArrowLeft" }); assert.equal(a.get("graph-point-previous").disabled, true);
  a.get("graph-point-next").click(); a.get("graph-point-next").click(); assert.equal(a.graphView.getState().selectedDate, "2032-05-10");
});

test("period changes reset to latest points while rereads keep/update existing selections", () => {
  const a = app(); a.open(); select(a, "weight", 0); a.store.raw = JSON.stringify({ ...fixture(), "2032-05-01": day({ weight: "57.7" }) });
  a.graphView.refresh(); assert.equal(a.graphView.getState().selectedDate, "2032-05-01"); assert.match(a.get("graph-selected").textContent, /57\.7kg/);
  a.mode("1m"); assert.equal(a.graphView.getState().selectedDate, "2032-05-10");
  select(a, "weight", 0); a.store.raw = JSON.stringify({ "2032-05-02": day({ weight: "55" }), "2032-05-10": day({ weight: "54" }) });
  a.graphView.refresh(); assert.equal(a.graphView.getState().selectedDate, "2032-05-10"); assert.equal(a.store.writes, 0);
});

test("storage updates and JSON/CSV-equivalent saved snapshots refresh only on safe reads", () => {
  const a = app(); a.open(); a.store.raw = JSON.stringify({ "2032-05-14": day({ weight: "55.8" }) });
  a.emit("storage", { key: "exercise-record.entries.v1" }); assert.equal(points(a).length, 1); assert.match(a.get("graph-selected").textContent, /55\.8/);
  a.store.raw = JSON.stringify({ "2032-05-13": day({ bodyFat: "17" }) }); a.emit("focus"); assert.equal(points(a, "bodyFat").length, 1);
  assert.equal(a.store.writes, 0);
});

test("all-period expansion after a record update preserves a still-valid selected date", () => {
  const a = app(); a.open(); a.mode("all"); select(a, "weight", 0);
  a.store.raw = JSON.stringify({ ...fixture(), "2032-05-14": day({ weight: "55.7" }) });
  a.emit("storage", { key: "exercise-record.entries.v1" });
  assert.equal(a.graphView.getState().range.end, "2032-05-14");
  assert.equal(a.graphView.getState().selectedDate, "2032-05-01"); assert.equal(a.store.writes, 0);
});

test("SVG transform coordinates support scaled browser rendering", () => {
  const a = app(); a.open(); const box = svg(a), point = points(a)[0];
  box.getScreenCTM = () => ({ inverse: () => "inverse-transform" });
  box.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform(inverse) {
    assert.equal(inverse, "inverse-transform"); return { x: Number(point.attrs.cx), y: Number(point.attrs.cy) };
  } });
  box.fire("click", { clientX: 800, clientY: 600 });
  assert.equal(a.graphView.getState().selectedDate, "2032-05-01"); assert.equal(a.store.writes, 0);
});

for (const raw of ["{broken", "[]", '{"2031-02-29":{"weight":"56"}}']) test(`corrupt storage is an error, never an empty writable dataset: ${raw}`, () => {
  const a = app(raw); a.open(); assert.equal(a.graphView.getState().error, true); assert.match(a.get("graph-status").textContent, /読み込めません/);
  assert.equal(a.get("graph-weight-empty").hidden, true); assert.equal(a.get("graph-period").disabled, true);
  assert.equal(a.store.raw, raw); assert.equal(a.store.writes, 0);
  a.mode("all"); assert.equal(a.graphView.getState().error, true);
});

test("storage read exceptions leave records untouched and recover after reopening", () => {
  const a = app(), before = a.store.raw; a.store.failRead = true; a.open(); assert.equal(a.graphView.getState().error, true);
  a.store.failRead = false; a.get("input-show").click(); a.open(); assert.equal(a.graphView.getState().error, false);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

for (const width of [320, 375, 390, 430]) test(`SVG numeric geometry is bounded at ${width}px; resize preserves state`, () => {
  const a = app(fixture(), { width }); a.open(); select(a, "weight", 0); const before = a.graphView.getState();
  for (const field of ["weight", "bodyFat"]) {
    const box = svg(a, field); assert.ok(Number(box.attrs.width) <= width);
    for (const item of descendants(box)) for (const [name, value] of Object.entries(item.attrs)) {
      if (["cx", "cy", "x", "y", "x1", "x2", "y1", "y2", "width", "height"].includes(name)) assert.ok(Number.isFinite(Number(value)));
      assert.doesNotMatch(value, /NaN|Infinity/);
    }
  }
  a.viewport.width += 30; a.emit("resize"); a.flush();
  assert.deepEqual(a.graphView.getState().range, before.range); assert.deepEqual(a.graphView.getState().selectedDate, before.selectedDate); assert.equal(a.store.writes, 0);
});

test("missing container dimensions use safe geometry", () => {
  const a = app(); a.get("graph-weight-plot").bounds = { width: 0 }; a.document.documentElement = {}; a.open();
  assert.equal(a.graphView.getState().error, false); assert.equal(svg(a).attrs.width, "262");
});

test("very large finite values render bounded SVG and full selected raw text", () => {
  const a = app({ "2032-05-01": day({ weight: String(Number.MAX_VALUE), bodyFat: "5e-324" }) }); a.open();
  assert.equal(a.graphView.getState().error, false);
  assert.match(a.get("graph-selected").textContent, /1\.7976931348623157e\+308kg/);
  for (const field of ["weight", "bodyFat"]) for (const item of descendants(svg(a, field))) {
    for (const value of Object.values(item.attrs)) assert.doesNotMatch(value, /NaN|Infinity/);
  }
});

test("dense charts keep 500 points and their latest selection", () => {
  const records = {};
  for (let index = 0; index < 500; index++) records[model.addDays("2030-01-01", index)] = day({ weight: String(55 + index % 10 / 10) });
  const a = app(records); a.open(); a.mode("all"); assert.equal(points(a).length, 500);
  assert.equal(a.graphView.getState().selectedDate, model.addDays("2030-01-01", 499));
  for (let index = 0; index < 499; index++) a.get("graph-point-previous").click();
  assert.equal(a.graphView.getState().selectedDate, "2030-01-01"); assert.equal(a.store.writes, 0);
});

test("targets supplied through the settings API do not persist records", () => {
  const a = app(fixture(), { targets: () => ({ weight: { min: 54, max: 55 }, bodyFat: { min: 17, max: 18 } }) }); a.open();
  assert.equal(a.get("graph-weight-goal").textContent, "目標：54.0〜55.0kg"); assert.equal(a.store.writes, 0);
  assert.match(html, /id="settings-show"/);
});

for (const width of [320, 375, 390, 430]) test(`all six periods retain readable date ticks and every point at ${width}px`, () => {
  const records = { ...fixture(), "2031-06-01": day({ weight: "57.1", bodyFat: "17.1" }) };
  const a = app(records, { width }), before = a.store.raw; a.open();
  for (const mode of ["1m", "3m", "6m", "1y", "all", "custom"]) {
    if (mode === "custom") custom(a, "2032-02-16", "2032-05-15"); else a.mode(mode);
    const range = a.graphView.getState().range;
    for (const field of ["weight", "bodyFat"]) {
      const dates = byClass(svg(a, field), "graph-date-label");
      assert.equal(dates.length, 5, `${field}/${mode}: ${dates.length}`);
      const expected = model.filterMeasurements(model.extractMeasurements(records)[field], range);
      assert.equal(points(a, field).length, expected.length);
      for (const item of dates) assert.ok(Number(item.attrs.x) >= 0 && Number(item.attrs.x) <= Number(svg(a, field).attrs.width));
    }
  }
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("chart headings keep goals and compact attention counts together with wrapping and live updates", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.graph-card\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(css, /\.graph-card > :not\(h3\):not\(\.graph-meta\)[^{]*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.graph-meta\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
  for (const field of ["weight", "bodyFat"]) {
    assert.match(html, new RegExp(`<h3[^>]*id="graph-${field}-heading"[^>]*>[\\s\\S]*?<\\/h3>\\s*<div class="graph-meta">\\s*<p[^>]*id="graph-${field}-goal"[^>]*><\\/p>\\s*<p[^>]*id="graph-${field}-attention-count"`));
  }
  let targets = { weight: { min: 56, max: 56.9 }, bodyFat: { min: 16, max: 16.9 } };
  const a = app(fixture(), { targets: () => targets }); a.open();
  for (const field of ["weight", "bodyFat"]) assert.equal(a.get(`graph-${field}-attention-count`).textContent, "未確認 0件");
  const originalBand = { ...byClass(svg(a), "graph-target-band")[0].attrs };
  targets = { weight: { min: 52.1, max: 53.2 }, bodyFat: { min: 14.1, max: 15.2 } }; a.graphView.refresh();
  assert.equal(a.get("graph-weight-goal").textContent, "目標：52.1〜53.2kg");
  assert.equal(a.get("graph-bodyFat-goal").textContent, "目標：14.1〜15.2%");
  assert.notDeepEqual(byClass(svg(a), "graph-target-band")[0].attrs, originalBand); assert.equal(a.store.writes, 0);
});

test("numeric autosave and keyboard focus movement remain without a custom next/done toolbar", async () => {
  assert.doesNotMatch(html, /id="input-(?:toolbar|next)"/);
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.doesNotMatch(css, /\.input-toolbar/);
  const a = app({}, { today: "2041-01-03" });
  a.get("walk-minutes").value = "0"; a.get("walk-minutes").focus(); await a.get("walk-minutes").fire("input");
  const writes = a.store.writes; a.get("walk-minutes").fire("keydown", { key: "Enter" });
  assert.equal(a.document.activeElement, a.get("walk-seconds")); assert.equal(a.store.writes, writes);
  a.get("walk-steps").focus(); a.get("walk-steps").fire("keydown", { key: "Enter" }); assert.equal(a.document.activeElement, null);
  a.get("basal").value = "1300"; a.get("basal").focus(); await a.get("basal").fire("input");
  a.get("basal").fire("keydown", { key: "Enter" }); assert.equal(a.document.activeElement, null);
  const saved = JSON.parse(a.store.raw)["2041-01-03"]; assert.equal(saved.walkMinutes, "0"); assert.equal(saved.basal, "1300");
  assert.equal(a.store.ackWrites, 0);
});

test("each summary item pairs its colon label and value on a wrapping item layout", () => {
  const a = app(); a.open();
  for (const [field, values] of [["weight", ["56.2kg", "55.9kg", "−0.3kg"]], ["bodyFat", ["16.1%", "16.5%", "+0.4pt"]]]) {
    const items = a.get(`graph-${field}-summary`).children;
    assert.deepEqual(items.map((item) => item.children.map((part) => part.textContent)),
      ["最初：", "最後：", "変化量："].map((label, index) => [label, values[index]]));
  }
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.graph-summary\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.graph-summary dl\s*\{[^}]*display:\s*flex/);
  assert.equal(a.store.writes, 0);
});

test("pt is a display abbreviation of exact percentage-point subtraction; zero and single cases stay unchanged", () => {
  const records = { "2032-05-01": day({ bodyFat: "16.8" }), "2032-05-10": day({ bodyFat: "16.2" }) };
  const a = app(records), before = a.store.raw; a.open();
  assert.equal(a.get("graph-weight-summary").hidden, true);
  assert.equal(a.get("graph-bodyFat-summary").children[2].children[1].textContent, "−0.6pt");
  assert.equal(model.summarizeMeasurements(model.extractMeasurements(records).bodyFat, "bodyFat").changeUnit, "パーセントポイント");
  custom(a, "2032-05-10", "2032-05-10");
  assert.deepEqual(a.get("graph-bodyFat-summary").children.map((item) => item.children[1].textContent), ["16.2%", "16.2%", "—"]);
  custom(a, "2032-05-11", "2032-05-12");
  assert.equal(a.get("graph-bodyFat-summary").hidden, true);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("multi-year labels choose two lines for five readable dates and preserve full date coordinates", () => {
  const records = { "2030-01-01": day({ weight: "57", bodyFat: "17" }), "2034-12-31": day({ weight: "56", bodyFat: "16" }) };
  const a = app(records, { width: 320 }); a.open(); a.mode("all");
  for (const field of ["weight", "bodyFat"]) {
    const labels = byClass(svg(a, field), "graph-date-label"), range = a.graphView.getState().range;
    assert.equal(labels.length, 5);
    for (const label of labels) {
      assert.match(label.attrs["aria-label"], /^\d{2}\/\d{1,2}\/\d{1,2}$/);
      assert.equal(label.children.length, 2); assert.equal(label.children.map((line) => line.textContent).join(""), label.attrs["aria-label"]);
      const left = Number(byClass(svg(a, field), "graph-axis")[0].attrs.x1);
      const plotWidth = Number(svg(a, field).attrs.width) - left - 12;
      assert.equal(Number(label.attrs.x), left + model.calculateX(label.dataset.tickDate, range, plotWidth));
    }
  }
  assert.equal(a.store.writes, 0);
});

test("wide charts prefer single-line two-digit years; cramped axes reduce count instead of overlapping", () => {
  const wide = app(fixture(), { width: 700 }); wide.open(); wide.mode("1y");
  assert.equal(byClass(svg(wide), "graph-date-label").length, 5);
  assert.ok(byClass(svg(wide), "graph-date-label").every((label) => label.children.length === 0));
  const a = app(); a.get("graph-weight-plot").bounds = { width: 160 }; a.open();
  const labels = byClass(svg(a), "graph-date-label"); assert.ok(labels.length >= 2 && labels.length < 5);
  assert.equal(labels[0].dataset.tickDate, a.graphView.getState().range.start);
  assert.equal(labels.at(-1).dataset.tickDate, a.graphView.getState().range.end);
  assert.equal(points(a).length, 3); assert.equal(a.store.writes, 0);
});

test("SVG font measurements guide fitting and do not alter lines, bands, selections or records", () => {
  const a = app(), before = a.store.raw, create = a.document.createElementNS;
  let measured = 0;
  a.document.createElementNS = (namespace, tag) => {
    const item = create(namespace, tag);
    item.getComputedTextLength = () => { measured++; return 100; };
    return item;
  };
  a.open(); a.mode("1y");
  assert.ok(measured > 0); assert.ok(byClass(svg(a), "graph-date-label").length < 5);
  assert.equal(points(a).length, 3); assert.equal(byClass(svg(a), "graph-measurement-line").length, 1);
  assert.equal(byClass(svg(a), "graph-target-band").length, 1);
  select(a, "weight", 0); assert.equal(a.graphView.getState().selectedDate, "2032-05-01");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

for (const width of [320, 375, 390, 430]) test(`sparse year labels keep five single-line dates at ${width}px without writing records`, () => {
  const a = app(fixture(), { width }), before = a.store.raw; a.open(); a.mode("1y");
  for (const field of ["weight", "bodyFat"]) {
    const labels = byClass(svg(a, field), "graph-date-label");
    assert.equal(labels.length, 5);
    assert.deepEqual(labels.map((label) => label.attrs["aria-label"].split("/").length), [3, 2, 2, 3, 2]);
    assert.ok(labels.every((label) => label.children.length === 0));
    assert.equal(points(a, field).length, field === "weight" ? 3 : 2);
  }
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("mixed year and month/day labels remain correct in a two-line fallback", () => {
  const a = app(fixture(), { width: 320 }), create = a.document.createElementNS;
  a.document.createElementNS = (namespace, tag) => {
    const item = create(namespace, tag);
    item.getComputedTextLength = () => item.textContent.split("/").length === 3 ? 90 : 20;
    return item;
  };
  a.open(); a.mode("1y");
  const labels = byClass(svg(a), "graph-date-label"); assert.equal(labels.length, 5);
  for (const label of labels) {
    const full = label.attrs["aria-label"];
    if (full.split("/").length === 3) {
      assert.equal(label.children.length, 2); assert.equal(label.children.map((part) => part.textContent).join(""), full);
    } else {
      assert.equal(label.children.length, 0); assert.equal(label.textContent, full);
      assert.equal(Number(label.attrs.y), Number(labels[0].attrs.y) + 13);
    }
  }
  assert.doesNotMatch(text(svg(a)), /undefined|NaN/); assert.equal(a.store.writes, 0);
});

test("thinned SVG labels compare years against the displayed dates and keep exact anchor coordinates", () => {
  const records = { "2030-10-23": day({ weight: "57" }), "2032-02-22": day({ weight: "56" }) };
  const a = app(records), create = a.document.createElementNS;
  a.document.createElementNS = (namespace, tag) => { const item = create(namespace, tag); item.getComputedTextLength = () => 100; return item; };
  a.open(); a.mode("all");
  const labels = byClass(svg(a), "graph-date-label"), range = a.graphView.getState().range;
  const left = Number(byClass(svg(a), "graph-axis")[0].attrs.x1), plotWidth = Number(svg(a).attrs.width) - left - 12;
  const expected = model.makeXTicks(range, plotWidth, { minLabelSpacing: 1, maxTicks: labels.length });
  assert.ok(labels.length < 5); assert.deepEqual(labels.map((label) => label.attrs["aria-label"]), expected.map((tick) => tick.label));
  labels.forEach((label, index) => assert.equal(Number(label.attrs.x), left + expected[index].x));
  assert.equal(points(a).length, 2); assert.equal(a.store.writes, 0);
});
