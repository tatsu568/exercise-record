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
const achievement = (a, field) => a.get("summary-achievement-cards").children.find(item => item.dataset.field === field);

test("six compact achievement cards show names and symbols then counts and rates, and toggling leaves the graph and storage alone", () => {
  const a = app({
    "2041-04-15": { squat: 10, march: 1, plank: 30, standing: 10, walkSteps: "100", distance: "1" },
    "2041-04-22": { squat: 10, march: 1, plank: 30, standing: 10, walkSteps: "0", distance: "0" },
    "2041-04-29": { squat: 10, march: 1, plank: 0, standing: 0 }, "2041-05-06": { squat: 10 }
  }, { squat: 10, march: 1, plank: 30, standing: 11, walkSteps: 100 });
  const before = a.store.raw, extras = JSON.stringify([...a.store.extras]); a.openSummary();
  const items = a.get("summary-achievement-cards").children;
  assert.deepEqual(Array.from(items, item => item.dataset.field), ["squat", "march", "plank", "standing", "walkSteps", "distance"]);
  for (const [field, label, symbol, count, rate, level] of [
    ["squat", "スクワット", "★", "4/4週", "100%", "perfect"], ["march", "足踏み", "◎", "3/4週", "75%", "high"],
    ["plank", "プランク", "○", "2/4週", "50%", "half"], ["standing", "スタンディング", "—", "0/4週", "0%", "zero"],
    ["walkSteps", "散歩歩数", "△", "1/4週", "25%", "some"], ["distance", "散歩距離", "—", "—", "目標未設定", "unavailable"]
  ]) {
    const item = achievement(a, field);
    assert.equal(item.children.length, 2); assert.equal(item.dataset.level, level);
    assert.deepEqual(Array.from(item.children[0].children, e => e.textContent), [label, symbol]);
    assert.deepEqual(Array.from(item.children[1].children, e => e.textContent), [count, rate]);
  }
  const graph = JSON.stringify(a.get("summary-plot").children), state = a.summary.getState(), scrolls = a.scrolls.length;
  a.get("summary-achievement-all").click();
  assert.equal(a.get("summary-achievement-all").attrs["aria-pressed"], "true");
  assert.equal(a.get("summary-achievement-4w").attrs["aria-pressed"], "false");
  assert.equal(JSON.stringify(a.get("summary-plot").children), graph); assert.deepEqual(a.summary.getState(), state); assert.equal(a.scrolls.length, scrolls);
  assert.equal(a.store.raw, before); assert.equal(JSON.stringify([...a.store.extras]), extras); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("four-week achievements follow buttons and swipes while all-time stays independent and returns to the chosen period", () => {
  const a = app(records(), { squat: 10 }), before = a.store.raw; a.openSummary();
  const result = () => text(achievement(a, "squat"));
  assert.match(result(), /1\/4週 25%/);
  a.get("summary-previous").click(); assert.match(result(), /0\/4週 0%/);
  a.get("summary-next").click(); assert.match(result(), /1\/4週 25%/);
  a.get("summary-achievement-all").click(); assert.match(result(), /1\/8週 13%/);
  a.get("summary-previous").click(); assert.match(result(), /1\/8週 13%/);
  a.get("summary-achievement-4w").click(); assert.match(result(), /0\/4週 0%/);
  a.get("summary-latest").click(); assert.match(result(), /1\/4週 25%/);
  const screen = a.get("summary-screen");
  screen.fire("touchstart", { touches: [{ clientX: 100, clientY: 180 }] });
  screen.fire("touchend", { touches: [], changedTouches: [{ clientX: 220, clientY: 183 }] });
  assert.match(result(), /0\/4週 0%/);
  screen.fire("touchstart", { touches: [{ clientX: 250, clientY: 180 }] });
  screen.fire("touchend", { touches: [], changedTouches: [{ clientX: 130, clientY: 183 }] });
  assert.match(result(), /1\/4週 25%/);
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0);
});

test("current goals and record changes refresh historical achievements and errors clear stale ratings without writes", () => {
  const settingsModel = require("../app-settings.js"), a = app(records(), { squat: 5 }), before = a.store.raw;
  a.openSummary(); a.get("summary-achievement-all").click(); assert.match(text(achievement(a, "squat")), /2\/8週 25%/);
  a.store.extras.set(settingsModel.KEYS.exerciseGoals, JSON.stringify({ schemaVersion: 1, values: { ...settingsModel.DEFAULTS.exerciseGoals, squat: 10 } }));
  a.emit("storage", { key: settingsModel.KEYS.exerciseGoals }); assert.match(text(achievement(a, "squat")), /1\/8週 13%/);
  a.store.raw = JSON.stringify({ "2041-04-15": { squat: 10 } }); a.emit("storage", { key: "exercise-record.entries.v1" });
  assert.match(text(achievement(a, "squat")), /1\/4週 25%/);
  a.store.raw = "{broken"; a.emit("focus"); assert.match(text(achievement(a, "squat")), /確認不可/);
  assert.equal(achievement(a, "squat").dataset.level, "unavailable");
  a.store.raw = before; a.store.extras.set(settingsModel.KEYS.exerciseGoals, "{broken"); a.emit("focus");
  assert.match(text(achievement(a, "squat")), /確認不可/);
  assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

test("all-time without a full recorded week is unaggregated while an empty four-week period has zero achieved weeks", () => {
  for (const data of [{}, { "2041-05-12": { squat: 10 } }]) {
    const a = app(data, { squat: 10 }); a.openSummary(); a.get("summary-achievement-all").click();
    assert.match(text(achievement(a, "squat")), /未集計/); assert.doesNotMatch(text(achievement(a, "squat")), /0%/);
    assert.equal(achievement(a, "squat").dataset.level, "unavailable");
  }
  const a = app({}, { squat: 10 }); a.openSummary(); assert.match(text(achievement(a, "squat")), /0\/4週 0%/);
});

test("achievement section follows the graph, uses two-column rows and accessible colors, with rules in the existing details", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8"), css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
  assert.match(html, /id="summary-plot"[\s\S]*?id="summary-achievement-heading">目標達成状況[\s\S]*?id="summary-achievement-cards" class="summary-cards"[\s\S]*?class="summary-notes"/);
  assert.match(css, /\.summary-cards\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.summary-weekly-row\s*\{[^}]*display: flex;[^}]*justify-content: space-between/);
  for (const color of ["#2563eb", "#23865a", "#ad5e18", "#936d00"]) assert.ok(css.includes(`--achievement-color: ${color}`));
  assert.match(html, /記録のない週も対象に含み、未達成/); assert.match(html, /記号は丸め前の達成週率で判定/);
});

test("summary swipes move one completed four-week period through existing controls without touching stored data", () => {
  const a = app(records(), { squat: 5 }), before = a.store.raw; a.openSummary();
  const swipe = (start, end, target = {}) => {
    const screen = a.get("summary-screen");
    screen.fire("touchstart", { target, touches: [{ clientX: start, clientY: 180 }] });
    screen.fire("touchend", { touches: [], changedTouches: [{ clientX: end, clientY: 183 }] });
  };
  swipe(100,220); assert.equal(a.summary.getState().range.end, "2041-04-14");
  assert.equal(text(value(a, "squat")), "5回"); assert.equal(card(a, "squat").children[2].textContent, "達成率 25%");
  swipe(250,130); assert.equal(a.summary.getState().range.end, "2041-05-12");
  swipe(250,130); assert.equal(a.summary.getState().range.end, "2041-05-12");
  swipe(100,220,{ closest: () => ({}) }); assert.equal(a.summary.getState().range.end, "2041-05-12");
  card(a, "standing").click(); assert.equal(a.summary.getState().field, "standing");
  a.get("input-show").click(); swipe(100,220); assert.equal(a.summary.getState().range.end, "2041-05-12");
  assert.equal(a.store.raw, before); assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
});

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
  const scrolls = []; a.get("summary-heading").scrollIntoView = options => scrolls.push(options);
  const titles = { squat: "スクワット・週ごとの合計 (回)", march: "足踏み・週ごとの合計 (回)", plank: "プランク・週ごとの合計 (秒)",
    standing: "スタンディング・週ごとの平均 (H)", walkSteps: "散歩歩数・週ごとの合計 (歩)", distance: "散歩距離・週ごとの合計 (km)" };
  for (const field of ["squat", "march", "plank", "standing", "walkSteps", "distance"]) {
    card(a, field).click(); assert.equal(a.summary.getState().field, field);
    assert.equal(a.get("summary-chart-heading").textContent, titles[field]);
    assert.equal(card(a, field).children[0].children[0].textContent, titles[field].split("・")[0] + (field === "standing" ? "平均" : "合計"));
    assert.equal(a.get("summary-plot").dataset.field, field);
    assert.equal(a.get("summary-plot").children.length, 1); assert.equal(weeks(a).length, 4);
    assert.equal(a.get("summary-cards").children.filter(item => item.attrs["aria-pressed"] === "true").length, 1);
    assert.deepEqual(scrolls.at(-1), { block: "start", behavior: "auto" });
  }
  assert.equal(scrolls.length, 6);
  assert.deepEqual(Array.from(weeks(a), item => item.attrs["data-value"]), ["1.2", "0", "", ""]);
  assert.match(text(a.get("summary-plot")), /データなし/); assert.equal(a.store.writes, 0);
  a.summary.refresh(); assert.equal(scrolls.length, 6);
  a.get("summary-previous").click(); assert.equal(scrolls.length, 7);
});

