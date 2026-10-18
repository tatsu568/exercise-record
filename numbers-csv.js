(function (root, factory) {
  "use strict";
  const transfer = typeof module === "object" && module.exports ? require("./record-transfer.js") : root.RecordTransfer;
  const api = factory(transfer);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NumbersCsv = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (transfer) {
  "use strict";

  const HEADERS = Object.freeze(["曜日", "日付", "出社", "在宅", "休日", "子供と動く", "スタンディング", "スクワット", "足踏み", "プランク", "散歩", "日付", "体重", "体脂肪率", "基礎代謝"]);
  const fail = (message) => { throw new Error(message); };

  function decodeUtf8(bytes) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("UTF-8として読み取れません。UTF-8 CSVに書き出し直してください（文字コードの自動変換はしません）。"); }
    if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) fail("文字化け・制御文字が疑われるため停止しました。");
    return text.replace(/^\uFEFF/, "");
  }

  // Strict CSV state machine: record numbers are logical records, not physical lines.
  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, "");
    if (!text) fail("CSVが空です。");
    const rows = [];
    let row = [], cell = "", state = "start", ended = false;
    const finishCell = () => { row.push(cell); cell = ""; state = "start"; };
    const finishRow = () => { finishCell(); rows.push(row); row = []; };
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      ended = false;
      if (state === "quoted") {
        if (char === '"') {
          if (text[index + 1] === '"') { cell += '"'; index++; }
          else state = "closed";
        } else cell += char;
        continue;
      }
      if (char === ",") { finishCell(); continue; }
      if (char === "\r" || char === "\n") {
        finishRow(); ended = true;
        if (char === "\r" && text[index + 1] === "\n") index++;
        continue;
      }
      if (state === "closed") fail(`CSV論理行${rows.length + 1}：閉じ引用符の後に余分な文字があります。`);
      if (char === '"') {
        if (state !== "start") fail(`CSV論理行${rows.length + 1}：引用符の位置が不正です。`);
        state = "quoted";
      } else { cell += char; state = "plain"; }
    }
    if (state === "quoted") fail(`CSV論理行${rows.length + 1}：引用符が閉じていません。`);
    if (!ended) finishRow();
    return rows;
  }

  function readCsv(bytes) {
    const rows = parseCsv(decodeUtf8(bytes));
    const header = rows[0];
    if (header.length !== 15 || header.some((value, index) => value.trim().normalize("NFKC") !== HEADERS[index])) {
      fail("見出しが対応する15列と一致しません。曜日／日付／出社…散歩／日付／体重／体脂肪率／基礎代謝の列順を確認してください。");
    }
    for (let index = 1; index < rows.length; index++) {
      if (rows[index].length !== 15) fail(`CSV論理行${index + 1}：15列ではありません（${rows[index].length}列）。`);
    }
    return rows.slice(1).map((cells, index) => ({ line: index + 2, cells }));
  }

  function numberText(raw, label, integer = false) {
    if (raw === "") return "";
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) < 0) fail(`${label}：非負の数値が必要です。`);
    if (integer && !Number.isSafeInteger(Number(raw))) fail(`${label}：安全な範囲の整数が必要です。`);
    return integer ? String(Number(raw)) : raw;
  }

  function walkValues(raw) {
    const result = { walkMinutes: "", walkSeconds: "", distance: "", walkSteps: "" };
    const seen = new Set();
    const put = (field, value) => {
      if (seen.has(field)) fail("散歩：時間・距離・歩数の単位が重複しています。");
      result[field] = numberText(value, "散歩", field !== "distance"); seen.add(field);
      if (field === "walkSeconds" && Number(value) > 59) fail("散歩：秒は0〜59です。");
    };
    let remaining = raw.trim();
    while (remaining) {
      const separator = /^[\s,]+/.exec(remaining);
      if (separator) { remaining = remaining.slice(separator[0].length); continue; }
      let match = /^(\d+)\s*:\s*(\d{1,2})(?!\d)/.exec(remaining);
      if (match) { put("walkMinutes", match[1]); put("walkSeconds", match[2]); }
      else {
        match = /^(\d+(?:\.\d+)?|\.\d+)\s*(km|分|秒|歩)/.exec(remaining);
        if (!match) fail("散歩：不明な文字・単位・不正な数値があります。全体を変換できないため停止しました。");
        put(({ km: "distance", 分: "walkMinutes", 秒: "walkSeconds", 歩: "walkSteps" })[match[2]], match[1]);
      }
      remaining = remaining.slice(match[0].length);
    }
    if (raw.trim() && !seen.size) fail("散歩：有効な値がありません。");
    return result;
  }

  function realDate(date) {
    try { transfer.validateRecordsMap({ [date]: {} }); return true; } catch { return false; }
  }

  function validateOptions(options) {
    const yearText = String(options.year ?? "");
    if (!/^\d{4}$/.test(yearText) || Number(yearText) < 1 || options.yearConfirmed !== true) fail("基準年を指定し、年を確認したチェックを入れてください。");
    if (!realDate(options.start) || !realDate(options.end) || options.start > options.end) fail("開始日・終了日は実在する日付を正しい順で指定してください。");
    if (options.start.slice(0, 4) !== yearText || options.end.slice(0, 4) !== yearText) fail("年またぎ、または基準年と対象期間の不一致です。年ごとにCSVと期間を分けて取り込んでください。");
    return yearText;
  }

  function monthDay(raw, year) {
    const match = /^(\d{1,2})\/(\d{1,2})$/.exec(raw);
    if (!match) fail("B/L日付は年なしの月/日形式で指定してください。");
    const date = `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    if (!realDate(date)) fail("実在しない日付です。");
    return date;
  }

  function circles(raw, label, single = false) {
    const value = raw.replace(/\s/g, "");
    if (!/^[〇○]*$/u.test(value) || (single && value.length > 1)) fail(`${label}：丸記号（〇・○）1個${single ? "または空欄" : "以上、または空欄"}が必要です。`);
    return value.length;
  }

  function convertEntry(cells, date) {
    const work = ["出社", "在宅", "休日"].filter((label, index) => circles(cells[index + 2], label, true));
    if (work.length > 1) fail("勤務区分が複数選択されています。");
    const entry = { ...transfer.DEFAULT_ENTRY, work: work[0] || "", kids: Boolean(circles(cells[5], "子供と動く", true)),
      squat: circles(cells[7], "スクワット") * 5, march: circles(cells[8], "足踏み"), plank: circles(cells[9], "プランク") * 30,
      ...walkValues(cells[10]), weight: numberText(cells[12], "体重"), bodyFat: numberText(cells[13], "体脂肪率"), basal: numberText(cells[14], "基礎代謝") };
    const notes = [];
    if (cells[6] !== "") entry.standing = Number(numberText(cells[6], "スタンディング", true));
    else notes.push("スタンディングはCSVで空欄です。保存形式に合わせて既定値10を補完します（実入力ではありません）。");
    transfer.validateRecordsMap({ [date]: entry }, { strictValues: true });
    return { entry, notes };
  }

  function convertRows(sourceRows, options) {
    const year = validateOptions(options);
    const stats = { total: sourceRows.length, inside: 0, outside: 0, unrecorded: 0, undated: 0, converted: 0, ambiguous: 0 };
    const errors = [], warnings = [], rows = [], dates = new Set();
    let previousDate = "";
    for (const source of sourceRows) {
      const row = { line: source.line, raw: source.cells.slice(), date: "", status: "error", notes: [] };
      rows.push(row);
      try {
        const cells = source.cells.map((value) => value.trim());
        const exercisePresent = cells.slice(2, 11).some((value) => value !== "");
        const bodyPresent = cells.slice(12).some((value) => value !== "");
        if (!cells[1] && !cells[11]) {
          if (exercisePresent || bodyPresent) fail("日付がない行に記録があります。");
          row.status = "undated"; stats.undated++; continue;
        }
        if ((!cells[1] && exercisePresent) || (!cells[11] && bodyPresent)) fail("記録がある側のB/L日付が欠けています。推測では統合しません。");
        const exerciseDate = cells[1] ? monthDay(cells[1], year) : "";
        const bodyDate = cells[11] ? monthDay(cells[11], year) : "";
        if (exerciseDate && bodyDate && exerciseDate !== bodyDate) fail("B列とL列の日付が一致しません。");
        row.date = exerciseDate || bodyDate;
        if (dates.has(row.date)) fail("CSV内で日付が重複しています。");
        dates.add(row.date);
        if (previousDate && row.date < previousDate) fail("日付順が逆転しています。年またぎを推測せず停止します。同一年ごとのCSVを日付昇順にしてください。");
        previousDate = row.date;
        if (!exerciseDate || !bodyDate) row.notes.push("片側の日付が空欄ですが、その側の記録も空欄のため、存在する日付で対応付けました。");
        const inRange = row.date >= options.start && row.date <= options.end;
        if (inRange) stats.inside++; else stats.outside++;
        // Validate all dated records, including rows excluded by the requested period.
        if (!exercisePresent && !bodyPresent) {
          row.status = inRange ? "unrecorded" : "outside";
          if (inRange) stats.unrecorded++;
          continue;
        }
        const converted = convertEntry(cells, row.date);
        row.entry = converted.entry; row.notes.push(...converted.notes);
        row.ambiguous = cells[6] !== "" && Number(cells[6]) === 10 && cells.filter((_v, index) => ![0, 1, 6, 11].includes(index)).every((value) => value === "");
        row.status = inRange ? "converted" : "outside";
        if (inRange) { stats.converted++; if (row.ambiguous) stats.ambiguous++; }
        if (row.ambiguous) row.notes.push("スタンディング10のみ：初期値か実入力か不明です。初期状態では取り込まず、内容を確認して選択してください。");
        for (const note of row.notes) warnings.push(`CSV論理行${row.line}：${note}`);
      } catch (error) { row.error = `CSV論理行${row.line}：${error.message}`; errors.push(row.error); }
    }
    return { rows, stats, errors, warnings, options: { ...options } };
  }

  function selectedRecords(result, included = {}) {
    if (result.errors.length) fail("変換エラーがあります。CSV全体の取り込みを停止しました。");
    const records = {};
    for (const row of result.rows) {
      if (row.status === "converted" && (!row.ambiguous || included[row.date] === true)) records[row.date] = { ...row.entry };
    }
    transfer.validateRecordsMap(records, { strictValues: true });
    return records;
  }

  return Object.freeze({ HEADERS, decodeUtf8, parseCsv, readCsv, walkValues, validateOptions, convertRows, selectedRecords });
});
