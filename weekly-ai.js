(function (root, factory) {
  "use strict";
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./record-transfer.js") : root.RecordTransfer,
    commonJS ? require("./body-graph.js") : root.BodyGraph);
  if (commonJS) module.exports = api; else root.WeeklyAI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (transfer, calendar) {
  "use strict";
  const PROMPT = `直前に実施した週間運動評価について、運動記録Webアプリに貼り付けるデータを出力してください。

評価のやり直しや再採点はせず、すでに確定した対象週と評価点数をそのまま使用してください。

出力形式は次のとおりです。

対象週の月曜日（YYYY-MM-DD）【タブ】評価点数（整数）【タブ】短い総評

総評は当時の評価内容に基づいて40〜80文字程度に要約してください。

総評が確認できない場合は、日付と点数だけでも構いません。

日付・点数・総評をタブ区切りの1行とし、見出しのないコードブロックに入れて、コピーしやすくしてください。

対象週または評価点数が確認できない場合は、推測せず、その旨を伝えてください。

従来の週間評価の内容や採点基準は変更しないでください。`;
  function parseTSV(text) {
    const evaluations = {}, errors = [], seen = new Set();
    if (typeof text !== "string" || text.length > 1000000) return { evaluations, errors: [{ line: 1, reason: "入力は100万文字以内にしてください" }] };
    text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const cells = line.split("\t");
        if (![2, 3].includes(cells.length)) throw new Error("日付・点数の2列、または総評付きの3列をタブで区切ってください");
        const date = cells[0].trim(), score = cells[1].trim();
        if (!/^\d+$/.test(score)) throw new Error("評価点数は0〜100の整数で指定してください");
        const entry = { score: Number(score), comment: cells[2] ?? "" };
        transfer.validateEvaluations({ [date]: entry });
        if (seen.has(date)) throw new Error("同じ対象週が重複しています");
        seen.add(date); evaluations[date] = entry;
      } catch (error) { errors.push({ line: index + 1, reason: error.message }); }
    });
    if (!errors.length && !seen.size) errors.push({ line: 1, reason: "評価データを貼り付けてください" });
    if (seen.size > 10000) errors.push({ line: 1, reason: "1回の取り込みは10000週以内にしてください" });
    return { evaluations, errors };
  }
  function chartData(evaluations) {
    transfer.validateEvaluations(evaluations);
    const points = Object.keys(evaluations).sort().map(date => ({ date, day: calendar.parseDate(date).ordinal, value: evaluations[date].score }));
    const segments = [], averageSegments = []; let first = 0, segment, averageSegment;
    points.forEach((point, index) => {
      if (!segment) {
        segment = []; segments.push(segment); averageSegment = []; averageSegments.push(averageSegment);
      }
      segment.push(point);
      while (points[first].day < point.day - 21) first++;
      const window = points.slice(first, index + 1);
      averageSegment.push({ ...point, value: window.reduce((sum, p) => sum + p.value, 0) / window.length });
    });
    return { points, segments, averageSegments };
  }
  return Object.freeze({ KEY: transfer.AI_KEY, PROMPT, parseTSV, chartData });
});
