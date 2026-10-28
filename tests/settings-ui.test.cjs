"use strict";
const RecordSave = require("../record-save.js");
const { createLocks } = require("./helpers/record-locks.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { File } = require("node:buffer");
const transfer = require("../record-transfer.js"), csv = require("../numbers-csv.js"), history = require("../history-view.js");
const navigationModule = require("../app-navigation.js"), graph = require("../graph-view.js"), model = require("../body-graph.js");
const settingsModel = require("../app-settings.js"), settingsUI = require("../settings-view.js");
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
  const get = (id) => { const item = elements.get(id) || [...elements.values()].flatMap(descendants).find(e => e.id === id); assert.ok(item, id); return item; };
  const settingValues = new Map(Object.entries(options.settings || {}));
  const store = { settingValues, settingWrites: [], afterSettingWrite: null, settingFailRead: false, settingFailWrite: false, raw: typeof records === "string" || records === null ? records : JSON.stringify(records), writes: 0, failWrite: false, failRead: false,
    getItem(key) { if (Object.values(settingsModel.KEYS).includes(key)) { if (this.settingFailRead) throw Error("settings read"); return settingValues.get(key) ?? null; } assert.equal(key, "exercise-record.entries.v1"); if (this.failRead) throw Error("read failed"); return this.raw; },
    setItem(key, value) { if (Object.values(settingsModel.KEYS).includes(key)) { if (this.settingFailWrite) throw Error("settings quota"); this.settingWrites.push(key); settingValues.set(key, value); this.afterSettingWrite?.(key,value); return; } assert.equal(key, "exercise-record.entries.v1"); if (this.failWrite) throw Error("quota"); this.writes++; this.raw = value; },
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
  let nav, graphView, historyView, settingsStore, settingsView;
  if (options.browserBoot) {
    for (const ref of [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1])) {
      const file = ref.split("?")[0];
      if (["record-transfer.js", "numbers-csv.js", "script.js"].includes(file)) continue;
      vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    }
    nav = context.RecordAppNavigation; graphView = context.RecordGraphView; settingsStore = context.RecordSettings; settingsView = context.RecordSettingsView;
  } else {
    nav = navigationModule.mount({ document, input: window.RecordHistoryInput });
    historyView = history.mount({ document, window, storage: store, input: window.RecordHistoryInput, navigation: nav, today: () => now.value });
    settingsStore = settingsModel.createStore(store); settingsView = settingsUI.mount({ document, window, navigation: nav, store: settingsStore });
    graphView = graph.mount({ document, window, storage: store, navigation: nav, today: () => now.value, getTargets: () => settingsStore.getTargets(), getTargetStatus: () => settingsStore.read("goals").error, ...(options.targets ? { getTargets: options.targets } : {}) });
  }
  return { get, store, nav, graphView, historyView, settingsStore, settingsView, hooks: context.hooks, now, viewport, steps, copies, shares, window, document, scrolls,
    open() { get("graph-show").click(); }, mode(value) { get("graph-period").value = value; get("graph-period").fire("change"); },
    emit(name, event = {}) { for (const fn of listeners[name] || []) fn(event); },
    flush() { for (let loop = 0; frames.length && loop < 10; loop++) frames.splice(0).forEach((fn) => fn()); assert.equal(frames.length, 0); } };
}
const edit = (a, group = "goals") => a.get(`settings-${group}-edit`).click();
const value = (a, name, raw, group = "goals") => { a.get(`settings-${group}-${name}`).value = raw; };
const save = (a, group = "goals") => a.get(`settings-${group}-save`).click();
const openSettings = (a) => a.get("settings-show").click();
const target = (a) => a.get("graph-weight-goal").textContent;