test("only actual button and swipe period changes scroll to the heading after rendering", () => {
  const a = app(), before = a.store.raw, extras = JSON.stringify([...a.store.extras]); a.openSummary();
  const scrolls = [];
  a.get("summary-heading").scrollIntoView = options => scrolls.push({ options,
    range: a.get("summary-range").textContent, values: Array.from(weeks(a), item => item.attrs["data-value"]) });
  a.get("summary-latest").click(); a.get("summary-next").click(); assert.equal(scrolls.length, 0);
  a.get("summary-previous").click();
  assert.equal(scrolls.length, 1); assert.equal(scrolls[0].range, "2041/3/18(月)〜4/14(日)");
  assert.deepEqual(scrolls[0].values, ["5", "", "", ""]);
  a.get("summary-next").click();
  assert.equal(scrolls.length, 2); assert.equal(scrolls[1].range, "2041/4/15(月)〜5/12(日)");
  assert.deepEqual(scrolls[1].values, ["15", "0", "", ""]);
  a.get("summary-previous").click(); a.get("summary-latest").click(); assert.equal(scrolls.length, 4);
  // Also exercise the no-change handlers without the disabled button guard.
  a.get("summary-latest").fire("click"); a.get("summary-next").fire("click"); assert.equal(scrolls.length, 4);
  const swipe = (start, end) => {
    a.get("summary-screen").fire("touchstart", { touches: [{ clientX: start, clientY: 180 }] });
    a.get("summary-screen").fire("touchend", { touches: [], changedTouches: [{ clientX: end, clientY: 183 }] });
  };
  swipe(100, 220); assert.equal(scrolls.length, 5); assert.equal(a.summary.getState().range.end, "2041-04-14");
  swipe(250, 130); assert.equal(scrolls.length, 6); assert.equal(a.summary.getState().range.end, "2041-05-12");
  swipe(250, 130); assert.equal(scrolls.length, 6);
  a.summary.refresh(); a.emit("focus"); a.emit("resize");
  for (const screen of ["graph", "input", "summary"]) a.get(screen + "-show").click();
  assert.equal(scrolls.length, 6);
  for (const item of scrolls) assert.deepEqual(item.options, { block: "start", behavior: "auto" });
  assert.equal(a.store.raw, before); assert.equal(JSON.stringify([...a.store.extras]), extras);
  assert.equal(a.store.writes, 0); assert.equal(a.store.ackWrites, 0);
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
  assert.match(section, /id="summary-cards"[\s\S]*?id="summary-plot"[^>]*><\/div>[\s\S]*?id="summary-achievement-cards"[^>]*><\/div>\s*<\/section>\s*<div class="summary-notes">\s*<p id="summary-aggregation-note"/);
  assert.match(section, /項目横の\(7\/28\)は、運動5項目では実施日数、スタンディングでは平均対象日数です。未記録と0は区別します。/);
  assert.match(section, /散歩はアプリに記録した分だけが対象です。<\/p>\s*<details class="summary-details">\s*<summary>集計について詳しく<\/summary>/);
  assert.match(section, /保存された有効値だけを集計し、空欄・欠落・不正値は除外/);
  for (const explanation of ["保存済み記録日数", "0より大きい実績の実施日数", "保存された0は有効値", "初期値10H", "実際の活動時間を保証するものではありません", "各週は月曜〜日曜", "平均・平均との差は小数第2位", "週間目標の4倍", "1日目標を直接比較", "記録不足を補完せず"]) assert(section.includes(explanation), explanation);
  assert.match(section, /<\/details>\s*<\/div>\s*<\/section>/);
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
