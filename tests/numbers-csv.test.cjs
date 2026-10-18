"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const csv = require("../numbers-csv.js");
const transfer = require("../record-transfer.js");
const options = { year: "2032", start: "2032-01-01", end: "2032-12-31", yearConfirmed: true };
const bytes = (text) => new TextEncoder().encode(text);
const header = () => csv.HEADERS.join(",");
const cells = (date = "2/29", values = {}) => {
  const row = Array(15).fill(""); row[1] = date; row[11] = date;
  for (const [index, value] of Object.entries(values)) row[index] = value;
  return row;
};
const encodeCell = (value) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const document = (rows) => [header(), ...rows.map((row) => row.map(encodeCell).join(","))].join("\r\n");
const convert = (rows, settings = {}) => csv.convertRows(csv.readCsv(bytes(document(rows))), { ...options, ...settings });
const walk = (minutes = "", seconds = "", distance = "", steps = "") => ({ walkMinutes: minutes, walkSeconds: seconds, distance, walkSteps: steps });

const walkCases = [
  ["W01", "2500歩", walk("", "", "", "2500")],
  ["W02", "1.2km,12:34,2000歩", walk("12", "34", "1.2", "2000")],
  ["W03", "2.3km 22:15 3100歩", walk("22", "15", "2.3", "3100")],
  ["W04", "17:26 2.4km 2501歩", walk("17", "26", "2.4", "2501")],
  ["W05", "42分 11秒4.2km 4321歩", walk("42", "11", "4.2", "4321")],
  ["W06", "28分2.15km 2201歩", walk("28", "", "2.15", "2201")],
  ["W07", "1234歩", walk("", "", "", "1234")],
  ["W08", "15分07秒 1.1km 1000歩", walk("15", "7", "1.1", "1000")],
  ["W09", "1.7km 19:00 1700歩", walk("19", "0", "1.7", "1700")],
  ["W10", "41秒 900歩", walk("", "41", "", "900")],
  ["W11", "1.25km", walk("", "", "1.25", "")],
  ["W12", "0分 0秒 0km 0歩", walk("0", "0", "0", "0")],
  ["W13", "  18分  4秒   1.6km   1800歩  ", walk("18", "4", "1.6", "1800")],
  ["W14", "20:05 1.6km 1800歩", walk("20", "5", "1.6", "1800")],
  ["W15", "3.2km,25分,3300歩", walk("25", "", "3.2", "3300")],
  ["W16", "30分", walk("30")],
  ["W17", "30分0秒1km", walk("30", "0", "1")],
  ["W18", "0:00 0.0km 0歩", walk("0", "0", "0.0", "0")],
  ["W19", "14分5秒2.4km1200歩", walk("14", "5", "2.4", "1200")],
  ["W20", "4101歩 2.8km 40:02", walk("40", "2", "2.8", "4101")],
  ["W21", "9秒", walk("", "9")],
  ["W22", "2.0km 4444歩", walk("", "", "2.0", "4444")],
  ["W23", "1.3km,6:07,700歩", walk("6", "7", "1.3", "700")]
];
for (const [id, raw, expected] of walkCases) test(id + " fictional walk conversion", () => assert.deepEqual(csv.walkValues(raw), expected));

test("W01-W23 stay identical to the fictional cases in the formal specification", () => {
  const spec = require("node:fs").readFileSync(require("node:path").join(__dirname, "../docs/Numbersデータ変換仕様_v0.1.md"), "utf8");
  for (const [id, raw, expected] of walkCases) {
    const line = spec.split(/\r?\n/).find((value) => value.startsWith(`| ${id} |`));
    assert.ok(line, id); const columns = line.split("|").map((value) => value.trim());
    assert.equal(columns[2].slice(1, -1), raw);
    assert.deepEqual(columns.slice(3, 7).map((value) => value === "—" ? "" : value), Object.values(expected));
  }
});

test("UTF-8 BOM/no BOM and half/full-width standing header are supported", () => {
  for (const bom of ["", "\uFEFF"]) {
    const source = bom + document([cells("2/29", { 7: "〇○" })]).replace("スタンディング", "ｽﾀﾝﾃﾞｨﾝｸﾞ");
    assert.equal(csv.readCsv(bytes(source)).length, 1);
  }
});

