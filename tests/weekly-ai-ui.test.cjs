"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");
const model = require("../weekly-ai.js"), calendar = require("../body-graph.js");
const fixture = path.join(__dirname, "graph-ui.test.cjs"), context = { require: createRequire(fixture), __dirname, module: { exports: {} }, console, Date, AbortController, Blob };
vm.runInNewContext(fs.readFileSync(fixture, "utf8").split("\ntest(")[0] + "\nmodule.exports={app};", context);
const app = ai => context.module.exports.app({}, { browserBoot: true, extras: ai ? { [model.KEY]: JSON.stringify(ai) } : {} });
const descendants = el => [el, ...el.children.flatMap(descendants)];
const points = a => descendants(a.get("ai-plot")).filter(e => e.dataset.aiDate);
const paths = a => descendants(a.get("ai-plot")).filter(e => e.attrs.class === "ai-average-line");
const preview = (a, text) => { a.get("ai-paste").value = text; a.get("ai-paste").fire("input"); a.get("ai-preview-button").click(); };
const confirm = a => { a.get("ai-confirm").checked = true; a.get("ai-confirm").fire("change"); };
test("AI section has closed import/prompt details and saves a fictional 23-week TSV independently of any daily entries", async () => {
  const a = app(), daily = a.store.raw; a.get("summary-show").click();
  assert.equal(a.get("ai-selected-week").textContent, "評価なし"); assert.equal(a.get("ai-previous").disabled, true); assert.equal(a.get("ai-next").disabled, true);
  const text = Array.from({ length: 23 }, (_, i) => `${calendar.addDays("2041-01-07", i * 7)}\t${70 + i}${i < 12 ? "\t架空の総評" : ""}`).join("\n");
  preview(a, text); assert.equal(a.get("ai-preview").children.length, 23); assert.equal(a.store.aiWrites, 0); assert.match(a.get("ai-totals").textContent, /追加23週/);
  confirm(a); await a.get("ai-save").click(); assert.equal(a.store.aiWrites, 1); assert.equal(a.store.raw, daily); assert.equal(a.store.writes, 0);
  assert.equal(points(a).length, 23); assert.equal(a.get("ai-selected-score").textContent, "92/100点"); assert.equal(a.get("ai-selected-comment").textContent, "総評：登録なし");
  assert.equal(a.get("ai-next").disabled, true); assert.match(a.get("ai-import-status").textContent, /照合が完了/);
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /<details class="card ai-details">\s*<summary>評価データを取り込む/); assert.match(html, /<details class="card ai-details">\s*<summary>ChatGPTへの依頼文/);
  assert.doesNotMatch(html, /全期間表示。移動平均は対象週を含む直近4暦週/);
});
test("AI graph point selection, previous/next and average toggle preserve score comments period and stored values", () => {
  const values = { "2041-01-07": { score: 0, comment: "<script>literal</script>" }, "2041-01-21": { score: 100, comment: "" }, "2041-03-11": { score: 80, comment: "third" } };
  const a = app(values), before = a.store.extras.get(model.KEY); a.get("summary-show").click();
  assert.equal(points(a).length, 3); assert.equal(paths(a).length, 1);
  const scoreLine = descendants(a.get("ai-plot")).find(e => e.attrs.class === "ai-score-line");
  const positions = scoreLine.attrs.points.split(" ").map(pair => pair.split(",").map(Number));
  assert.equal(positions.length, 3); assert.ok(Math.abs((positions[2][0] - positions[1][0]) / (positions[1][0] - positions[0][0]) - 3.5) < 1e-10);
  assert.equal((paths(a)[0].attrs.d.match(/ C /g) || []).length, 2);
  a.get("ai-plot").fire("click", { target: points(a)[0] }); assert.equal(a.get("ai-selected-score").textContent, "0/100点");
  assert.equal(a.get("ai-selected-comment").textContent, "総評：<script>literal</script>"); assert.equal(a.get("ai-previous").disabled, true);
  a.get("ai-next").click(); assert.equal(a.get("ai-selected-score").textContent, "100/100点");
  const week = a.get("ai-selected-week").textContent, scrolls = a.scrolls.length;
  a.get("ai-moving-average").checked = false; a.get("ai-moving-average").fire("change"); assert.equal(paths(a).length, 0); assert.equal(points(a).length, 3);
  assert.equal(a.get("ai-selected-week").textContent, week); assert.equal(a.scrolls.length, scrolls);
  a.get("ai-moving-average").checked = true; a.get("ai-moving-average").fire("change"); assert.equal(paths(a).length, 1);
  a.get("ai-previous").click(); assert.equal(a.get("ai-selected-score").textContent, "0/100点");
  assert.equal(a.store.extras.get(model.KEY), before); assert.equal(a.store.aiWrites, 0); assert.equal(a.store.writes, 0);
});
test("AI errors and canceled previews never save; conflicts default to keep and overwrite requires renewed confirmation", async () => {
  const a = app({ "2041-01-07": { score: 80, comment: "old" } }); a.get("summary-show").click();
  preview(a, "\n2041-01-08\t80"); assert.match(a.get("ai-errors").children[0].textContent, /2行目/); assert.equal(a.get("ai-save").disabled, true);
  preview(a, "2041-01-07\t90\tnew"); const choice = descendants(a.get("ai-preview")).find(e => e.tag === "select"); assert.equal(choice.value, "keep");
  confirm(a); assert.equal(a.get("ai-save").disabled, true);
  choice.value = "replace"; choice.fire("change"); assert.equal(a.get("ai-confirm").checked, false); assert.equal(a.get("ai-save").disabled, true);
  confirm(a); await a.get("ai-save").click(); assert.equal(JSON.parse(a.store.extras.get(model.KEY))["2041-01-07"].score, 90);
  preview(a, "2041-01-14\t70"); a.get("ai-cancel").click(); assert.equal(a.get("ai-save").disabled, true); assert.equal(a.store.aiWrites, 1);
});