test("exercise goal section edits six optional goals, cancels independently and saves without touching records or other groups", () => {
  const a = app(), before = a.store.raw; openSettings(a); assert.match(text(a.get("settings-exerciseGoals-summary")), /スクワット：未設定/);
  edit(a, "exerciseGoals"); edit(a); value(a, "weightMin", "54");
  for (const [field, raw] of Object.entries({ squat: "80", march: "10", plank: "60", standing: "15", walkSteps: "10000", distance: "2.5" })) value(a, field, raw, "exerciseGoals");
  save(a, "exerciseGoals"); assert.equal(a.get("settings-exerciseGoals-form").hidden, true);
  assert.match(text(a.get("settings-exerciseGoals-summary")), /スタンディング：15H／日/); assert.equal(a.get("settings-goals-weightMin").value, "54");
  assert.deepEqual(a.store.settingWrites, [settingsModel.KEYS.exerciseGoals]);
  edit(a, "exerciseGoals"); a.get("settings-exerciseGoals-reset").click(); assert.equal(a.get("settings-exerciseGoals-squat").value, "");
  a.get("settings-exerciseGoals-cancel").click(); assert.equal(a.settingsStore.read("exerciseGoals").values.squat, 80);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("exercise goal drafts are protected on navigation and retained after a save failure", () => {
  const a = app(); openSettings(a); edit(a, "exerciseGoals"); value(a, "squat", "80", "exerciseGoals");
  assert.equal(a.nav.show("history"), false); a.get("settings-continue").click();
  a.store.settingFailWrite = true; save(a, "exerciseGoals"); assert.equal(a.get("settings-exerciseGoals-form").hidden, false);
  assert.equal(a.get("settings-exerciseGoals-squat").value, "80"); assert.match(a.get("settings-exerciseGoals-status").textContent, /保存できません/);
  a.store.settingFailWrite = false; save(a, "exerciseGoals"); assert.equal(a.settingsStore.read("exerciseGoals").values.squat, 80);
  assert.equal(a.store.writes, 0);
});

test("settings uses a decorative line SVG with an accessible button name", () => {
  const button = /<button\b([^>]*\bid="settings-show"[^>]*)>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(button); assert.match(button[1], /aria-label="設定を開く"/);
  assert.match(button[1], /aria-controls="settings-screen"/);
  assert.match(button[2], /<svg\b[^>]*viewBox="0 0 24 24"[^>]*fill="none"[^>]*stroke="currentColor"/);
  assert.match(button[2], /aria-hidden="true"/); assert.match(button[2], /focusable="false"/);
  assert.match(button[2], /<path\b/); assert.match(button[2], /<circle\b/);
  assert.doesNotMatch(button[2], /[\u2699\uFE0F]|<image\b|<use\b/);
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.settings-gear\.date-step\s*\{[^}]*flex: 0 0 48px/);
  assert.match(css, /\.settings-gear svg\s*\{[^}]*display: block;[^}]*width: 24px;[^}]*height: 24px/);
});

test("settings button keeps its centered layout with optical adjustment only on the SVG", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  const button = /\.settings-gear\.date-step\s*\{([^}]*)\}/.exec(css)[1];
  for (const rule of [/display: flex/, /align-items: center/, /justify-content: center/, /flex: 0 0 48px/, /height: 44px/, /padding: 0/, /line-height: 1/]) assert.match(button, rule);
  const icon = /\.settings-gear svg\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(icon, /flex-shrink: 0/); assert.match(icon, /margin: 0/);
  assert.match(icon, /transform: translateY\(0\)/); assert.doesNotMatch(button, /transform:/);
});

test("optical adjustment has its own stylesheet URL independent of the HTML query", () => {
  const reference = /<link rel="stylesheet" href="([^"]+)"/.exec(html)[1];
  assert.equal(reference, "style.css?v=0.4-gear-optical-20261024-up2");
  assert.notEqual(reference, "style.css?v=0.4-gear-optical-20261024-2px");
  const base = "http://example.test/", old = new URL("style.css?v=0.3-history-separators-20261021", base);
  assert.notEqual(new URL(reference, base).href, old.href);
  assert.equal(new URL(reference, base + "?ui-check=gear-optical-20261024-2").href, new URL(reference, base).href);
});

