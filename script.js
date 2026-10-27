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
  let historyBrowsing = false;
  let entries = readEntries();
  let currentEntry = { ...DEFAULT_ENTRY };
  let activeDate = "";
  let toastTimer;
  let saveTimer;
  // Delay access to the browser's storage property so denied access is caught
  // by the same read/write error paths as getItem/setItem failures.
  const recordStorage = { getItem(key) { return localStorage.getItem(key); },
    setItem(key, value) { return localStorage.setItem(key, value); } };
  let recordLocks;
  try { recordLocks = navigator.locks; } catch { recordLocks = undefined; }
  const recordStore = RecordSave.createStore({ storage: recordStorage, transfer: RecordTransfer,
    locks: recordLocks, isSecureContext: window.isSecureContext });
  let draftGeneration = 0;
  let latestRequest = null;
  let saveJob = null;
  let navigationPending = false;
  let saveFailure = null;

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
      return RecordTransfer.readSnapshot(stored, { strictValues: false }).records;
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
    updateDateSelection();
  }

  function validDate(date) {
    try { RecordTransfer.validateRecordsMap({ [date]: {} }); return true; }
    catch { return false; }
  }

  function updateDateSelection() {
    const candidate = FIELDS.date.value, different = candidate !== activeDate;
    document.querySelector("#date-heading").textContent = different ? "変更先の日付" : "日付";
    document.querySelector("#date-actions").hidden = !different;
    const apply = document.querySelector("#date-apply"); apply.hidden = !different;
    apply.disabled = navigationPending || !different || !validDate(candidate);
    const reset = document.querySelector("#date-reset"); reset.hidden = !different; reset.disabled = navigationPending;
    const status = document.querySelector("#date-status"); status.hidden = !different;
    status.textContent = different ? `現在の記録：${activeDate.replace(/-/g, "/")}` : "";
  }

  async function switchDate(date) {
    if (!validDate(date)) return false;
    if (restoreSession || historyBrowsing) { FIELDS.date.value = activeDate; return; }
    if (navigationPending) return false;
    if (date === activeDate) {
      FIELDS.date.value = activeDate;
      updateDateSelection(); return true;
    }
    if (storageLoadError) {
      showToast("保存データを読み込めないため、日付変更を停止しています", 4000);
      return;
    }
    navigationPending = true;
    document.querySelector("#entry-fields").disabled = true;
    updateDateSelection();
    try {
      // Viewing an untouched day must not turn its defaults into a saved record.
      if ((hasUnsavedChanges || saveJob) && !await saveCurrentEntry()) return false;
      entries = readEntries();
      if (storageLoadError) return false;
      loadDate(date);
      return true;
    } finally {
      navigationPending = false;
      document.querySelector("#entry-fields").disabled = Boolean(restoreSession);
      updateDateSelection();
    }
  }

  function moveDateByDays(dayDelta) {
    const [year, month, day] = activeDate.split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return;
    // Use local noon so daylight-saving transitions cannot shift the calendar date.
    const date = new Date(year, month - 1, day + dayDelta, 12);
    return switchDate(localDateString(date));
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
    if (restoreSession || historyBrowsing) return Promise.resolve(false);
    hasUnsavedChanges = true;
    captureForm();
    latestRequest = { date: activeDate, entry: { ...currentEntry }, generation: ++draftGeneration };
    clearTimeout(saveTimer);
    // Keep capturing edits even when persistence is stopped, so a later stepper
    // render cannot replace typed fields with an older in-memory draft.
    if (storageLoadError || ["STALE", "INVALID_STORAGE", "VERIFY_FAILED"].includes(saveFailure?.code)) {
      document.querySelector("#save-status").textContent = saveFailure?.message || "保存データを読み込めないため、自動保存を停止中です。入力はこの画面に保持しています";
      updateSaveRetry();
      return Promise.resolve(false);
    }
    document.querySelector("#save-status").textContent = "保存待ち：入力はこの画面に保持しています";
    if (!saveJob) saveJob = drainSaves();
    updateSaveRetry();
    return saveJob;
  }

  function updateSaveRetry() {
    const button = document.querySelector("#save-retry");
    button.hidden = !hasUnsavedChanges || !saveFailure;
    button.disabled = Boolean(saveJob) || !recordStore.supported()
      || ["STALE", "VERIFY_FAILED", "INVALID_STORAGE"].includes(saveFailure?.code);
  }

  function idleSaveStatus(message = "この端末に自動保存されます") {
    if (storageLoadError) return "保存データを読み込めないため、自動保存を停止中です";
    return recordStore.supported() ? message : "この接続では安全に保存できません。保存済み記録は閲覧できます。入力・復元はHTTPSのテスト用URLで行ってください";
  }

  async function drainSaves() {
    // Defer execution until saveJob is assigned, including synchronous failures.
    await Promise.resolve();
    try {
      while (latestRequest) {
        let selected;
        const result = await recordStore.saveDay(() => {
          selected = latestRequest;
          return { ...selected, expected: entries[selected.date] };
        }, { onAcquired() { document.querySelector("#save-status").textContent = "保存中：まだ画面を閉じないでください"; } });
        entries = result.records;
        if (latestRequest === selected) latestRequest = null;
        if (!latestRequest && result.generation === draftGeneration) {
          hasUnsavedChanges = false; saveFailure = null;
          document.querySelector("#save-status").textContent = "保存済み";
          const generation = draftGeneration;
          saveTimer = setTimeout(() => {
            if (!hasUnsavedChanges && generation === draftGeneration && !restoreSession) document.querySelector("#save-status").textContent = "この端末に自動保存されます";
          }, 1400);
        }
      }
      return true;
    } catch (error) {
      saveFailure = error;
      document.querySelector("#save-status").textContent = error.message || "保存できませんでした。入力内容はこの画面に残っています";
      if (error.code === "VERIFY_FAILED" || error.outcome === "unknown") storageLoadError = "保存結果を確認できません。自動再保存を停止しています";
      console.error("端末内への保存を確認できませんでした。", error);
      return false;
    } finally {
      saveJob = null;
      updateSaveRetry();
    }
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
    if (hasUnsavedChanges || saveJob) {
      showToast("未保存の入力があります。保存を確認してからバックアップしてください。入力を失わないよう控えてください", 5000);
      return false;
    }
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
    document.querySelector("#history-show").disabled = locked;
    document.querySelector("#graph-show").disabled = locked;
    if (locked) {
      clearTimeout(saveTimer);
      document.querySelector("#save-status").textContent = "復元の確認中：通常入力を一時停止しています";
    }
    document.querySelector("#entry-fields").disabled = locked;
    document.querySelector("#backup-export").disabled = locked;
    document.querySelector("#restore-start").disabled = locked;
    document.querySelector("#csv-start").disabled = locked;
  }

  function clearRestoreConfirmations() {
    document.querySelector("#restore-backup-confirm").checked = false;
    document.querySelector("#restore-final-confirm").checked = false;
    document.querySelector("#restore-backup-confirm").disabled = true;
  }

  function invalidateRestore(message) {
    if (!restoreSession) return;
    restoreSession.stale = true;
    clearCsvConflictIndex();
    clearRestoreConfirmations();
    document.querySelector("#restore-prebackup").disabled = true;
    document.querySelector("#restore-apply").disabled = true;
    setRestoreMessage(message, true);
  }

  async function previewBackup(file) {
    if (!file) return;
    if (restoreSession) return;
    if (hasUnsavedChanges || storageLoadError) {
      setRestoreMessage("現在の入力または保存データを安全に確認できません。保存エラーを解消してから復元してください。", true);
      return;
    }
    const token = ++restoreToken;
    restoreSession = { loading: true, stale: false, choices: {} };
    lockForRestore(true);
    setTransferLabels(false);
    clearCsvConflictIndex();
    document.querySelector("#csv-settings").hidden = true;
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

  function setTransferLabels(csv) {
    document.querySelector("#restore-heading").textContent = csv ? "CSV取り込み内容の確認" : "復元内容の確認";
    document.querySelector("#restore-prebackup").textContent = csv ? "① 取り込み前バックアップを保存" : "① 復元前バックアップを保存";
    document.querySelector("#restore-apply").textContent = csv ? "確認してCSV取り込みを実行" : "確認して復元を実行";
  }

  async function previewCsv(file) {
    if (!file || restoreSession) return;
    if (hasUnsavedChanges || storageLoadError) {
      setRestoreMessage("現在の入力または保存データを安全に確認できません。保存エラーを解消してから取り込んでください。", true);
      return;
    }
    const token = ++restoreToken;
    restoreSession = { mode: "csv", loading: true, stale: false, choices: {}, included: {}, page: 0 };
    lockForRestore(true);
    setTransferLabels(true);
    clearCsvConflictIndex();
    document.querySelector("#restore-panel").hidden = false;
    document.querySelector("#restore-preview").hidden = true;
    document.querySelector("#csv-settings").hidden = false;
    document.querySelector("#csv-options").disabled = true;
    document.querySelector("#csv-review").hidden = true;
    document.querySelector("#csv-summary").hidden = true;
    document.querySelector("#csv-errors").replaceChildren();
    document.querySelector("#csv-year-confirm").checked = false;
    document.querySelector("#csv-filename").textContent = `ファイル：${file.name}`;
    clearRestoreConfirmations();
    setRestoreMessage("UTF-8とCSV構造を確認しています。保存データは変更しません。");
    try {
      const baselineRaw = localStorage.getItem(STORAGE_KEY);
      const bytes = await file.arrayBuffer();
      if (token !== restoreToken) return;
      if (restoreSession.stale || localStorage.getItem(STORAGE_KEY) !== baselineRaw) throw new Error("読み込み中に現在の記録が変わりました。閉じてファイルを選び直してください。");
      const source = NumbersCsv.readCsv(bytes);
      RecordTransfer.readSnapshot(baselineRaw);
      Object.assign(restoreSession, { source, baselineRaw, loading: false });
      document.querySelector("#csv-options").disabled = false;
      setRestoreMessage("CSV構造を確認しました。基準年と期間を確認してプレビューしてください。まだ保存していません。");
    } catch (error) {
      if (token !== restoreToken) return;
      invalidateRestore(`エラー1件：${error.message}。取り込み全体を停止しました。`);
    }
  }

  function resetCsvPreview() {
    if (restoreSession?.applying) return;
    if (restoreSession?.mode !== "csv") return;
    clearCsvConflictIndex();
    restoreSession.plan = null;
    restoreSession.result = null;
    restoreSession.included = {};
    restoreSession.choices = {};
    restoreSession.backupPrepared = false;
    clearRestoreConfirmations();
    document.querySelector("#restore-preview").hidden = true;
    document.querySelector("#csv-review").hidden = true;
    document.querySelector("#csv-summary").hidden = true;
    document.querySelector("#csv-errors").replaceChildren();
    document.querySelector("#restore-apply").disabled = true;
    if (!restoreSession.stale) setRestoreMessage("条件が変更されました。基準年・期間を確認して、もう一度プレビューしてください。");
  }

  function buildCsvPreview() {
    const session = restoreSession;
    if (session?.applying) return;
    if (session?.mode !== "csv" || !session.source || session.stale) return;
    resetCsvPreview();
    try {
      if (localStorage.getItem(STORAGE_KEY) !== session.baselineRaw) {
        invalidateRestore("現在の記録が変わりました。閉じてファイルを選び直してください。");
        return;
      }
      session.result = NumbersCsv.convertRows(session.source, {
        year: document.querySelector("#csv-year").value,
        start: document.querySelector("#csv-start-date").value,
        end: document.querySelector("#csv-end-date").value,
        yearConfirmed: document.querySelector("#csv-year-confirm").checked
      });
      session.page = 0;
      const { stats, errors } = session.result;
      document.querySelector("#csv-summary").hidden = false;
      document.querySelector("#csv-summary").textContent = `基準年：${session.result.options.year}\n対象期間：${session.result.options.start}〜${session.result.options.end}\nCSV全行数（見出し含む論理行）：${stats.total + 1}\nデータ行：${stats.total}／期間内：${stats.inside}／期間外：${stats.outside}\n未記録として除外：${stats.unrecorded}日／日付・記録なし行：${stats.undated}\n変換成功：${stats.converted}日（うちスタンディング10のみ：${stats.ambiguous}日、個別確認が必要）\nエラー：${errors.length}件／警告：${session.result.warnings.length}件`;
      document.querySelector("#csv-errors").replaceChildren(...errors.map((text) => restoreNode("li", text)));
      document.querySelector("#csv-review").hidden = false;
      renderCsvRows();
      if (errors.length) { setRestoreMessage("変換エラーがあるため全体を停止しました。CSVを修正し、ファイルを選び直してください。保存内容は変更していません。", true); return; }
      refreshCsvPlan();
    } catch (error) {
      session.plan = null;
      document.querySelector("#restore-preview").hidden = true;
      setRestoreMessage(`取り込みを停止しました：${error.message}。条件を確認して再プレビューしてください。`, true);
    }
  }

  function refreshCsvPlan() {
    const session = restoreSession;
    if (session?.mode !== "csv" || session.stale || !session.result || session.result.errors.length) return;
    session.plan = RecordTransfer.createPlan(session.baselineRaw, NumbersCsv.selectedRecords(session.result, session.included));
    session.choices = {};
    session.backupPrepared = false;
    clearRestoreConfirmations();
    renderRestorePreview();
  }

  function renderCsvRows() {
    const session = restoreSession;
    if (session?.mode !== "csv" || !session.result) return;
    const rows = session.result.rows;
    const start = session.page * 10;
    const container = document.querySelector("#csv-rows");
    container.replaceChildren();
    const statusLabels = { converted: "変換済み", outside: "期間外・除外", unrecorded: "未記録・除外", undated: "日付と記録なし・除外", error: "エラー・全体停止" };
    for (const row of rows.slice(start, start + 10)) {
      const card = restoreNode("details", undefined, "restore-conflict");
      card.append(restoreNode("summary", `${row.date || "日付なし"}（CSV論理行${row.line}）${statusLabels[row.status]}`));
      const original = row.raw.map((value, index) => `${String.fromCharCode(65 + index)} ${NumbersCsv.HEADERS[index]}：${JSON.stringify(value)}`).join("\n");
      card.append(restoreNode("p", "CSV元データ"), restoreNode("pre", original, "csv-record-values"));
      if (row.entry) card.append(restoreNode("p", "変換後の保存値（散歩・身体の空欄は \"\"）"), restoreNode("pre", JSON.stringify(row.entry, null, 2), "csv-record-values"));
      for (const note of row.notes) card.append(restoreNode("p", note, "csv-warning"));
      if (row.error) card.append(restoreNode("p", row.error, "csv-warning"));
      if (row.ambiguous && row.status === "converted" && !session.result.errors.length) {
        const label = restoreNode("label", undefined, "restore-confirm");
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = session.included[row.date] === true;
        checkbox.disabled = session.stale;
        checkbox.addEventListener("change", () => {
          if (session !== restoreSession || session.stale) return;
          session.included[row.date] = checkbox.checked;
          refreshCsvPlan();
        });
        label.append(checkbox, restoreNode("span", "この日を実際の記録として取り込む（競合選択・保存確認は再設定されます）")); card.append(label);
      }
      container.append(card);
    }
    document.querySelector("#csv-page-label").textContent = rows.length ? `${start + 1}〜${Math.min(start + 10, rows.length)}／${rows.length}` : "0件";
    document.querySelector("#csv-page-prev").disabled = session.page === 0;
    document.querySelector("#csv-page-next").disabled = start + 10 >= rows.length;
  }

  function clearCsvConflictIndex() {
    document.querySelector("#csv-conflict-index").hidden = true;
    document.querySelector("#csv-conflict-heading").textContent = "";
    document.querySelector("#csv-conflict-links").replaceChildren();
    document.querySelector("#csv-conflict-links").scrollTop = 0;
    if (restoreSession) {
      restoreSession.conflictElements = new Map();
      restoreSession.jumpSequence = (restoreSession.jumpSequence || 0) + 1;
    }
  }

  function renderCsvConflictIndex(conflicts) {
    const session = restoreSession;
    const plan = session.plan;
    const list = document.querySelector("#csv-conflict-links");
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    document.querySelector("#csv-conflict-index").hidden = conflicts.length === 0;
    document.querySelector("#csv-conflict-heading").textContent = `競合している記録：${conflicts.length}日`;
    for (const row of conflicts) {
      const item = restoreNode("li");
      const button = restoreNode("button", undefined, "csv-conflict-link");
      button.type = "button";
      button.dataset.conflictDate = row.date;
      button.setAttribute("aria-label", `${row.date.replace(/-/g, "/")}の競合詳細を見る`);
      button.append(restoreNode("span", row.date.replace(/-/g, "/")), restoreNode("span", "詳細を見る"));
      button.addEventListener("click", () => jumpToCsvConflict(row.date, session, plan));
      item.append(button); list.append(item);
    }
    list.scrollTop = scrollTop;
  }

  function jumpToCsvConflict(date, session, plan) {
    if (session !== restoreSession || session.mode !== "csv" || session.stale || session.plan !== plan) return;
    if (!plan.rows.some((row) => row.date === date && row.kind === "conflict")) return;
    // Page positions use the complete CSV rows, including excluded/unrecorded days.
    const rowIndex = session.result.rows.findIndex((row) => row.date === date);
    if (rowIndex < 0) return;
    const page = Math.floor(rowIndex / 10);
    if (session.page !== page) {
      session.page = page;
      renderCsvRows();
      renderRestorePreview();
    }
    const target = session.conflictElements.get(date);
    if (!target) return;
    target.details.open = true;
    const sequence = session.jumpSequence = (session.jumpSequence || 0) + 1;
    const scroll = () => {
      if (restoreSession !== session || session.stale || session.plan !== plan || session.page !== page
        || session.jumpSequence !== sequence || session.conflictElements.get(date) !== target) return;
      target.heading.focus({ preventScroll: true });
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      target.card.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    };
    // Wait for the new page and opened details to be laid out before scrolling.
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(scroll);
    else setTimeout(scroll, 0);
  }

  function renderRestorePreview() {
    const { plan, backup } = restoreSession;
    const csv = restoreSession.mode === "csv";
    const dates = Object.keys(plan.incoming).sort();
    const conflicts = plan.rows.filter((row) => row.kind === "conflict").sort((left, right) => left.date.localeCompare(right.date));
    const newCount = plan.rows.filter((row) => row.kind === "new").length;
    const sameCount = plan.rows.filter((row) => row.kind === "same").length;
    const sourceInfo = csv ? `ファイル：${document.querySelector("#csv-filename").textContent.replace(/^ファイル：/, "")}\nスタンディング10のみで未選択：${restoreSession.result.stats.ambiguous - Object.values(restoreSession.included).filter(Boolean).length}日（除外）` : `作成日時：${new Date(backup.exportedAt).toLocaleString("ja-JP")}`;
    const allWarnings = csv ? [...restoreSession.result.warnings, ...plan.warnings.map((text) => text.replace(/^バックアップ：/, "CSV："))] : plan.warnings;
    document.querySelector("#restore-summary").textContent = `${sourceInfo}\n記録日数：${dates.length}日\n期間：${dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : "記録なし"}\n新規追加：${newCount}日／完全一致：${sameCount}日／競合：${conflicts.length}日\nエラー：0件／警告：${allWarnings.length}件`;
    const warnings = document.querySelector("#restore-warnings");
    warnings.replaceChildren(...allWarnings.map((text) => restoreNode("li", text)));
    if (csv) renderCsvConflictIndex(conflicts);
    else clearCsvConflictIndex();
    restoreSession.conflictElements = new Map();
    const list = document.querySelector("#restore-conflicts");
    list.replaceChildren();
    const visibleDates = csv ? new Set(restoreSession.result.rows.slice(restoreSession.page * 10, restoreSession.page * 10 + 10).map((row) => row.date)) : null;
    const visibleConflicts = csv ? conflicts.filter((row) => visibleDates.has(row.date)) : conflicts;
    if (csv) list.append(restoreNode("p", `このページの競合：${visibleConflicts.length}日／全${conflicts.length}日。上の「全件の変換結果」のページ移動で、ほかの日付も確認できます。`, "restore-help"));
    const labels = { work: "勤務区分", kids: "子供と動く", standing: "スタンディング", squat: "スクワット", march: "足踏み", plank: "プランク", walkMinutes: "散歩・分", walkSeconds: "散歩・秒", distance: "距離", walkSteps: "歩数", weight: "体重", bodyFat: "体脂肪率", basal: "基礎代謝" };
    for (const row of visibleConflicts) {
      const card = restoreNode("div", undefined, "restore-conflict");
      const details = restoreNode("details");
      const heading = restoreNode("summary", `${row.date} の相違${row.defaultOnly ? "（現在は初期値のみの可能性）" : ""}`);
      details.append(heading);
      if (csv) {
        card.id = `csv-conflict-${row.date}`;
        card.className += " csv-conflict-target";
        card.dataset.conflictDate = row.date;
        restoreSession.conflictElements.set(row.date, { card, details, heading });
      }
      for (const diff of row.differences) {
        const field = restoreNode("div", undefined, "restore-diff");
        field.append(restoreNode("strong", Object.prototype.hasOwnProperty.call(labels, diff.field) ? labels[diff.field] : `未知項目：${diff.field}`));
        const values = restoreNode("div", undefined, "restore-values");
        for (const [title, value] of [["現在", diff.existing], [csv ? "CSV" : "バックアップ", diff.incoming]]) {
          const cell = restoreNode("div");
          cell.append(restoreNode("span", title), restoreNode("code", value === undefined ? "項目なし" : JSON.stringify(value)));
          values.append(cell);
        }
        if (csv && diff.existing !== "" && diff.existing !== undefined && (diff.incoming === "" || diff.incoming === undefined || (diff.existing !== 0 && diff.incoming === 0) || (diff.existing === true && diff.incoming === false))) {
          field.append(restoreNode("p", "置換すると、この既存値は空欄・0・OFFになります。CSVの空欄は削除指示ではないため、必要がなければ既存を維持してください。", "csv-warning"));
        }
        field.append(values); details.append(field);
      }
      const label = restoreNode("label", undefined, "restore-choice");
      label.append(restoreNode("span", `${row.date} の${csv ? "取り込み" : "復元"}方法`));
      const select = document.createElement("select");
      for (const [value, text] of [["keep", "既存を維持"], ["replace", csv ? "CSVで置換" : "バックアップで置換"]]) {
        const option = restoreNode("option", text); option.value = value; select.append(option);
      }
      select.value = restoreSession.choices[row.date] || "keep";
      select.addEventListener("change", () => {
        if (!restoreSession || restoreSession.stale || restoreSession.applying) return;
        restoreSession.choices[row.date] = select.value;
        document.querySelector("#restore-final-confirm").checked = false;
        updateRestoreTotals();
      });
      label.append(select); card.append(details, label); list.append(card);
    }
    document.querySelector("#restore-preview").hidden = false;
    document.querySelector("#restore-prebackup").disabled = Boolean(restoreSession.backupInProgress);
    setRestoreMessage("まだ保存内容は変更していません。相違内容と件数を確認してください。復元中は通常入力を一時停止しています。");
    updateRestoreTotals();
  }

  function updateRestoreTotals() {
    if (restoreSession?.applying) { document.querySelector("#restore-apply").disabled = true; return; }
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
    if (!session?.plan || session.stale || session.applying || session.backupInProgress) return;
    clearRestoreConfirmations();
    session.backupPrepared = false;
    session.backupInProgress = true;
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
      session.backupInProgress = false;
      if (session === restoreSession) {
        document.querySelector("#restore-prebackup").disabled = session.stale;
        updateRestoreTotals();
      }
    }
  }

  function finishRestoreSession() {
    ++restoreToken;
    clearCsvConflictIndex();
    restoreSession = null;
    lockForRestore(false);
    document.querySelector("#restore-file").value = "";
    document.querySelector("#csv-file").value = "";
    document.querySelector("#csv-settings").hidden = true;
    document.querySelector("#restore-preview").hidden = true;
    entries = readEntries();
    hasUnsavedChanges = false;
    loadDate(activeDate);
    clearTimeout(saveTimer);
    document.querySelector("#save-status").textContent = idleSaveStatus();
  }

  function cancelRestore() {
    if (restoreSession?.applying) { showToast("保存結果の確認が終わるまでお待ちください"); return; }
    if (restoreSession) finishRestoreSession();
    document.querySelector("#restore-panel").hidden = true;
    setRestoreMessage("");
  }

  async function applyRestore() {
    const session = restoreSession;
    if (!session?.plan || session.applying || session.stale || !session.backupPrepared || !document.querySelector("#restore-backup-confirm").checked || !document.querySelector("#restore-final-confirm").checked) return;
    const { counts } = RecordTransfer.buildCandidate(session.plan, session.choices);
    if (counts.added + counts.replaced === 0) return;
    if (!window.confirm(`追加${counts.added}件・置換${counts.replaced}件を反映します。保存日数は${counts.before}→${counts.after}日です。復元前バックアップを保存・確認済みですか？`)) return;
    session.applying = true;
    document.querySelector("#restore-apply").disabled = true;
    document.querySelector("#restore-cancel").disabled = true;
    document.querySelector("#restore-prebackup").disabled = true;
    document.querySelector("#csv-options").disabled = true;
    document.querySelector("#restore-backup-confirm").disabled = true;
    document.querySelector("#restore-final-confirm").disabled = true;
    document.querySelectorAll("#restore-panel select").forEach((select) => { select.disabled = true; });
    setRestoreMessage("安全な保存の順番待ち・照合中です。画面を閉じずにお待ちください。");
    try {
      const result = await RecordTransfer.commitRecords(recordStorage, STORAGE_KEY, session.plan, session.choices, { backupConfirmed: true, finalConfirmed: true }, { store: recordStore });
      finishRestoreSession();
      setRestoreMessage(`${session.mode === "csv" ? "CSV取り込み" : "復元"}と読み戻し照合が完了しました。追加${result.counts.added}件・置換${result.counts.replaced}件・スキップ${result.counts.skipped}件（うち一致${result.counts.same}件）／合計${result.counts.after}日。`);
    } catch (error) {
      invalidateRestore(error.message);
      if (error.code === "VERIFY_FAILED") {
        storageLoadError = "復元後の保存内容を照合できませんでした";
        document.querySelector("#save-status").textContent = "復元後の照合に失敗したため、自動保存を停止中です";
      }
    } finally {
      session.applying = false;
      document.querySelector("#restore-cancel").disabled = false;
    }
  }

  function handleStorageChange(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    if (restoreSession) {
      if (restoreSession.plan || restoreSession.mode === "csv") invalidateRestore("別の画面で現在の記録が更新されました。閉じてファイルを選び直し、再検証してください。");
      return;
    }
    if (hasUnsavedChanges) {
      // Keep the confirmed baseline and draft separate. The writer compares this
      // day under the lock, and preserves unrelated dates from the latest map.
      document.querySelector("#save-status").textContent = "別の画面で更新がありました。入力を保持し、保存時に同じ日付の競合を確認します";
      return;
    }
    entries = readEntries();
    loadDate(activeDate);
    clearTimeout(saveTimer);
    document.querySelector("#save-status").textContent = idleSaveStatus("別の画面の更新を読み込みました");
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
      const text = weeklyBodyCopyText(activeDate);
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
      const text = weeklyCopyText(activeDate);
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
    const active = document.activeElement;
    if (!INPUT_ORDER.includes(active)) return;
    if (active === FIELDS.walkSteps || active === FIELDS.basal) {
      active.blur();
      return;
    }
    const index = INPUT_ORDER.indexOf(active);
    if (index >= 0 && index < INPUT_ORDER.length - 1) {
      INPUT_ORDER[index + 1].focus();
      INPUT_ORDER[index + 1].scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      active.blur();
    }
  }

  function connectDateSwipe() {
    const screen = document.querySelector("#input-screen");
    let start = null;
    const blocked = () => historyBrowsing || restoreSession || navigationPending || screen.hidden;
    screen.addEventListener("touchstart", (event) => {
      start = null;
      if (blocked() || event.touches.length !== 1
        || event.target?.closest?.("input, button, select, textarea, label, a, [role=button], [contenteditable], .date-card")) return;
      const touch = event.touches[0], width = window.innerWidth || document.documentElement?.clientWidth || 0;
      // Leave screen-edge gestures and all native form controls to the browser.
      if (touch.clientX < 24 || touch.clientX > width - 24) return;
      start = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    screen.addEventListener("touchmove", (event) => {
      if (!start) return;
      if (event.touches.length !== 1) { start = null; return; }
      const dx = Math.abs(event.touches[0].clientX - start.x), dy = Math.abs(event.touches[0].clientY - start.y);
      if (dy > 40 || (dy > 18 && dy > dx)) start = null;
    }, { passive: true });
    screen.addEventListener("touchend", (event) => {
      const from = start; start = null;
      if (!from || blocked() || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - from.x, dy = event.changedTouches[0].clientY - from.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 2) return moveDateByDays(dx > 0 ? -1 : 1);
    }, { passive: true });
    screen.addEventListener("touchcancel", () => { start = null; }, { passive: true });
  }

  function connectEvents() {
    FIELDS.date.addEventListener("input", updateDateSelection);
    FIELDS.date.addEventListener("change", updateDateSelection);
    document.querySelector("#date-today").addEventListener("click", () => { FIELDS.date.value = localDateString(); updateDateSelection(); });
    document.querySelector("#date-apply").addEventListener("click", () => switchDate(FIELDS.date.value));
    document.querySelector("#date-reset").addEventListener("click", () => { FIELDS.date.value = activeDate; updateDateSelection(); });
    connectDateSwipe();
    document.querySelectorAll("[data-work]").forEach((button) => button.addEventListener("click", () => {
      currentEntry.work = currentEntry.work === button.dataset.work ? "" : button.dataset.work;
      renderEntry(); return saveCurrentEntry();
    }));
    FIELDS.kids.addEventListener("change", saveCurrentEntry);
    FIELDS.standing.addEventListener("input", () => {
      document.querySelector("#standing-value").value = FIELDS.standing.value;
      return saveCurrentEntry();
    });
    document.querySelectorAll("[data-step]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.step;
      const delta = Number(button.dataset.delta);
      const max = key === "march" ? 2 : Number.POSITIVE_INFINITY;
      currentEntry[key] = Math.max(0, Math.min(max, currentEntry[key] + delta));
      renderEntry(); return saveCurrentEntry();
    }));
    Object.values(FIELDS).filter((field) => field instanceof HTMLInputElement && field.type === "number").forEach((input) => {
      input.addEventListener("input", saveCurrentEntry);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); focusNextInput(); }
      });
    });
    document.querySelector("#copy-exercise").addEventListener("click", () => copyHtmlTable(exerciseRow()));
    document.querySelector("#copy-body").addEventListener("click", () => copyHtmlTable(bodyRow()));
    document.querySelector("#copy-weekly").addEventListener("click", copyWeeklyExercise);
    document.querySelector("#copy-weekly-body").addEventListener("click", copyWeeklyBody);
    document.querySelector("#backup-export").addEventListener("click", saveBackup);
    document.querySelector("#save-retry").addEventListener("click", () => {
      if (!saveJob && !storageLoadError && !["STALE", "VERIFY_FAILED", "INVALID_STORAGE"].includes(saveFailure?.code)) return saveCurrentEntry();
    });
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
    document.querySelector("#csv-start").addEventListener("click", () => {
      const input = document.querySelector("#csv-file"); input.value = ""; input.click();
    });
    document.querySelector("#csv-file").addEventListener("change", (event) => previewCsv(event.target.files?.[0]));
    for (const id of ["csv-year", "csv-start-date", "csv-end-date", "csv-year-confirm"]) {
      document.querySelector(`#${id}`).addEventListener(id === "csv-year-confirm" ? "change" : "input", () => {
        if (id !== "csv-year-confirm") document.querySelector("#csv-year-confirm").checked = false;
        resetCsvPreview();
      });
    }
    document.querySelector("#csv-preview-button").addEventListener("click", buildCsvPreview);
    for (const [id, delta] of [["csv-page-prev", -1], ["csv-page-next", 1]]) {
      document.querySelector(`#${id}`).addEventListener("click", () => {
        if (!restoreSession?.result || restoreSession.applying) return;
        const max = Math.max(0, Math.ceil(restoreSession.result.rows.length / 10) - 1);
        restoreSession.page = Math.max(0, Math.min(max, restoreSession.page + delta)); renderCsvRows();
        if (restoreSession.plan && !restoreSession.stale) renderRestorePreview();
      });
    }
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("pagehide", () => recordStore.cancelPending());
    window.addEventListener("beforeunload", (event) => {
      if (hasUnsavedChanges || saveJob || restoreSession?.applying) { event.preventDefault(); event.returnValue = ""; }
    });
  }

  // Non-input screens share this browsing guard; never navigate via switchDate.
  window.RecordHistoryInput = Object.freeze({
    canBrowse() {
      if (restoreSession) return "復元・CSV取り込みの確認を閉じてから画面を切り替えてください";
      if (hasUnsavedChanges || saveJob || navigationPending) return "未保存または保存待ちの入力があります。保存を確認し、エラー時は入力内容を控えてから画面を切り替えてください";
      return "";
    },
    notify(message) { showToast(message, 5000); },
    setBrowsing(open) {
      const wasBrowsing = historyBrowsing;
      historyBrowsing = open;
      if (!open && wasBrowsing && !hasUnsavedChanges) {
        entries = readEntries(); loadDate(activeDate);
        document.querySelector("#save-status").textContent = idleSaveStatus();
      }
    },
    openSavedDate(date, expectedRaw) {
      const blocked = this.canBrowse();
      if (blocked) return blocked;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== expectedRaw) return "閲覧中に保存内容が変わりました。最新の詳細を確認してから、もう一度開いてください。";
        const snapshot = RecordTransfer.readSnapshot(raw);
        if (!Object.prototype.hasOwnProperty.call(snapshot.records, date)) return "この日には保存記録がありません。記録は作成していません。";
        entries = snapshot.records; storageLoadError = ""; loadDate(date);
        return "";
      } catch (error) { return `入力画面への移動を停止しました：${error.message}。保存内容は変更していません。`; }
    }
  });

  FIELDS.date.value = localDateString();
  loadDate(FIELDS.date.value);
  connectEvents();
  if (storageLoadError) {
    document.querySelector("#save-status").textContent = "保存データを読み込めないため、自動保存を停止中です";
    showToast("保存データを読み込めません。既存データ保護のため保存を停止しています", 5000);
  } else if (!recordStore.supported()) {
    document.querySelector("#save-status").textContent = "この接続では安全に保存できません。保存済み記録は閲覧できます。入力・復元はHTTPSのテスト用URLで行ってください";
  }
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("オフライン用キャッシュを有効にできませんでした。", error)));
  }
})();