test("CSV quoting, commas, embedded newlines, escaped quotes, blanks and line endings", () => {
  for (const ending of ["\n", "\r", "\r\n"]) {
    const text = ['"a,b","line1\nline2","a""b",,', 'last,,,"",'].join(ending);
    for (const final of ["", ending]) assert.deepEqual(csv.parseCsv(text + final), [["a,b", "line1\nline2", 'a"b', "", ""], ["last", "", "", "", ""]]);
  }
  const result = convert([cells("2/29", { 10: "1.2km,12:34,2000歩" })]);
  assert.equal(result.errors.length, 0); assert.equal(result.rows[0].entry.walkSteps, "2000");
});

test("malformed CSV, wrong column count and unexpected headers stop parsing", () => {
  for (const text of ['"unclosed', 'abc"def', '"cell"x', '"cell" ,next']) assert.throws(() => csv.parseCsv(text));
  assert.throws(() => csv.readCsv(bytes(header() + "\n1,2")), /論理行2/);
  assert.throws(() => csv.readCsv(bytes(header().replace("出社", "unknown")))),
  assert.throws(() => csv.readCsv(bytes(header().split(",").reverse().join(","))));
  assert.throws(() => csv.readCsv(bytes(header() + ",extra")));
  assert.throws(() => csv.readCsv(bytes("")));
});

test("invalid UTF-8, replacement characters, NUL and Shift_JIS-like bytes stop import", () => {
  for (const value of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0x82, 0xa0]), bytes(header() + "\uFFFD"), bytes(header() + "\u0000")]) assert.throws(() => csv.readCsv(value));
});

test("base year confirmation, real dates and same-year periods are mandatory", () => {
  for (const settings of [{ year: "" }, { yearConfirmed: false }, { year: 0 }, { year: "2031", start: "2031-02-29", end: "2031-03-01" }, { start: "2032-04-01", end: "2032-03-01" }, { start: "2031-12-31" }, { end: "2033-01-01" }]) assert.throws(() => convert([], settings));
  assert.equal(convert([cells("2/29", { 12: "0" })]).errors.length, 0);
  assert.ok(convert([cells("2/29", { 12: "1" })], { year: "2031", start: "2031-01-01", end: "2031-12-31" }).errors.length);
  assert.ok(convert([cells("2/30", { 12: "1" })]).errors.length);
  assert.ok(convert([cells("2032/2/29", { 12: "1" })]).errors.length);
});

test("both period endpoints included, outside counted and nonexistent rows never generated", () => {
  const result = convert([cells("2/27", { 12: "1" }), cells("2/28", { 12: "2" }), cells("2/29", { 12: "3" }), cells("3/1", { 12: "4" })], { start: "2032-02-28", end: "2032-02-29" });
  assert.equal(result.stats.inside, 2); assert.equal(result.stats.outside, 2);
  assert.deepEqual(Object.keys(csv.selectedRecords(result)), ["2032-02-28", "2032-02-29"]);
});

test("B/L dates agree; only an empty side may omit its date", () => {
  for (const row of [cells("2/29", { 11: "3/1", 12: "1" }), cells("2/29", { 11: "", 12: "1" }), cells("2/29", { 1: "", 7: "○" }), cells("", { 12: "1" })]) {
    const result = convert([row]); assert.match(result.errors[0], /論理行2/); assert.throws(() => csv.selectedRecords(result));
  }
  const result = convert([cells("2/28", { 11: "", 7: "○" }), cells("2/29", { 1: "", 12: "0" })]);
  assert.equal(result.errors.length, 0); assert.equal(Object.keys(csv.selectedRecords(result)).length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("片側")));
});

test("duplicates, reversed ordering and ambiguous year rollover stop the whole import", () => {
  for (const dates of [["2/29", "2/29"], ["3/1", "2/29"], ["12/31", "1/1"]]) {
    const result = convert(dates.map((date) => cells(date, { 12: "1" })));
    assert.ok(result.errors.length); assert.throws(() => csv.selectedRecords(result));
  }
});

test("circle variants and exercise units become the existing types and values", () => {
  const result = convert([cells("2/29", { 3: "〇", 5: "○", 6: "12", 7: "〇 ○〇", 8: "○〇", 9: "〇○〇" })]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows[0].entry, { ...transfer.DEFAULT_ENTRY, work: "在宅", kids: true, standing: 12, squat: 15, march: 2, plank: 90 });
});

