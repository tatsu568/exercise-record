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
function app(data = records(), goals = {}) {
  const settingsModel = require("../app-settings.js");
  const a = context.module.exports.app(data, { today: "2041-05-13", extras: { [settingsModel.KEYS.exerciseGoals]: JSON.stringify({ schemaVersion: 1, values: { ...settingsModel.DEFAULTS.exerciseGoals, ...goals } }) } });
  a.summary = view.mount({ document: a.document, window: a.window, storage: a.store, navigation: a.nav, today: () => a.now.value });
  a.openSummary = () => a.get("summary-show").click();
  return a;
}
const card = (a, field) => a.get("summary-cards").children.find(item => item.dataset.field === field);
const value = (a, field) => card(a, field).children[1].children[0];
const text = (element) => [element.textContent, ...element.children.map(text)].join(element.className === "summary-card-value" ? "" : " ");
const weeks = (a) => a.get("summary-plot").children[0].children.filter(item => item.attrs?.class === "summary-week");

test("summary mounts as a fourth read-only tab, with six selectable cards and current/prior periods", () => {
  const a = app(), before = a.store.raw; a.openSummary();
  assert.equal(a.nav.current(), "summary"); assert.equal(a.get("input-screen").hidden, true);
  assert.equal(a.get("summary-range").textContent, "2041/4/15(月)〜5/12(日)");
  assert.equal(a.get("summary-comparison-range").textContent, "比較：2041/3/18(月)〜4/14(日)");
  assert.equal(a.get("summary-saved-days").textContent, "(2/28)");
  assert.equal(a.get("summary-cards").children.length, 6); assert.equal(a.get("summary-next").disabled, true);
  assert.equal(card(a, "squat").attrs["aria-pressed"], "true"); assert.match(text(card(a, "squat")), /15回.*目標未設定/);
  assert.equal(card(a, "squat").children[2].dataset.achieved, "false");
  assert.match(text(card(a, "standing")), /スタンディング平均.*\(2\/28\).*11H/);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("each card selects the same single four-week graph, including no-data weeks and saved zeros", () => {
  const a = app(); a.openSummary();
  const titles = { squat: "スクワット・週ごとの合計 (回)", march: "足踏み・週ごとの合計 (回)", plank: "プランク・週ごとの合計 (秒)",
    standing: "スタンディング・週ごとの平均 (H)", walkSteps: "散歩歩数・週ごとの合計 (歩)", distance: "散歩距離・週ごとの合計 (km)" };
  for (const field of ["squat", "march", "plank", "standing", "walkSteps", "distance"]) {
    card(a, field).click(); assert.equal(a.summary.getState().field, field);
    assert.equal(a.get("summary-chart-heading").textContent, titles[field]);
    assert.equal(card(a, field).children[0].children[0].textContent, titles[field].split("・")[0] + (field === "standing" ? "平均" : "合計"));
    assert.equal(a.get("summary-plot").dataset.field, field);
    assert.equal(a.get("summary-plot").children.length, 1); assert.equal(weeks(a).length, 4);
    assert.equal(a.get("summary-cards").children.filter(item => item.attrs["aria-pressed"] === "true").length, 1);
  }
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["1.2", "0", "", ""]);
  assert.match(text(a.get("summary-plot")), /データなし/); assert.equal(a.store.writes, 0);
});

test("28-day navigation updates totals, comparisons and graph together and preserves the selected metric", () => {
  const a = app(); a.openSummary(); card(a, "standing").click(); a.get("summary-previous").click();
  assert.equal(a.get("summary-range").textContent, "2041/3/18(月)〜4/14(日)");
  assert.equal(a.get("summary-saved-days").textContent, "(1/28)");
  assert.match(text(card(a, "standing")), /8H.*目標未設定/); assert.equal(weeks(a)[0].attrs["data-value"], "8");
  assert.equal(a.get("summary-next").disabled, false); a.get("summary-next").click();
  assert.match(text(card(a, "standing")), /11H/); assert.equal(a.summary.getState().field, "standing");
  assert.equal(a.get("summary-next").disabled, true); assert.equal(a.get("summary-saved-days").textContent, "(2/28)"); assert.equal(a.store.writes, 0);
});

test("an empty period can still move and displays no data, never invented zeros", () => {
  const a = app({}); a.openSummary(); assert.equal(a.get("summary-saved-days").textContent, "(0/28)");
  assert(a.get("summary-cards").children.every(item => /データなし.*目標未設定/.test(text(item))));
  a.get("summary-previous").click(); assert.equal(a.get("summary-next").disabled, false); assert.equal(a.store.writes, 0);
});

test("latest returns from past periods using today's local date and synchronizes cards/comparisons/graph without writes", () => {
  const a = app(), before = a.store.raw; a.openSummary(); assert.equal(a.get("summary-latest").disabled, true);
  card(a, "distance").click(); a.get("summary-previous").click(); a.get("summary-previous").click();
  assert.equal(a.get("summary-latest").disabled, false);
  // Recompute from the clock, even if a newer week arrived while viewing history.
  a.now.value = "2041-05-20"; a.get("summary-latest").click();
  assert.equal(a.summary.getState().range.end, "2041-05-19"); assert.equal(a.summary.getState().field, "distance");
  for (const [field, label] of Object.entries({ squat: "0回", march: "0回", plank: "0秒", standing: "12H", walkSteps: "データなし", distance: "0km" })) {
    assert.equal(text(value(a, field)), label);
  }
  assert.match(text(card(a, "distance")), /目標未設定/);
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["0", "", "", ""]);
  assert.equal(a.get("summary-next").disabled, true); assert.equal(a.get("summary-latest").disabled, true);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("aggregation and chart notes stay below the graph and explain the header day counts", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const section = html.slice(html.indexOf('<section id="summary-screen"'), html.indexOf('<section id="settings-screen"'));
  assert.match(section, /class="summary-period-heading">\s*<p id="summary-range"[^>]*><\/p>\s*<p id="summary-saved-days"><\/p>\s*<\/div>\s*<div class="summary-period-actions"/);
  assert.match(section, /id="summary-cards"[\s\S]*?id="summary-plot"[^>]*><\/div>\s*<\/section>\s*<div class="summary-notes">\s*<p id="summary-aggregation-note"/);
  assert.match(section, /保存された値だけを集計します。空欄・欠落・不正値は対象外です。スタンディングは保存済みの値の平均で、初期値10を含む場合があります。実際の活動時間を保証するものではありません。\(○\/28\)は、期間横では保存済み記録日数、運動5項目では0より大きい実績の実施日数、スタンディングでは平均対象日数を表します。目標は現在の設定を全期間に適用します。記録が不足している場合も補完せず、保存済みの実績で達成率を計算します。<\/p>\s*<p id="summary-graph-note"/);
  assert.match(section, /各週は月曜〜日曜です。データなしは棒を表示せず、保存された0は基準線と「0」で表示します。平均・平均との差は小数第2位まで表示します。<\/p>\s*<\/div>\s*<\/section>/);
});

test("card values retain step separators and show signed goal differences with achievement badges", () => {
  const data = {
    "2041-02-18": day({ walkSteps: "28892" }),
    "2041-03-18": day({ squat: 150, plank: 300, walkSteps: "17220", distance: "1.2" }),
    "2041-04-15": day({ squat: 310, plank: 150, standing: 15, walkSteps: "19831" }),
    "2041-04-22": day({ standing: 16 })
  };
  const a = app(data, { squat: 80, march: 1, plank: 30, standing: 15, walkSteps: 4707.75, distance: 3 }), before = a.store.raw; a.openSummary();
  for (const [field, number, unit] of [["walkSteps", "19,831", "歩"], ["standing", "15.5", "H"], ["squat", "310", "回"]]) {
    const v = value(a, field);
    assert.equal(v.children[0].className, "summary-card-number"); assert.equal(v.children[0].textContent, number);
    assert.equal(v.children[1].className, "summary-card-unit"); assert.equal(v.children[1].textContent, unit);
  }
  for (const [field, difference, rate, achieved] of [["walkSteps", "目標+1,000", "105", true], ["plank", "目標+30", "125", true],
    ["squat", "目標−10", "97", false], ["march", "目標−4", "0", false], ["standing", "目標+0.5", "103", true]]) {
    assert.equal(card(a, field).children[1].children[1].textContent, difference);
    assert.equal(card(a, field).children[2].textContent, `達成率 ${rate}%`); assert.equal(card(a, field).children[2].dataset.achieved, String(achieved));
  }
  assert.equal(card(a, "distance").children[2].textContent, "達成率 判定不可");
  assert.equal(card(a, "distance").children[1].children[1].textContent, "");
  assert.doesNotMatch(text(a.get("summary-cards")), /前4週比|↗|↘/);
  a.get("summary-previous").click();
  assert.equal(card(a, "walkSteps").children[1].children[1].textContent, "目標−1,611");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("summary periods retain both years across New Year and abbreviate the end year within one year", () => {
  const a = app({}); a.now.value = "2041-01-07"; a.openSummary();
  assert.equal(a.get("summary-range").textContent, "2040/12/10(月)〜2041/1/6(日)");
  assert.equal(a.get("summary-comparison-range").textContent, "比較：2040/11/12(月)〜12/9(日)");
  assert.equal(a.store.writes, 0);
});

test("distance goal differences omit only their unit and retain fractional deficits and zero", () => {
  const a = app({ "2041-04-15": { distance: "1.2" }, "2041-03-18": { distance: "2.4" } }, { distance: .6 }), before = a.store.raw;
  a.openSummary(); assert.equal(card(a, "distance").children[1].children[1].textContent, "目標−1.2");
  assert.equal(text(value(a, "distance")), "1.2km"); assert.equal(card(a, "distance").children[2].textContent, "達成率 50%");
  a.get("summary-previous").click(); assert.equal(card(a, "distance").children[1].children[1].textContent, "目標±0");
  assert.equal(text(value(a, "distance")), "2.4km"); assert.equal(card(a, "distance").children[2].dataset.achieved, "true");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("weekly target lines switch with the metric and current goals apply to past periods without writes", () => {
  const settingsModel = require("../app-settings.js"), a = app(records(), { squat: 80, standing: 15 }), before = a.store.raw;
  const line = () => a.get("summary-plot").children[0].children.find(e => e.attrs?.class === "summary-goal-line");
  const label = () => a.get("summary-plot").children[0].children.find(e => e.attrs?.class === "summary-goal-label");
  a.openSummary(); assert.equal(line().attrs["data-goal"], "80"); assert.equal(label().textContent, "目標 80回／週");
  assert.ok(Number(line().attrs.y1) >= 36 && Number(line().attrs.y1) <= 172); assert.equal(line().attrs.y1, line().attrs.y2);
  card(a, "standing").click(); assert.equal(line().attrs["data-goal"], "15"); assert.equal(label().textContent, "目標 15H／日");
  a.get("summary-previous").click(); assert.equal(line().attrs["data-goal"], "15"); assert.equal(card(a, "standing").children[1].children[1].textContent, "目標−7");
  a.store.extras.set(settingsModel.KEYS.exerciseGoals, JSON.stringify({ schemaVersion: 1, values: { ...settingsModel.DEFAULTS.exerciseGoals, standing: 8 } }));
  a.emit("storage", { key: settingsModel.KEYS.exerciseGoals }); assert.equal(line().attrs["data-goal"], "8");
  assert.equal(card(a, "standing").children[2].textContent, "達成率 100%"); assert.equal(card(a, "standing").children[1].children[1].textContent, "目標±0");
  card(a, "distance").click(); assert.equal(line(), undefined); assert.equal(card(a, "distance").children[2].textContent, "目標未設定");
  a.store.extras.set(settingsModel.KEYS.exerciseGoals, "{broken"); a.emit("focus"); assert.match(a.get("summary-goal-status").textContent, /破損/);
  assert.equal(a.store.extras.get(settingsModel.KEYS.exerciseGoals), "{broken"); assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("exercise headers exclude saved zero while standing retains all average days, with the existing layout", () => {
  const calendar = require("../body-graph.js");
  const data = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [calendar.addDays("2041-04-15", i), day({ distance: i < 7 ? "0" : "" })]));
  const a = app(data), before = a.store.raw; a.openSummary();
  for (const [field, days] of Object.entries({ squat: 0, march: 0, plank: 0, standing: 28, walkSteps: 0, distance: 0 })) {
    const item = card(a, field), heading = item.children[0];
    assert.equal(item.children.length, 3); assert.equal(heading.className, "summary-card-heading");
    assert.equal(heading.children[1].textContent, `(${days}/28)`);
    assert.equal(heading.children[1].attrs["aria-label"], `28日間のうち${field === "standing" ? "平均対象日数" : "実施日数"}${days}日`);
    assert.equal(value(a, field).tag, "strong"); assert.doesNotMatch(text(value(a, field)), /\/28/);
    assert.doesNotMatch(text(item), /データのある日|平均対象/);
  }
  assert.equal(text(value(a, "standing")), "10H");
  assert.equal(text(value(a, "distance")), "0km");
  assert.equal(text(value(a, "walkSteps")), "データなし");
  assert.equal(value(a, "walkSteps").children[1].textContent, "");
  assert.equal(a.get("summary-saved-days").textContent, "(28/28)");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
  a.store.failRead = true; a.summary.refresh();
  assert.equal(card(a, "standing").children[0].children[1].textContent, "(—/28)");
});

test("performed header counts update across periods independently of saved days and weekly goal lines", () => {
  const a = app(records(), { squat: 5, distance: .3, standing: 11 }), before = a.store.raw;
  const days = field => card(a, field).children[0].children[1].textContent;
  a.openSummary();
  for (const [field, count] of Object.entries({ squat: 1, march: 0, plank: 0, standing: 2, walkSteps: 0, distance: 1 })) assert.equal(days(field), `(${count}/28)`);
  assert.equal(a.get("summary-saved-days").textContent, "(2/28)"); assert.equal(text(value(a, "squat")), "15回");
  assert.equal(card(a, "squat").children[1].children[1].textContent, "目標−5"); assert.equal(card(a, "squat").children[2].textContent, "達成率 75%");
  card(a, "distance").click(); const plot = JSON.stringify(a.get("summary-plot").children);
  assert.equal(card(a, "distance").children[2].textContent, "達成率 100%");
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["1.2", "0", "", ""]);
  a.get("summary-previous").click(); assert.equal(days("squat"), "(1/28)"); assert.equal(days("distance"), "(0/28)");
  assert.equal(days("standing"), "(1/28)"); assert.equal(a.get("summary-saved-days").textContent, "(1/28)");
  a.get("summary-latest").click(); assert.equal(days("distance"), "(1/28)"); assert.equal(JSON.stringify(a.get("summary-plot").children), plot);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("storage/focus rereads update data without writes and corrupt JSON clears stale totals safely", () => {
  const a = app(); a.openSummary(); a.store.raw = JSON.stringify({ "2041-04-15": { squat: 25 } });
  a.emit("storage", { key: "exercise-record.entries.v1" }); assert.match(text(card(a, "squat")), /25回/);
  a.store.raw = "{broken"; a.emit("focus"); assert.match(a.get("summary-status").textContent, /JSON/);
  assert.match(text(card(a, "squat")), /表示できません/); assert.equal(a.get("summary-saved-days").textContent, "(—/28)");
  assert.match(a.get("summary-saved-days").attrs["aria-label"], /確認できません/);
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