for (const tag of ["svg", "path", "circle", "button"]) test(`a bubbled ${tag} click opens settings and back returns to graph`, () => {
  const a = app(), before = a.store.raw; a.open(); const state = a.graphView.getState();
  a.get("settings-show").fire("click", { target: { tag } });
  assert.equal(a.nav.current(), "settings"); a.get("settings-back").click();
  assert.equal(a.nav.current(), "graph"); assert.deepEqual(a.graphView.getState(), state);
  assert.equal(a.store.writes, 0); assert.equal(a.store.raw, before); assert.equal(a.store.settingWrites.length, 0);
});

test("real browser script order boots settings; opening only reads keys", () => {
  const a = app(fixture(), { browserBoot: true }), before = a.store.raw;
  openSettings(a); assert.equal(a.nav.current(), "settings");
  assert.match(text(a.get("settings-goals-summary")), /56.0〜56.9kg/);
  assert.match(text(a.get("settings-attention-summary")), /10日以内/);
  assert.match(text(a.get("settings-attention-summary")), /3.0ポイント以上/);
  assert.equal(a.get("settings-goals-form").hidden, true); assert.equal(a.store.settingWrites.length, 0);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
  assert.equal((html.match(/aria-controls="(?:input|history|graph)-screen"/g) || []).length, 3);
});
for (const name of ["input", "history", "graph"]) test(`back returns to ${name} with no record writes`, () => {
  const a = app(); a.nav.show(name); openSettings(a); a.get("settings-back").click();
  assert.equal(a.nav.current(), name); assert.equal(a.store.writes, 0); assert.equal(a.store.settingWrites.length, 0);
});
test("editing and saving a group keeps the other group's unsaved edits", () => {
  const a = app(); openSettings(a); edit(a); edit(a, "attention"); value(a, "compareDays", "20", "attention");
  value(a, "weightMin", "54"); save(a);
  assert.equal(a.get("settings-goals-form").hidden, true);
  assert.equal(a.get("settings-attention-form").hidden, false); assert.equal(a.get("settings-attention-compareDays").value, "20");
  assert.deepEqual(a.store.settingWrites, [settingsModel.KEYS.goals]);
  assert.equal(a.settingsView.hasUnsavedChanges(), true); save(a, "attention");
  assert.equal(a.settingsStore.getAttention().values.compareDays, 20); assert.equal(a.store.writes, 0);
});
test("cancel and reset affect only their group and do not save", () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); edit(a, "attention"); value(a, "compareDays", "20", "attention");
  a.get("settings-goals-reset").click(); assert.equal(a.get("settings-goals-weightMin").value, "56.0");
  a.get("settings-goals-cancel").click();
  assert.equal(a.get("settings-attention-compareDays").value, "20"); assert.equal(a.get("settings-attention-form").hidden, false);
  assert.equal(a.store.settingWrites.length, 0); assert.equal(a.store.writes, 0);
});
test("reset requires save; reset then cancel keeps previously saved settings", () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); save(a);
  edit(a); a.get("settings-goals-reset").click(); a.get("settings-goals-cancel").click();
  assert.equal(a.settingsStore.getTargets().weight.min, 54); assert.equal(a.store.settingWrites.length, 1);
  edit(a); a.get("settings-goals-reset").click(); save(a);
  assert.equal(a.settingsStore.getTargets().weight.min, 56); assert.equal(a.store.settingWrites.length, 2);
});
for (const [field, raw, group] of [["weightMin", "56.95", "goals"], ["bodyFatMax", "", "goals"], ["compareDays", "366", "attention"],
  ["weightMin", "80", "attention"], ["bodyFatChange", "0", "attention"]]) test(`UI validation keeps ${group}/${field} draft ${raw}`, () => {
  const a = app(); openSettings(a); edit(a, group); value(a, field, raw, group); save(a, group);
  assert.equal(a.get(`settings-${group}-form`).hidden, false); assert.equal(a.get(`settings-${group}-${field}`).value, raw);
  assert.equal(a.get(`settings-${group}-${field}`).attrs["aria-invalid"], "true");
  assert.ok(a.get(`settings-${group}-${field}-error`).textContent); assert.equal(a.store.settingWrites.length, 0);
});
test("dirty navigation offers continue and explicit discard for both groups", () => {
  const a = app(); a.open(); openSettings(a); edit(a); edit(a, "attention");
  value(a, "weightMin", "54"); value(a, "compareDays", "20", "attention"); a.get("settings-back").click();
  assert.equal(a.nav.current(), "settings"); assert.equal(a.get("settings-leave-confirm").hidden, false);
  a.get("settings-continue").click(); assert.equal(a.get("settings-goals-weightMin").value, "54");
  assert.equal(a.get("settings-attention-compareDays").value, "20");
  a.get("settings-back").click(); a.get("settings-discard").click(); assert.equal(a.nav.current(), "graph");
  assert.equal(target(a), "目標：56.0〜56.9kg"); assert.equal(a.store.settingWrites.length, 0); assert.equal(a.store.writes, 0);
});
for (const group of ["goals", "attention"]) test(`common navigation and beforeunload protect only-${group} draft`, () => {
  const a = app(); openSettings(a); edit(a, group); value(a, "weightMin", "44", group);
  assert.equal(a.nav.show("history"), false); assert.equal(a.nav.current(), "settings");
  let prevented = false; const event = { preventDefault() { prevented = true; } }; a.emit("beforeunload", event);
  assert.equal(prevented, true); assert.equal(event.returnValue, "");
  a.get("settings-discard").click(); assert.equal(a.nav.current(), "history"); assert.equal(a.store.writes, 0);
});
test("equivalent draft needs no confirm and reentry does not reset editing", () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "56");
  assert.equal(a.settingsView.hasUnsavedChanges(), false); a.get("settings-back").click(); assert.equal(a.nav.current(), "input");
  openSettings(a); edit(a); value(a, "weightMin", "54"); a.nav.show("settings");
  assert.equal(a.get("settings-goals-weightMin").value, "54"); assert.equal(a.get("settings-goals-form").hidden, false);
});
test("failed record autosave and JSON/CSV previews still block opening settings", async () => {
  const a = app(); a.store.failWrite = true; a.get("weight").value = "57.5"; await a.get("weight").fire("input");
  openSettings(a); assert.equal(a.nav.current(), "input"); assert.equal(a.get("weight").value, "57.5");
  for (const mode of ["json", "csv"]) {
    const b = app();
    if (mode === "json") await b.hooks.previewBackup(new File([JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-05-15T00:00:00.000Z", records: fixture() })], "fictional.json"));
    else await b.hooks.previewCsv(new File(["fictional"], "fictional.csv"));
    openSettings(b); assert.equal(b.nav.current(), "input"); assert.equal(b.store.writes, 0); assert.equal(b.store.settingWrites.length, 0);
  }
});
test("save failure keeps draft and old graph target, allows retry", () => {
  const a = app(); a.open(); openSettings(a); edit(a); value(a, "weightMin", "54"); a.store.settingFailWrite = true; save(a);
  assert.equal(a.get("settings-goals-form").hidden, false); assert.equal(a.get("settings-goals-weightMin").value, "54");
  assert.match(a.get("settings-goals-status").textContent, /保存できません/); assert.equal(a.settingsStore.getTargets().weight.min, 56);
  a.store.settingFailWrite = false; save(a); a.get("settings-back").click(); assert.equal(target(a), "目標：54.0〜56.9kg");
  assert.equal(a.store.writes, 0);
});
test("readback failure keeps old target through cancel and warns of uncertain persistence", () => {
  const a = app(); a.open(); openSettings(a); edit(a); value(a, "weightMin", "54");
  a.store.afterSettingWrite = () => { a.store.settingFailRead = true; }; save(a); a.store.settingFailRead = false;
  assert.match(a.get("settings-goals-status").textContent, /書き込み済みの可能性/);
  a.get("settings-goals-cancel").click(); a.get("settings-back").click();
  assert.equal(target(a), "目標：56.0〜56.9kg"); assert.match(a.get("graph-settings-status").textContent, /書き込み済みの可能性/);
  assert.equal(a.store.writes, 0);
});
test("corrupt settings stay unchanged until explicit repair confirmation", () => {
  const a = app(fixture(), { settings: { [settingsModel.KEYS.goals]: "{broken" } });
  openSettings(a); assert.match(a.get("settings-goals-status").textContent, /破損/); edit(a); save(a);
  assert.equal(a.store.settingWrites.length, 0); assert.equal(a.get("settings-goals-repair").hidden, false);
  a.get("settings-goals-repair-confirm").checked = true; save(a);
  assert.equal(a.store.settingWrites.length, 1); assert.equal(a.get("settings-goals-form").hidden, true);
  assert.equal(a.store.writes, 0);
});
test("graph targets, band and axis update while custom period and selected points survive", () => {
  const a = app(); a.open(); a.mode("custom"); a.get("graph-start-date").value = "2032-05-01"; a.get("graph-end-date").value = "2032-05-15";
  a.get("graph-apply-dates").click();
  const graphPoints = byClass(a.get("graph-weight-plot"), "graph-point");
  a.get("graph-weight-plot").children[0].fire("click", { target: graphPoints[0] });
  const before = a.graphView.getState(), axisBefore = text(a.get("graph-weight-plot"));
  openSettings(a); edit(a); value(a, "weightMin", "70"); value(a, "weightMax", "80");
  assert.equal(target(a), "目標：56.0〜56.9kg"); save(a); a.get("settings-back").click();
  assert.equal(target(a), "目標：70.0〜80.0kg");
  assert.deepEqual(a.graphView.getState().range, before.range); assert.deepEqual(a.graphView.getState().selected, before.selected);
  assert.equal(a.get("graph-start-date").value, "2032-05-01"); assert.notEqual(text(a.get("graph-weight-plot")), axisBefore);
  assert.equal(byClass(a.get("graph-weight-plot"), "graph-target-band").length, 1); assert.equal(a.store.writes, 0);
});
test("past graph offset and history selection survive settings roundtrips", () => {
  const a = app(); a.open(); a.get("graph-previous").click(); const state = a.graphView.getState();
  openSettings(a); a.get("settings-back").click(); assert.deepEqual(a.graphView.getState(), state);
  a.nav.show("history"); a.get("history-month-prev").click(); const heading = a.get("history-month").textContent;
  openSettings(a); a.get("settings-back").click(); assert.equal(a.get("history-month").textContent, heading); assert.equal(a.store.writes, 0);
});
test("reload preserves both groups and graph reads committed targets", () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); save(a); edit(a, "attention"); value(a, "compareDays", "20", "attention"); save(a, "attention");
  const b = app(fixture(), { browserBoot: true, settings: Object.fromEntries(a.store.settingValues) }); b.open();
  assert.equal(target(b), "目標：54.0〜56.9kg"); openSettings(b); assert.match(text(b.get("settings-attention-summary")), /20日以内/);
  assert.equal(b.store.writes, 0); assert.equal(b.store.settingWrites.length, 0);
});
test("JSON export and restore retain settings without mixing schemas", async () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); save(a); a.get("settings-back").click();
  const saved = a.store.settingValues.get(settingsModel.KEYS.goals); await a.get("backup-export").click();
  const backup = JSON.parse(await a.shares[0].files[0].text()); assert.deepEqual(Object.keys(backup).sort(), ["exportedAt", "format", "formatVersion", "records"]);
  assert.deepEqual(backup.records, fixture());
  await a.hooks.previewBackup(new File([JSON.stringify({ ...backup, records: { "2032-05-01": day({ weight: "57" }) } })], "fictional.json"));
  a.hooks.cancelRestore(); assert.equal(a.store.settingValues.get(settingsModel.KEYS.goals), saved); assert.equal(a.store.writes, 0);
});
for (const type of ["json", "csv"]) test(`${type} committed import writes records once and never changes settings`, async () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); save(a);
  edit(a, "attention"); value(a, "compareDays", "20", "attention"); save(a, "attention"); a.get("settings-back").click();
  const before = [...a.store.settingValues], incoming = day({ weight: "55.4", bodyFat: "16.3" });
  if (type === "json") {
    await a.hooks.previewBackup(new File([JSON.stringify({ format: "exercise-record-backup", formatVersion: 1, exportedAt: "2032-05-15T00:00:00.000Z", records: { "2032-05-11": incoming } })], "fictional.json"));
  } else {
    const row = ["", "5/11", "", "", "", "", "10", "", "", "", "", "5/11", "55.4", "16.3", ""];
    const input = [csv.HEADERS, row].map(cells => cells.map(cell => '"' + cell + '"').join(",")).join("\n");
    await a.hooks.previewCsv(new File([input], "fictional.csv"));
    a.get("csv-year").value = "2032"; a.get("csv-start-date").value = "2032-05-11"; a.get("csv-end-date").value = "2032-05-11";
    a.get("csv-year-confirm").checked = true; a.get("csv-preview-button").click();
  }
  await a.get("restore-prebackup").click();
  a.get("restore-backup-confirm").checked = true; a.get("restore-final-confirm").checked = true;
  a.get("restore-final-confirm").fire("change"); await a.get("restore-apply").click();
  assert.equal(a.store.writes, 1); assert.deepEqual(JSON.parse(a.store.raw)["2032-05-11"], incoming);
  assert.deepEqual([...a.store.settingValues], before); assert.equal(a.store.settingWrites.length, 2);
  assert.equal(Object.keys(JSON.parse(a.store.raw)["2032-05-11"]).length, 13);
});
test("four copy actions retain formats after settings edits", async () => {
  const a = app(); openSettings(a); edit(a); value(a, "weightMin", "54"); save(a); a.get("settings-back").click();
  a.window.isSecureContext = true;
  for (const id of ["copy-exercise", "copy-body", "copy-weekly", "copy-weekly-body"]) await a.get(id).click();
  assert.equal(a.copies.length, 4);
  const exercise = a.copies[0][0].data, body = a.copies[1][0].data;
  assert.deepEqual(Object.keys(exercise).sort(), ["text/html", "text/plain"]);
  assert.equal((await exercise["text/plain"].text()).split("\t").length, 9);
  assert.equal((await body["text/plain"].text()).split("\t").length, 3);
  assert.equal(a.copies[2].split("\n")[0].split("\t").length, 10); assert.equal(typeof a.copies[3], "string");
  assert.equal(a.store.writes, 0);
});
for (const width of [320, 375, 390, 430]) test(`settings layout uses contained fields and touch targets at ${width}px`, () => {
  const a = app(fixture(), { width }); openSettings(a); edit(a); edit(a, "attention");
  for (const group of ["goals", "attention"]) for (const name of settingsModel.fields(group)) {
    assert.equal(a.get(`settings-${group}-${name}`).attrs.inputmode, name === "compareDays" ? "numeric" : "decimal");
  }
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /\.settings-fields\s*\{[^}]*minmax\(0, 1fr\)/);
  assert.match(css, /\.settings-input-unit input\s*\{[^}]*min-width: 0;[^}]*min-height: 48px;[^}]*font-size: 16px/);
  assert.equal(a.store.writes, 0);
});