test("unknown marks, multiple work options and invalid numeric values fail without guessing", () => {
  for (const data of [{ 2: "○", 4: "〇" }, { 7: "◯" }, { 7: "○note" }, { 8: "○○○" }, { 5: "○○" }, { 6: "0" }, { 6: "21" }, { 6: "10.5" }, { 12: "55kg" }, { 13: "-1" }, { 14: "Infinity" }, { 10: "文字化け" }]) {
    const result = convert([cells("2/29", data)]); assert.ok(result.errors.length, JSON.stringify(data)); assert.throws(() => csv.selectedRecords(result));
  }
});

test("body zero/blank and decimal text are preserved; missing standing is explicitly disclosed", () => {
  const result = convert([cells("2/29", { 12: "0", 13: "0.0", 14: "" })]);
  assert.deepEqual([result.rows[0].entry.weight, result.rows[0].entry.bodyFat, result.rows[0].entry.basal], ["0", "0.0", ""]);
  assert.equal(result.rows[0].entry.standing, 10);
  assert.ok(result.rows[0].notes.some((note) => note.includes("補完")));
});

test("invalid walk text is never partially accepted", () => {
  for (const raw of ["1km 2km", "1分2分", "1:02 3秒", "1km余分", "-1歩", "1.5歩", "2分60秒", "1:234", "1.2.3km", "12", "miles", "○", ", ,", "9007199254740992歩", "1km 2"]) assert.throws(() => csv.walkValues(raw), raw);
  assert.deepEqual(csv.walkValues("15分08秒 1.1km 1000歩"), walk("15", "8", "1.1", "1000"));
  assert.deepEqual(csv.walkValues("36:48 1.4km 3752歩"), walk("36", "48", "1.4", "3752"));
});

test("blank days excluded; standing-only days require individual inclusion", () => {
  const result = convert([cells("2/27"), cells("2/28", { 6: "10" }), cells("2/29", { 12: "0" }), cells("")]);
  assert.equal(result.stats.unrecorded, 1); assert.equal(result.stats.undated, 1); assert.equal(result.stats.ambiguous, 1);
  assert.deepEqual(Object.keys(csv.selectedRecords(result)), ["2032-02-29"]);
  assert.deepEqual(Object.keys(csv.selectedRecords(result, { "2032-02-28": true })), ["2032-02-28", "2032-02-29"]);
  assert.deepEqual(Object.keys(csv.selectedRecords(result, { "2032-02-28": "yes" })), ["2032-02-29"]);
});

test("errors outside the period also stop import, not a partial save", () => {
  const result = convert([cells("2/28", { 10: "bad" }), cells("2/29", { 12: "1" })], { start: "2032-02-29", end: "2032-02-29" });
  assert.equal(result.stats.outside, 1); assert.ok(result.errors.length); assert.throws(() => csv.selectedRecords(result));
});

test("CSV candidates use shared day conflicts, explicit replacement and one verified write", () => {
  const incoming = csv.selectedRecords(convert([cells("2/28", { 12: "0" }), cells("2/29", { 7: "○" })]));
  const previous = { "2032-02-27": { weight: "1" }, "2032-02-28": { ...transfer.DEFAULT_ENTRY, weight: "55", basal: "1200" } };
  const raw = JSON.stringify(previous), plan = transfer.createPlan(raw, incoming);
  assert.equal(plan.rows[0].kind, "conflict");
  assert.equal(transfer.buildCandidate(plan).records["2032-02-28"].basal, "1200");
  let writes = 0, saved = raw;
  const storage = { getItem: () => saved, setItem: (_key, value) => { writes++; saved = value; } };
  assert.equal(writes, 0);
  const result = transfer.commitRecords(storage, "exercise-record.entries.v1", plan, { "2032-02-28": "replace" }, { backupConfirmed: true, finalConfirmed: true });
  assert.equal(writes, 1); assert.equal(result.counts.after, 3);
  assert.equal(JSON.parse(saved)["2032-02-28"].basal, "");
  assert.deepEqual(JSON.parse(saved)["2032-02-27"], previous["2032-02-27"]);
  assert.equal(transfer.createPlan(saved, incoming).rows.every((row) => row.kind === "same"), true);
});
