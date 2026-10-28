"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");
const view = require("../exercise-summary-view.js"), transfer = require("../record-transfer.js");
// Reuse the existing mock input/navigation/graph environment, without its tests.
const fixturePath = path.join(__dirname, "graph-ui.test.cjs");
const prefix = fs.readFileSync(fixturePath, "utf8").split("\ntest(")[0];
const context = { require: createRequire(fixturePath), __dirname, module: { exports: {} }, console, Date, AbortController, Blob };
vm.runInNewContext(prefix + "\nmodule.exports={app};", context);
const day = (fields = {}) => ({ ...transfer.DEFAULT_ENTRY, ...fields });
const records = () => ({ "2041-03-18": day({ squat: 5, standing: 8 }), "2041-04-15": day({ squat: 15, standing: 10, distance: "1.2" }),
  "2041-04-22": day({ standing: 12, distance: "0" }) });
function app(data = records()) {
  const a = context.module.exports.app(data, { today: "2041-05-13" });
  a.summary = view.mount({ document: a.document, window: a.window, storage: a.store, navigation: a.nav, today: () => a.now.value });
  a.openSummary = () => a.get("summary-show").click();
  return a;
}
const card = (a, field) => a.get("summary-cards").children.find(item => item.dataset.field === field);
const text = (element) => [element.textContent, ...element.children.map(text)].join(" ");
const weeks = (a) => a.get("summary-plot").children[0].children.filter(item => item.attrs?.class === "summary-week");

test("summary mounts as a fourth read-only tab, with six selectable cards and current/prior periods", () => {
  const a = app(), before = a.store.raw; a.openSummary();
  assert.equal(a.nav.current(), "summary"); assert.equal(a.get("input-screen").hidden, true);
  assert.match(a.get("summary-range").textContent, /2041\/04\/15.*2041\/05\/12/);
  assert.match(a.get("summary-comparison-range").textContent, /2041\/03\/18.*2041\/04\/14/);
  assert.equal(a.get("summary-saved-days").textContent, "記録日数：2 / 28日");
  assert.equal(a.get("summary-cards").children.length, 6); assert.equal(a.get("summary-next").disabled, true);
  assert.equal(card(a, "squat").attrs["aria-pressed"], "true"); assert.match(text(card(a, "squat")), /15回.*\+10回/);
  assert.equal(card(a, "squat").children[2].dataset.direction, "increase");
  assert.match(text(card(a, "standing")), /スタンディング平均.*\(2\/28\).*11時間/);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("each card selects the same single four-week graph, including no-data weeks and saved zeros", () => {
  const a = app(); a.openSummary();
  for (const field of ["squat", "march", "plank", "standing", "walkSteps", "distance"]) {
    card(a, field).click(); assert.equal(a.summary.getState().field, field);
    assert.equal(a.get("summary-plot").dataset.field, field);
    assert.equal(a.get("summary-plot").children.length, 1); assert.equal(weeks(a).length, 4);
    assert.equal(a.get("summary-cards").children.filter(item => item.attrs["aria-pressed"] === "true").length, 1);
  }
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["1.2", "0", "", ""]);
  assert.match(text(a.get("summary-plot")), /データなし/); assert.equal(a.store.writes, 0);
});

test("28-day navigation updates totals, comparisons and graph together and preserves the selected metric", () => {
  const a = app(); a.openSummary(); card(a, "standing").click(); a.get("summary-previous").click();
  assert.match(a.get("summary-range").textContent, /2041\/03\/18.*2041\/04\/14/);
  assert.match(text(card(a, "standing")), /8時間.*比較不可/); assert.equal(weeks(a)[0].attrs["data-value"], "8");
  assert.equal(a.get("summary-next").disabled, false); a.get("summary-next").click();
  assert.match(text(card(a, "standing")), /11時間/); assert.equal(a.summary.getState().field, "standing");
  assert.equal(a.get("summary-next").disabled, true); assert.equal(a.store.writes, 0);
});

test("an empty period can still move and displays no data, never invented zeros", () => {
  const a = app({}); a.openSummary(); assert.equal(a.get("summary-saved-days").textContent, "記録日数：0 / 28日");
  assert(a.get("summary-cards").children.every(item => /データなし.*比較不可/.test(text(item))));
  a.get("summary-previous").click(); assert.equal(a.get("summary-next").disabled, false); assert.equal(a.store.writes, 0);
});

test("latest returns from past periods using today's local date and synchronizes cards/comparisons/graph without writes", () => {
  const a = app(), before = a.store.raw; a.openSummary(); assert.equal(a.get("summary-latest").disabled, true);
  card(a, "distance").click(); a.get("summary-previous").click(); a.get("summary-previous").click();
  assert.equal(a.get("summary-latest").disabled, false);
  // Recompute from the clock, even if a newer week arrived while viewing history.
  a.now.value = "2041-05-20"; a.get("summary-latest").click();
  assert.equal(a.summary.getState().range.end, "2041-05-19"); assert.equal(a.summary.getState().field, "distance");
  for (const [field, value] of Object.entries({ squat: "0回", march: "0回", plank: "0秒", standing: "12時間", walkSteps: "データなし", distance: "0km" })) {
    assert.equal(card(a, field).children[1].textContent, value);
  }
  assert.match(text(card(a, "distance")), /−1\.2km/);
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["0", "", "", ""]);
  assert.equal(a.get("summary-next").disabled, true); assert.equal(a.get("summary-latest").disabled, true);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("aggregation and chart notes stay below the graph and explain the header day counts", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const section = html.slice(html.indexOf('<section id="summary-screen"'), html.indexOf('<section id="settings-screen"'));
  assert.match(section, /id="summary-cards"[\s\S]*?id="summary-plot"[^>]*><\/div>\s*<\/section>\s*<div class="summary-notes">\s*<p id="summary-aggregation-note"/);
  assert.match(section, /保存された値だけを集計します。空欄・欠落・不正値は対象外です。スタンディングは保存済みの値の平均で、初期値10を含む場合があります。実際の活動時間を保証するものではありません。（7\/28）は、28日間のうち7日分の有効データがあることを表します。<\/p>\s*<p id="summary-graph-note"/);
  assert.match(section, /各週は月曜〜日曜です。データなしは棒を表示せず、保存された0は基準線と「0」で表示します。平均・平均との差は小数第2位まで表示します。<\/p>\s*<\/div>\s*<\/section>/);
});

test("all six header day counts use existing valid-day counts, include saved zero and leave values on their own line", () => {
  const calendar = require("../body-graph.js");
  const data = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [calendar.addDays("2041-04-15", i), day({ distance: i < 7 ? "0" : "" })]));
  const a = app(data), before = a.store.raw; a.openSummary();
  for (const [field, days] of Object.entries({ squat: 28, march: 28, plank: 28, standing: 28, walkSteps: 0, distance: 7 })) {
    const item = card(a, field), heading = item.children[0];
    assert.equal(item.children.length, 3); assert.equal(heading.className, "summary-card-heading");
    assert.equal(heading.children[1].textContent, `(${days}/28)`);
    assert.equal(heading.children[1].attrs["aria-label"], `28日間のうち${days}日分の有効データ`);
    assert.equal(item.children[1].tag, "strong"); assert.doesNotMatch(item.children[1].textContent, /\/28/);
    assert.doesNotMatch(text(item), /データのある日|平均対象/);
  }
  assert.equal(card(a, "standing").children[1].textContent, "10時間");
  assert.equal(card(a, "distance").children[1].textContent, "0km");
  assert.equal(card(a, "walkSteps").children[1].textContent, "データなし");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
  a.store.failRead = true; a.summary.refresh();
  assert.equal(card(a, "standing").children[0].children[1].textContent, "(—/28)");
});

