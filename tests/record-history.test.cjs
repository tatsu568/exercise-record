"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const history = require("../record-history.js");
const transfer = require("../record-transfer.js");
const day = (changes = {}) => ({ ...transfer.DEFAULT_ENTRY, ...changes });

test("local today uses local calendar components", () => {
  assert.equal(history.localToday({ getFullYear: () => 2032, getMonth: () => 0, getDate: () => 1 }), "2032-01-01");
});
test("calendar is Monday-first with correct day placement", () => {
  const month = history.calendar(2032, 3);
  assert.equal(month.offset, 0); assert.equal(month.dates.length, 31);
  assert.equal(history.dateLabel("2032-03-01"), "2032/3/1（月）");
  assert.equal(history.dateLabel("2032-03-07"), "2032/3/7（日）");
});
test("December/January navigation preserves calendar years", () => {
  assert.deepEqual(history.moveMonth(2032, 12, 1), { year: 2033, month: 1 });
  assert.deepEqual(history.moveMonth(2032, 1, -1), { year: 2031, month: 12 });
});
test("month and leap boundaries including century rules", () => {
  for (const [year, length] of [[2032, 29], [2031, 28], [2100, 28], [2000, 29]]) assert.equal(history.calendar(year, 2).dates.length, length);
  for (const [month, length] of [[4, 30], [1, 31], [12, 31]]) assert.equal(history.calendar(2032, month).dates.length, length);
});
test("calendar supports early and future years without Date 0-99 remapping", () => {
  assert.equal(history.calendar(1, 1).dates[0], "0001-01-01");
  assert.equal(history.dateLabel("0001-01-01"), "1/1/1（月）");
  assert.equal(history.calendar(9999, 12).dates.length, 31);
  assert.equal(history.moveMonth(1, 1, -1), null); assert.equal(history.moveMonth(9999, 12, 1), null);
});
test("missing storage and empty maps are valid and contain no generated dates", () => {
  assert.deepEqual(history.read(null), {}); assert.deepEqual(history.read("{}"), {});
  assert.equal(history.monthRecords({}, 2032, 2).counts.saved, 0);
  assert.equal(history.describe({}, "2032-02-29").saved, false);
});
test("malformed roots and nonexistent date keys are rejected without initialization", () => {
  for (const raw of ["{broken", "[]", "null", '"text"', '{"2031-02-29":{}}', '{"__proto__":{}}']) assert.throws(() => history.read(raw));
  for (const args of [[0, 1], [2032, 0], [2032, 13]]) assert.throws(() => history.calendar(...args));
});
test("saved data, default-only possibility and no record are distinguished", () => {
  const records = { "2032-02-27": day({ work: "在宅" }), "2032-02-28": day() };
  assert.equal(history.describe(records, "2032-02-27").kind, "record");
  assert.equal(history.describe(records, "2032-02-28").kind, "default");
  assert.equal(history.describe(records, "2032-02-29").kind, "missing");
  assert.equal(history.monthRecords(records, 2032, 2).counts.default, 1);
});
test("default records are never omitted from the saved month list", () => {
  const month = history.monthRecords({ "2032-02-28": day(), "2032-02-29": day({ weight: "0" }), "2032-03-01": day() }, 2032, 2);
  assert.deepEqual(month.rows.map((row) => row.date), ["2032-02-29", "2032-02-28"]);
  assert.deepEqual(month.counts, { saved: 2, record: 1, default: 1, review: 0 });
});
test("all thirteen fields and original scalar types are available", () => {
  const entry = day({ kids: true, squat: 15, march: 2, plank: 90, walkMinutes: "24", walkSeconds: "07", distance: "1.2300", walkSteps: "2500", weight: "51.2300", bodyFat: "0", basal: "1234" });
  const detail = history.describe({ "2032-02-29": entry }, "2032-02-29");
  assert.equal(detail.fields.length, 13); assert.equal(detail.canEdit, true);
  for (const field of detail.fields) assert.equal(field.value, entry[field.key]);
  assert.equal(detail.fields.find((field) => field.key === "distance").text, "1.2300 km");
  assert.equal(detail.fields.find((field) => field.key === "weight").text, "51.2300 kg");
});
test("empty, numeric zero, string zero and false remain distinct", () => {
  const fields = history.describe({ "2032-02-29": day({ weight: "0" }) }, "2032-02-29").fields;
  for (const [key, type, text] of [["weight", "string", "0 kg"], ["bodyFat", "string", "空欄"], ["squat", "number", "0 回"], ["kids", "boolean", "OFF（false）"]]) {
    const field = fields.find((item) => item.key === key); assert.equal(field.type, type); assert.equal(field.text, text);
  }
});
test("partial walk values are displayed without zero supplementation", () => {
  const detail = history.describe({ "2032-02-29": day({ walkSteps: "0" }) }, "2032-02-29");
  assert.match(history.summary(detail), /散歩：あり/);
  assert.equal(detail.fields.find((field) => field.key === "walkMinutes").text, "空欄");
  assert.equal(detail.fields.find((field) => field.key === "walkSteps").text, "0 歩");
});
test("old missing fields and invalid fields show warnings, never default-normalize", () => {
  for (const entry of [{ weight: "51.2" }, {}, day({ weight: 0 }), day({ march: 3 }), day({ kids: "false" }), day({ weight: null }), null, []]) {
    const records = { "2032-02-29": entry }, original = JSON.stringify(records);
    const detail = history.describe(records, "2032-02-29");
    assert.equal(detail.kind, "review"); assert.equal(detail.canEdit, false);
    assert.equal(JSON.stringify(records), original);
  }
  const old = history.describe({ "2032-02-29": { weight: "0" } }, "2032-02-29");
  assert.equal(old.fields.find((field) => field.key === "standing").type, "項目なし");
});
test("unknown fields are acknowledged and retained, not mistaken for default-only", () => {
  const records = { "2032-02-29": day({ extra: { note: "fictional" } }) };
  assert.deepEqual(history.describe(records, "2032-02-29").unknown, ["extra"]);
  assert.equal(history.describe(records, "2032-02-29").kind, "record");
  assert.deepEqual(records["2032-02-29"].extra, { note: "fictional" });
});
test("a non-finite JSON numeric value is displayed as invalid, never disguised as zero or null", () => {
  const records = history.read('{"2032-02-29":{"standing":1e309}}');
  const detail = history.describe(records, "2032-02-29");
  assert.equal(detail.kind, "review");
  assert.equal(detail.fields.find((field) => field.key === "standing").text, "不正な値：Infinity（number）");
});
test("127 synthetic days are filtered and sorted with correct month counts", () => {
  const records = {};
  for (let index = 0; index < 127; index++) {
    const date = new Date(Date.UTC(2032, 0, 1 + index)).toISOString().slice(0, 10);
    records[date] = day({ walkSteps: String(index) });
  }
  const month = history.monthRecords(records, 2032, 2);
  assert.equal(month.counts.saved, 29); assert.equal(month.rows[0].date, "2032-02-29");
  assert.equal(month.rows.at(-1).date, "2032-02-01"); assert.equal(Object.keys(records).length, 127);
});
test("large history only constructs details for the selected month", () => {
  const records = {};
  for (let index = 0; index < 5000; index++) records[new Date(Date.UTC(2030, 0, 1 + index)).toISOString().slice(0, 10)] = day({ squat: 5 });
  const month = history.monthRecords(records, 2032, 3);
  assert.equal(month.rows.length, 31); assert.equal(Object.keys(records).length, 5000);
});
test("read and every browsing calculation leave the original JSON and objects intact", () => {
  const source = JSON.stringify({ "2032-02-29": day({ weight: "0", distance: "0.00" }) });
  const records = history.read(source); Object.freeze(records["2032-02-29"]); Object.freeze(records);
  for (let index = 0; index < 12; index++) history.monthRecords(records, 2032, index + 1);
  history.describe(records, "2032-03-01");
  assert.equal(JSON.stringify(records), source);
});
