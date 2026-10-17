(() => {
  "use strict";

  const STORAGE_KEY = "exercise-record.entries.v1";
  const DEFAULT_ENTRY = RecordTransfer.DEFAULT_ENTRY;
  const FIELDS = {
    date: document.querySelector("#record-date"), kids: document.querySelector("#kids"),
    standing: document.querySelector("#standing"), walkMinutes: document.querySelector("#walk-minutes"),
    walkSeconds: document.querySelector("#walk-seconds"), distance: document.querySelector("#distance"),
    walkSteps: document.querySelector("#walk-steps"), weight: document.querySelector("#weight"),
    bodyFat: document.querySelector("#body-fat"), basal: document.querySelector("#basal")
  };
  const INPUT_ORDER = [FIELDS.walkMinutes, FIELDS.walkSeconds, FIELDS.distance, FIELDS.walkSteps, FIELDS.weight, FIELDS.bodyFat, FIELDS.basal];
  let storageLoadError = "";
  let restoreSession = null;
  let restoreToken = 0;
  let hasUnsavedChanges = false;
  let entries = readEntries();
  let currentEntry = { ...DEFAULT_ENTRY };
  let activeDate = "";
  let toastTimer;
  let saveTimer;
  let lastFocusedInput = null;

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function readEntries() {
    storageLoadError = "";
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === null) return {};
      const parsed = JSON.parse(stored);
      return validateRecordsMap(parsed);
    } catch (error) {
      storageLoadError = error.message || "保存データを読み込めませんでした";
      console.error("保存データを読み込めませんでした。保存を停止します。", error);
      return {};
    }
  }

  function validateRecordsMap(records) {
    return RecordTransfer.validateRecordsMap(records);
  }

  function loadDate(date) {
    activeDate = date;
    currentEntry = { ...DEFAULT_ENTRY, ...(entries[date] || {}) };
    FIELDS.date.value = date;
    renderEntry();
    updateWeeklyPeriod(date);
  }

  function switchDate(date) {
    if (!date) return;
    if (restoreSession) { FIELDS.date.value = activeDate; return; }
    if (date === activeDate) {
      FIELDS.date.value = activeDate;
      return;
    }
    if (storageLoadError) {
      FIELDS.date.value = activeDate;
      showToast("保存データを読み込めないため、日付変更を停止しています", 4000);
      return;
    }
    // Persist the currently displayed entry under its original date before loading another.
    if (!saveCurrentEntry()) { FIELDS.date.value = activeDate; return; }
    loadDate(date);
  }

  function moveDateByDays(dayDelta) {
    const [year, month, day] = (FIELDS.date.value || activeDate).split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return;
    // Use local noon so daylight-saving transitions cannot shift the calendar date.
    const date = new Date(year, month - 1, day + dayDelta, 12);
    switchDate(localDateString(date));
  }

  function renderEntry() {
    document.querySelectorAll("[data-work]").forEach((button) => {
      const selected = button.dataset.work === currentEntry.work;
      button.setAttribute("aria-pressed", String(selected));
    });
    FIELDS.kids.checked = Boolean(currentEntry.kids);
    FIELDS.standing.value = String(clampNumber(currentEntry.standing, 5, 20, 10));
    document.querySelector("#standing-value").value = FIELDS.standing.value;
    document.querySelector("#squat-value").value = `${currentEntry.squat || 0}回`;
    document.querySelector("#march-value").value = `${currentEntry.march || 0}回`;
    document.querySelector("#plank-value").value = `${currentEntry.plank || 0}秒`;
    for (const key of ["walkMinutes", "walkSeconds", "distance", "walkSteps", "weight", "bodyFat", "basal"]) {
      FIELDS[key].value = currentEntry[key] ?? "";
    }
    updateStepperButtons();
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function captureForm() {
    currentEntry = {
      ...currentEntry,
      kids: FIELDS.kids.checked,
      standing: clampNumber(FIELDS.standing.value, 5, 20, 10),
      walkMinutes: FIELDS.walkMinutes.value,
      walkSeconds: FIELDS.walkSeconds.value,
      distance: FIELDS.distance.value,
      walkSteps: FIELDS.walkSteps.value,
      weight: FIELDS.weight.value,
      bodyFat: FIELDS.bodyFat.value,
      basal: FIELDS.basal.value
    };
  }

  function saveCurrentEntry() {
    if (restoreSession) return false;
    if (storageLoadError) {
      document.querySelector("#save-status").textContent = "保存データを読み込めないため、自動保存を停止中です";
      return false;
    }
    hasUnsavedChanges = true;
    captureForm();
    entries[activeDate || FIELDS.date.value] = { ...currentEntry };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      hasUnsavedChanges = false;
      const status = document.querySelector("#save-status");
      status.textContent = "保存済み";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { status.textContent = "この端末に自動保存されます"; }, 1400);
    } catch (error) {
      document.querySelector("#save-status").textContent = "保存できません。ブラウザの空き容量を確認してください";
      console.error("端末内への保存に失敗しました。", error);
      return false;
    }
    return true;
  }

  function readBackupRecords() {
    let stored;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      throw new Error("端末内の保存データを読み取れません。ブラウザの保存領域を確認してください");
    }
    if (stored === null) return {};
    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      throw new Error("保存データのJSONが破損しているため、書き出しを中止しました");
    }
    return validateRecordsMap(parsed);
  }

  async function saveBackup() {
    try {
      const records = readBackupRecords();
      const backup = {
        format: "exercise-record-backup",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        records
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const filename = `運動記録バックアップ_${localDateString()}.json`;

      if (typeof File === "function" && navigator.share && navigator.canShare) {
        const file = new File([blob], filename, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file] });
            showToast("共有を終了しました。ファイルに保存されたことを確認してください", 4000);
            return true;
          } catch (error) {
            if (error.name === "AbortError") {
              showToast("バックアップ保存をキャンセルしました");
              return false;
            }
            throw error;
          }
        }
      }

      if (!URL.createObjectURL || !URL.revokeObjectURL) throw new Error("このブラウザではファイル保存を開始できません");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const count = Object.keys(records).length;
      showToast(count ? "保存操作を開始しました。ダウンロードを確認してください" : "記録0件の保存操作を開始しました。ダウンロードを確認してください", 4000);
      return true;
    } catch (error) {
      console.error("バックアップを書き出せませんでした。", error);
      showToast(`バックアップを中止しました：${error.message}`, 5000);
      return false;
    }
  }

  function setRestoreMessage(message, error = false) {
    const node = document.querySelector("#restore-status");
    node.textContent = message;
    node.dataset.error = String(error);
  }

  function lockForRestore(locked) {
    if (locked) {
      clearTimeout(saveTimer);
      document.querySelector("#save-status").textContent = "復元の確認中：通常入力を一時停止しています";
    }
    document.querySelector("#entry-fields").disabled = locked;
    document.querySelector("#backup-export").disabled = locked;
    document.querySelector("#restore-start").disabled = locked;
    document.querySelector("#input-toolbar").hidden = true;
  }

  function clearRestoreConfirmations() {
    document.querySelector("#restore-backup-confirm").checked = false;
    document.querySelector("#restore-final-confirm").checked = false;
    document.querySelector("#restore-backup-confirm").disabled = true;
  }

  function invalidateRestore(message) {
    if (!restoreSession) return;
    restoreSession.stale = true;
    clearRestoreConfirmations();
    document.querySelector("#restore-prebackup").disabled = true;
    document.querySelector("#restore-apply").disabled = true;
    setRestoreMessage(message, true);
  }

  async function previewBackup(file) {
    if (!file) return;
    if (hasUnsavedChanges || storageLoadError) {
      setRestoreMessage("現在の入力または保存データを安全に確認できません。保存エラーを解消してから復元してください。", true);
      return;
    }
    const token = ++restoreToken;
    restoreSession = { loading: true, stale: false, choices: {} };
    lockForRestore(true);
    document.querySelector("#restore-panel").hidden = false;
    document.querySelector("#restore-preview").hidden = true;
    clearRestoreConfirmations();
    setRestoreMessage("ファイルを読み込んでいます。まだ保存内容は変更していません。");
    try {
      const text = await file.text();
      if (token !== restoreToken) return;
      const backup = RecordTransfer.parseBackup(text);
      const plan = RecordTransfer.createPlan(localStorage.getItem(STORAGE_KEY), backup.records);
      restoreSession = { plan, backup, choices: {}, stale: false, backupPrepared: false };
      renderRestorePreview();
    } catch (error) {
      if (token !== restoreToken) return;
      restoreSession = { stale: true };
      setRestoreMessage(`エラー1件：${error.message || "ファイルを読み取れませんでした"}。復元全体を停止しました。`, true);
    }
  }

  function restoreNode(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderRestorePreview() {
    const { plan, backup } = restoreSession;
    const dates = Object.keys(plan.incoming).sort();
    const conflicts = plan.rows.filter((row) => row.kind === "conflict");
    const newCount = plan.rows.filter((row) => row.kind === "new").length;
    const sameCount = plan.rows.filter((row) => row.kind === "same").length;
    document.querySelector("#restore-summary").textContent = `作成日時：${new Date(backup.exportedAt).toLocaleString("ja-JP")}\n記録日数：${dates.length}日\n期間：${dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : "記録なし"}\n新規追加：${newCount}日／完全一致：${sameCount}日／競合：${conflicts.length}日\nエラー：0件／警告：${plan.warnings.length}件`;
    const warnings = document.querySelector("#restore-warnings");
    warnings.replaceChildren(...plan.warnings.map((text) => restoreNode("li", text)));
    const list = document.querySelector("#restore-conflicts");
    list.replaceChildren();
    const labels = { work: "勤務区分", kids: "子供と動く", standing: "スタンディング", squat: "スクワット", march: "足踏み", plank: "プランク", walkMinutes: "散歩・分", walkSeconds: "散歩・秒", distance: "距離", walkSteps: "歩数", weight: "体重", bodyFat: "体脂肪率", basal: "基礎代謝" };
    for (const row of conflicts) {
      const card = restoreNode("div", undefined, "restore-conflict");
      const details = restoreNode("details");
      details.append(restoreNode("summary", `${row.date} の相違${row.defaultOnly ? "（現在は初期値のみの可能性）" : ""}`));
      for (const diff of row.differences) {
        const field = restoreNode("div", undefined, "restore-diff");
        field.append(restoreNode("strong", Object.prototype.hasOwnProperty.call(labels, diff.field) ? labels[diff.field] : `未知項目：${diff.field}`));
        const values = restoreNode("div", undefined, "restore-values");
        for (const [title, value] of [["現在", diff.existing], ["バックアップ", diff.incoming]]) {
          const cell = restoreNode("div");
          cell.append(restoreNode("span", title), restoreNode("code", value === undefined ? "項目なし" : JSON.stringify(value)));
          values.append(cell);
        }
        field.append(values); details.append(field);
      }
      const label = restoreNode("label", undefined, "restore-choice");
      label.append(restoreNode("span", `${row.date} の復元方法`));
      const select = document.createElement("select");
      for (const [value, text] of [["keep", "既存を維持"], ["replace", "バックアップで置換"]]) {
        const option = restoreNode("option", text); option.value = value; select.append(option);
      }
      select.value = "keep";
      select.addEventListener("change", () => {
        if (!restoreSession || restoreSession.stale) return;
        restoreSession.choices[row.date] = select.value;
        document.querySelector("#restore-final-confirm").checked = false;
        updateRestoreTotals();
      });
      label.append(select); card.append(details, label); list.append(card);
    }
    document.querySelector("#restore-preview").hidden = false;
    document.querySelector("#restore-prebackup").disabled = false;
    setRestoreMessage("まだ保存内容は変更していません。相違内容と件数を確認してください。復元中は通常入力を一時停止しています。");
    updateRestoreTotals();
  }

  function updateRestoreTotals() {
    if (!restoreSession?.plan) return;
    const { counts } = RecordTransfer.buildCandidate(restoreSession.plan, restoreSession.choices);
    const summary = `追加${counts.added}件・置換${counts.replaced}件・スキップ${counts.skipped}件（うち一致${counts.same}件）／保存日数${counts.before}→${counts.after}日`;
    document.querySelector("#restore-totals").textContent = summary;
    document.querySelector("#restore-final-label").textContent = `${summary}を確認しました`;
    const canApply = !restoreSession.stale && restoreSession.backupPrepared && document.querySelector("#restore-backup-confirm").checked
      && document.querySelector("#restore-final-confirm").checked && counts.added + counts.replaced > 0;
    document.querySelector("#restore-apply").disabled = !canApply;
    document.querySelector("#restore-no-changes").hidden = counts.added + counts.replaced > 0;
  }

  async function prepareRestoreBackup() {
    const session = restoreSession;
    if (!session?.plan || session.stale) return;
    clearRestoreConfirmations();
    session.backupPrepared = false;
    document.querySelector("#restore-prebackup").disabled = true;
    updateRestoreTotals();
    try {
      if (localStorage.getItem(STORAGE_KEY) !== session.plan.baselineRaw) throw new Error("現在の記録が変わりました。ファイルを選び直して再検証してください。");
      const started = await saveBackup();
      if (session !== restoreSession) return;
      if (session.stale || localStorage.getItem(STORAGE_KEY) !== session.plan.baselineRaw) throw new Error("バックアップ中に現在の記録が変わりました。再検証してください。");
      session.backupPrepared = started;
      document.querySelector("#restore-backup-confirm").disabled = !started;
      setRestoreMessage(started ? "保存操作を行いました。ファイルアプリ等でJSONが保存されたことを確認し、下の確認欄をチェックしてください。アプリから保存完了は確認できません。" : "バックアップ保存を完了していません。復元はまだ実行できません。", !started);
    } catch (error) { invalidateRestore(error.message); }
    finally {
      if (session === restoreSession) {
        document.querySelector("#restore-prebackup").disabled = session.stale;
        updateRestoreTotals();
      }
    }
  }

  function finishRestoreSession() {
    ++restoreToken;
    restoreSession = null;
    lockForRestore(false);
    document.querySelector("#restore-file").value = "";
    document.querySelector("#restore-preview").hidden = true;
    entries = readEntries();
    hasUnsavedChanges = false;
    loadDate(activeDate);
    clearTimeout(saveTimer);
    document.querySelector("#save-status").textContent = storageLoadError ? "保存データを読み込めないため、自動保存を停止中です" : "この端末に自動保存されます";
  }

  function cancelRestore() {
    if (restoreSession) finishRestoreSession();
    document.querySelector("#restore-panel").hidden = true;
    setRestoreMessage("");
  }

  function applyRestore() {
    const session = restoreSession;
    if (!session?.plan || session.stale || !session.backupPrepared || !document.querySelector("#restore-backup-confirm").checked || !document.querySelector("#restore-final-confirm").checked) return;
    const { counts } = RecordTransfer.buildCandidate(session.plan, session.choices);
    if (!window.confirm(`追加${counts.added}件・置換${counts.replaced}件を反映します。保存日数は${counts.before}→${counts.after}日です。復元前バックアップを保存・確認済みですか？`)) return;
    try {
      const result = RecordTransfer.commitRecords(localStorage, STORAGE_KEY, session.plan, session.choices, { backupConfirmed: true, finalConfirmed: true });
      finishRestoreSession();
      setRestoreMessage(`復元と読み戻し照合が完了しました。追加${result.counts.added}件・置換${result.counts.replaced}件・スキップ${result.counts.skipped}件／合計${result.counts.after}日。`);
    } catch (error) {
      invalidateRestore(error.message);
      if (error.code === "VERIFY_FAILED") {
        storageLoadError = "復元後の保存内容を照合できませんでした";
        document.querySelector("#save-status").textContent = "復元後の照合に失敗したため、自動保存を停止中です";
      }
    }
  }

  function handleStorageChange(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    if (restoreSession) {
      if (restoreSession.plan) invalidateRestore("別の画面で現在の記録が更新されました。閉じてファイルを選び直し、再検証してください。");
      return;
    }
    if (hasUnsavedChanges) {
      storageLoadError = "未保存の入力がある間に別の画面で記録が更新されました";
      document.querySelector("#save-status").textContent = "別の画面で更新がありました。未保存の入力を控えてから再読み込みしてください";
      return;
    }
    entries = readEntries();
    loadDate(activeDate);
    clearTimeout(saveTimer);
    document.querySelector("#save-status").textContent = storageLoadError ? "保存データを読み込めないため、自動保存を停止中です" : "別の画面の更新を読み込みました";
  }

  function updateStepperButtons() {
    document.querySelectorAll("[data-step]").forEach((button) => {
      const key = button.dataset.step;
      const nextValue = currentEntry[key] + Number(button.dataset.delta);
      button.disabled = nextValue < 0 || (key === "march" && nextValue > 2);
    });
  }

  function circleCount(count) { return count > 0 ? "○".repeat(count) : ""; }
  function explicitValue(value) { return value === "" ? "" : value; }

  function walkText() {
    return walkTextFromValues(FIELDS.walkMinutes.value, FIELDS.walkSeconds.value, FIELDS.distance.value, FIELDS.walkSteps.value);
  }

  function walkTextFromValues(walkMinutes, walkSeconds, walkDistance, walkSteps) {
    const parts = [];
    const minutes = explicitValue(walkMinutes);
    const seconds = explicitValue(walkSeconds);
    if (minutes !== "" || seconds !== "") parts.push(`${minutes === "" ? "" : `${minutes}分`}${seconds === "" ? "" : `${seconds}秒`}`);
    const distance = explicitValue(walkDistance);
    if (distance !== "") parts.push(`${distance}km`);
    const steps = explicitValue(walkSteps);
    if (steps !== "") parts.push(`${steps}歩`);
    return parts.join(" ");
  }

  function previousWeekDates(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const selected = new Date(year, month - 1, day, 12);
    if (!Number.isFinite(selected.getTime()) || localDateString(selected) !== dateKey) {
      throw new Error("日付を読み取れませんでした");
    }
    const daysSinceMonday = (selected.getDay() + 6) % 7;
    const previousMonday = new Date(year, month - 1, day - daysSinceMonday - 7, 12);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(previousMonday.getFullYear(), previousMonday.getMonth(), previousMonday.getDate() + index, 12);
      return localDateString(date);
    });
  }

  function formatWeeklyDate(dateKey, includeYear) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return includeYear ? `${year}/${month}/${day}` : `${month}/${day}`;
  }

  function updateWeeklyPeriod(selectedDate) {
    const { dates, includeYear } = weeklyDateRange(selectedDate);
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const labels = dates.filter((_, index) => index === 0 || index === 6).map((dateKey) => {
      const [year, month, day] = dateKey.split("-").map(Number);
      const weekday = weekdays[new Date(year, month - 1, day, 12).getDay()];
      return `${formatWeeklyDate(dateKey, includeYear)}（${weekday}）`;
    });
    document.querySelector("#weekly-period").textContent = `対象期間：${labels[0]}〜${labels[1]}`;
  }

  function weeklyExerciseRow(entry) {
    const work = entry.work;
    return [
      work === "出社" ? "○" : "",
      work === "在宅" ? "○" : "",
      work === "休日" ? "○" : "",
      entry.kids ? "○" : "",
      String(clampNumber(entry.standing, 5, 20, 10)),
      circleCount(Number(entry.squat || 0) / 5),
      circleCount(Number(entry.march || 0)),
      circleCount(Number(entry.plank || 0) / 30),
      walkTextFromValues(entry.walkMinutes ?? "", entry.walkSeconds ?? "", entry.distance ?? "", entry.walkSteps ?? "")
    ];
  }

  function weeklyCopyText(selectedDate) {
    // Read directly from storage so missing dates remain distinct from default-valued entries.
    const raw = localStorage.getItem(STORAGE_KEY);
    const storedEntries = raw ? JSON.parse(raw) : {};
    if (!storedEntries || typeof storedEntries !== "object" || Array.isArray(storedEntries)) {
      throw new Error("保存データの形式を読み取れませんでした");
    }

    const { dates, includeYear } = weeklyDateRange(selectedDate);
    const headers = ["日付", "出社", "在宅", "休日", "子供と動く", "スタンディング", "スクワット", "足踏み", "プランク", "散歩"];
    const missingDates = [];
    const rows = dates.map((date) => {
      const stored = Object.prototype.hasOwnProperty.call(storedEntries, date) ? storedEntries[date] : null;
      const isRecorded = stored && typeof stored === "object" && !Array.isArray(stored);
      const displayDate = formatWeeklyDate(date, includeYear);
      if (!isRecorded) {
        missingDates.push(displayDate);
        return [displayDate, "", "", "", "", "", "", "", "", ""];
      }
      return [displayDate, ...weeklyExerciseRow({ ...DEFAULT_ENTRY, ...stored })];
    });
    const lines = [headers.join("\t"), ...rows.map((row) => row.join("\t"))];
    if (missingDates.length) lines.push("", `未記録日：${missingDates.join("、")}`);
    return lines.join("\n");
  }

  function weeklyDateRange(selectedDate) {
    const dates = previousWeekDates(selectedDate);
    return { dates, includeYear: dates[0].slice(0, 4) !== dates[6].slice(0, 4) };
  }

  function storedBodyValue(value) {
    return value === "" || value === null || value === undefined ? "" : String(value);
  }

  function weeklyBodyCopyText(selectedDate) {
    const raw = localStorage.getItem(STORAGE_KEY);
    const storedEntries = raw ? JSON.parse(raw) : {};
    if (!storedEntries || typeof storedEntries !== "object" || Array.isArray(storedEntries)) {
      throw new Error("保存データの形式を読み取れませんでした");
    }

    const { dates, includeYear } = weeklyDateRange(selectedDate);
    let latestRecord = null;
    for (const date of dates) {
      const entry = Object.prototype.hasOwnProperty.call(storedEntries, date) ? storedEntries[date] : null;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const hasBodyData = [entry.weight, entry.bodyFat, entry.basal]
        .some((value) => value !== "" && value !== null && value !== undefined);
      if (hasBodyData) latestRecord = { date, entry };
    }

    if (!latestRecord) return "対象期間に身体データはありません";
    return [
      ["日付", "体重", "体脂肪率", "基礎代謝"].join("\t"),
      [
        formatWeeklyDate(latestRecord.date, includeYear),
        storedBodyValue(latestRecord.entry.weight),
        storedBodyValue(latestRecord.entry.bodyFat),
        storedBodyValue(latestRecord.entry.basal)
      ].join("\t")
    ].join("\n");
  }

  async function copyWeeklyBody() {
    try {
      const text = weeklyBodyCopyText(FIELDS.date.value || activeDate);
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("コピーしました");
        return;
      }
      if (legacyCopy(text)) {
        showToast("テキスト形式でコピーしました");
        return;
      }
      throw new Error("clipboard unavailable");
    } catch (error) {
      console.error("週間身体データをコピーできませんでした。", error);
      showToast("コピーできませんでした。保存データまたはクリップボードを確認してください", 3200);
    }
  }

  async function copyWeeklyExercise() {
    try {
      const text = weeklyCopyText(FIELDS.date.value || activeDate);
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("コピーしました");
        return;
      }
      if (legacyCopy(text)) {
        showToast("テキスト形式でコピーしました");
        return;
      }
      throw new Error("clipboard unavailable");
    } catch (error) {
      console.error("週間運動データをコピーできませんでした。", error);
      showToast("コピーできませんでした。保存データまたはクリップボードを確認してください", 3200);
    }
  }

  function exerciseRow() {
    const work = currentEntry.work;
    return [
      work === "出社" ? "○" : "",
      work === "在宅" ? "○" : "",
      work === "休日" ? "○" : "",
      FIELDS.kids.checked ? "○" : "",
      String(FIELDS.standing.value),
      circleCount(currentEntry.squat / 5),
      circleCount(currentEntry.march),
      circleCount(currentEntry.plank / 30),
      walkText()
    ];
  }

  function bodyRow() {
    return [explicitValue(FIELDS.weight.value), explicitValue(FIELDS.bodyFat.value), explicitValue(FIELDS.basal.value)];
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
  }

  function makeHtmlTable(values) {
    const cells = values.map((value) => `<td>${escapeHtml(value)}</td>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><table><tbody><tr>${cells}</tr></tbody></table></body></html>`;
  }

  async function copyHtmlTable(values) {
    const plainText = values.join("\t");
    const htmlText = makeHtmlTable(values);
    try {
      if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        try {
          // Keep both formats in one clipboard item; WebKit prefers the first format.
          const item = new ClipboardItem({
            "text/html": new Blob([htmlText], { type: "text/html" }),
            "text/plain": new Blob([plainText], { type: "text/plain" })
          });
          await navigator.clipboard.write([item]);
          showToast("コピーしました");
          return;
        } catch (error) {
          console.warn("HTML形式のClipboard APIに失敗したため、代替方法を試します。", error);
        }
      }

      const legacy = legacyCopyWithHtml(plainText, htmlText);
      if (legacy.succeeded) {
        showToast(legacy.htmlWritten ? "コピーしました" : "テキスト形式でコピーしました");
        return;
      }
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText);
        showToast("テキスト形式でコピーしました");
        return;
      }
      if (legacyCopy(plainText)) {
        showToast("テキスト形式でコピーしました");
        return;
      }
      throw new Error("clipboard unavailable");
    } catch (error) {
      console.error("クリップボードにコピーできませんでした。", error);
      showToast("コピーできませんでした。ページをHTTPSで開いてください", 3200);
    }
  }

  function legacyCopyWithHtml(plainText, htmlText) {
    const helper = document.createElement("textarea");
    helper.value = plainText;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    let htmlWritten = false;
    helper.addEventListener("copy", (event) => {
      if (!event.clipboardData) return;
      try {
        event.clipboardData.setData("text/html", htmlText);
        event.clipboardData.setData("text/plain", plainText);
        event.preventDefault();
        htmlWritten = true;
      } catch (error) {
        console.warn("HTML形式のコピーを利用できません。", error);
      }
    });
    helper.focus();
    helper.select();
    const succeeded = document.execCommand("copy");
    helper.remove();
    return { succeeded, htmlWritten };
  }

  function legacyCopy(text) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.focus();
    helper.select();
    const succeeded = document.execCommand("copy");
    helper.remove();
    return succeeded;
  }

  function showToast(message, duration = 1800) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), duration);
  }

  function focusNextInput() {
    const activeElement = document.activeElement;
    const active = INPUT_ORDER.includes(activeElement) ? activeElement : lastFocusedInput;
    if (!active) return;
    if (active === FIELDS.walkSteps || active === FIELDS.basal) {
      active.blur();
      lastFocusedInput = null;
      document.querySelector("#input-toolbar").hidden = true;
      return;
    }
    const index = INPUT_ORDER.indexOf(active);
    if (index >= 0 && index < INPUT_ORDER.length - 1) {
      lastFocusedInput = INPUT_ORDER[index + 1];
      lastFocusedInput.focus();
      lastFocusedInput.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      active.blur();
      lastFocusedInput = null;
      document.querySelector("#input-toolbar").hidden = true;
    }
  }

  function updateInputToolbar() {
    const active = document.activeElement;
    const bar = document.querySelector("#input-toolbar");
    const focused = INPUT_ORDER.includes(active);
    bar.hidden = !focused;
    if (focused) {
      const finalInput = active === FIELDS.walkSteps || active === FIELDS.basal;
      document.querySelector("#input-next").textContent = finalInput ? "完了" : "次へ";
      positionInputToolbar();
    }
  }

  function positionInputToolbar() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const keyboardInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.querySelector("#input-toolbar").style.bottom = `${keyboardInset}px`;
  }

  function connectEvents() {
    FIELDS.date.addEventListener("change", () => switchDate(FIELDS.date.value || localDateString()));
    document.querySelector("#previous-day").addEventListener("click", () => moveDateByDays(-1));
    document.querySelector("#next-day").addEventListener("click", () => moveDateByDays(1));
    document.querySelectorAll("[data-work]").forEach((button) => button.addEventListener("click", () => {
      currentEntry.work = currentEntry.work === button.dataset.work ? "" : button.dataset.work;
      renderEntry(); saveCurrentEntry();
    }));
    FIELDS.kids.addEventListener("change", saveCurrentEntry);
    FIELDS.standing.addEventListener("input", () => {
      document.querySelector("#standing-value").value = FIELDS.standing.value;
      saveCurrentEntry();
    });
    document.querySelectorAll("[data-step]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.step;
      const delta = Number(button.dataset.delta);
      const max = key === "march" ? 2 : Number.POSITIVE_INFINITY;
      currentEntry[key] = Math.max(0, Math.min(max, currentEntry[key] + delta));
      renderEntry(); saveCurrentEntry();
    }));
    Object.values(FIELDS).filter((field) => field instanceof HTMLInputElement && field.type === "number").forEach((input) => {
      input.addEventListener("input", saveCurrentEntry);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); focusNextInput(); }
      });
      input.addEventListener("focus", () => { lastFocusedInput = input; updateInputToolbar(); });
      input.addEventListener("blur", () => setTimeout(updateInputToolbar, 80));
    });
    document.querySelector("#input-next").addEventListener("click", focusNextInput);
    document.querySelector("#copy-exercise").addEventListener("click", () => copyHtmlTable(exerciseRow()));
    document.querySelector("#copy-body").addEventListener("click", () => copyHtmlTable(bodyRow()));
    document.querySelector("#copy-weekly").addEventListener("click", copyWeeklyExercise);
    document.querySelector("#copy-weekly-body").addEventListener("click", copyWeeklyBody);
    document.querySelector("#backup-export").addEventListener("click", saveBackup);
    document.querySelector("#restore-start").addEventListener("click", () => {
      const input = document.querySelector("#restore-file");
      input.value = ""; input.click();
    });
    document.querySelector("#restore-file").addEventListener("change", (event) => previewBackup(event.target.files?.[0]));
    document.querySelector("#restore-prebackup").addEventListener("click", prepareRestoreBackup);
    document.querySelector("#restore-backup-confirm").addEventListener("change", updateRestoreTotals);
    document.querySelector("#restore-final-confirm").addEventListener("change", updateRestoreTotals);
    document.querySelector("#restore-apply").addEventListener("click", applyRestore);
    document.querySelector("#restore-cancel").addEventListener("click", cancelRestore);
    window.addEventListener("storage", handleStorageChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", positionInputToolbar);
      window.visualViewport.addEventListener("scroll", positionInputToolbar);
    }
  }

  FIELDS.date.value = localDateString();
  loadDate(FIELDS.date.value);
  connectEvents();
  if (storageLoadError) {
    document.querySelector("#save-status").textContent = "保存データを読み込めないため、自動保存を停止中です";
    showToast("保存データを読み込めません。既存データ保護のため保存を停止しています", 5000);
  }
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("オフライン用キャッシュを有効にできませんでした。", error)));
  }
})();