test("storage/focus rereads update data without writes and corrupt JSON clears stale totals safely", () => {
  const a = app(); a.openSummary(); a.store.raw = JSON.stringify({ "2041-04-15": { squat: 25 } });
  a.emit("storage", { key: "exercise-record.entries.v1" }); assert.match(text(card(a, "squat")), /25回/);
  a.store.raw = "{broken"; a.emit("focus"); assert.match(a.get("summary-status").textContent, /JSON/);
  assert.match(text(card(a, "squat")), /表示できません/); assert.match(a.get("summary-saved-days").textContent, /確認できません/);
  assert.equal(a.get("summary-plot").children[0].tag, "p"); assert.equal(a.store.raw, "{broken");
  a.store.raw = "{}"; a.emit("pageshow"); assert.equal(a.get("summary-status").textContent, ""); assert.match(text(card(a, "squat")), /データなし/);
  assert.equal(a.store.writes, 0);
});

test("unreadable storage shows an error and invalid field values are excluded rather than silently summed", () => {
  const a = app({ "2041-04-15": { squat: 3, march: 1 } }); a.openSummary();
  assert.match(a.get("summary-status").textContent, /今回1項目/); assert.match(text(card(a, "squat")), /データなし/);
  assert.match(text(card(a, "march")), /1回/); a.store.failRead = true; a.summary.refresh();
  assert(a.summary.getState().error); assert.equal(a.store.writes, 0);
});

test("latest completed weeks advance on a new Monday while a deliberately chosen past range stays fixed", () => {
  const a = app(); a.openSummary(); a.now.value = "2041-05-20"; a.emit("focus");
  assert.equal(a.summary.getState().range.end, "2041-05-19"); a.get("summary-previous").click();
  const before = a.summary.getState().range; a.now.value = "2041-05-27"; a.emit("focus");
  assert.deepEqual(a.summary.getState().range, before); assert.equal(a.store.writes, 0);
});

test("unsaved input blocks summary navigation and a successful retry restores normal screen switching", async () => {
  const a = app({}); a.store.failWrite = true; a.get("weight").value = "56"; await a.hooks.saveCurrentEntry();
  a.openSummary(); assert.equal(a.nav.current(), "input"); assert.equal(a.get("weight").value, "56");
  a.store.failWrite = false; await a.hooks.saveCurrentEntry(); a.openSummary(); assert.equal(a.nav.current(), "summary");
});

test("real browser module order integrates four tabs and settings returns to summary without writing records", () => {
  const a = context.module.exports.app(records(), { today: "2041-05-13", browserBoot: true }), before = a.store.raw;
  for (const screen of ["summary", "history", "graph", "input", "summary"]) {
    a.get(screen + "-show").click(); assert.equal(a.nav.current(), screen);
    for (const name of ["input", "history", "graph", "summary"]) assert.equal(a.get(name + "-screen").hidden, name !== screen);
  }
  a.get("settings-show").click(); assert.equal(a.nav.current(), "settings"); a.get("settings-back").click(); assert.equal(a.nav.current(), "summary");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});