test("previous and next evaluations scroll to the AI heading after selection renders, while point taps and unavailable moves do not", () => {
  const values = { "2041-01-07": { score: 70, comment: "first" }, "2041-01-14": { score: 80, comment: "second" } };
  const a = app(values), before = a.store.extras.get(model.KEY), headingScrolls = [];
  a.get("summary-show").click();
  a.get("ai-heading").scrollIntoView = options => {
    headingScrolls.push({ ...options });
    const first = headingScrolls.length === 1;
    assert.equal(a.get("ai-selected-score").textContent, first ? "70/100点" : "80/100点");
    assert.equal(a.get("ai-selected-comment").textContent, first ? "総評：first" : "総評：second");
    assert.equal(points(a)[0].attrs["aria-pressed"], String(first));
    assert.equal(points(a)[1].attrs["aria-pressed"], String(!first));
  };
  const otherScrolls = a.scrolls.length;
  a.get("ai-previous").click();
  assert.deepEqual(headingScrolls, [{ block: "start", behavior: "auto" }]);
  a.get("ai-previous").click();
  a.get("ai-next").click(); assert.equal(a.get("ai-selected-score").textContent, "80/100点");
  assert.deepEqual(headingScrolls, [{ block: "start", behavior: "auto" }, { block: "start", behavior: "auto" }]);
  a.get("ai-next").click();
  a.get("ai-plot").fire("click", { target: points(a)[0] });
  assert.equal(a.get("ai-selected-score").textContent, "70/100点");
  assert.equal(headingScrolls.length, 2); assert.equal(a.scrolls.length, otherScrolls);
  assert.equal(a.store.extras.get(model.KEY), before); assert.equal(a.store.aiWrites, 0); assert.equal(a.store.writes, 0);
});
test("AI copy uses the exact fixed prompt; failed saves and external updates invalidate previews without daily writes", async () => {
  const a = app(); a.get("summary-show").click(); await a.get("ai-copy-prompt").click(); assert.equal(a.copies.at(-1), model.PROMPT);
  preview(a, "2041-01-07\t80"); confirm(a); a.store.failAIWrite = true; await a.get("ai-save").click();
  assert.match(a.get("ai-import-status").textContent, /保存できません/); assert.equal(a.store.aiWrites, 0); assert.equal(a.store.writes, 0);
  a.store.failAIWrite = false; preview(a, "2041-01-07\t80"); confirm(a);
  a.store.extras.set(model.KEY, JSON.stringify({ "2041-01-07": { score: 90, comment: "external" } })); a.emit("storage", { key: model.KEY });
  assert.equal(a.get("ai-save").disabled, true); assert.equal(a.get("ai-selected-score").textContent, "90/100点"); assert.equal(a.store.aiWrites, 0);
});

test("the all-period AI section does not start the surrounding summary period gesture or cancel native scrolling", () => {
  const a = app(); let stopped = false;
  a.get("weekly-ai").fire("touchstart", { stopPropagation() { stopped = true; }, preventDefault() { assert.fail("native scrolling must remain available"); } });
  assert.equal(stopped, true); assert.equal(a.store.aiWrites, 0); assert.equal(a.store.writes, 0);
});
