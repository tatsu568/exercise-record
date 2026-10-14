(() => {
  "use strict";

  const STORAGE_KEY = "exercise-record.entries.v1";
  const DEFAULT_ENTRY = Object.freeze({
    work: "", kids: false, standing: 10, squat: 0, march: 0, plank: 0,
    walkMinutes: "", walkSeconds: "", distance: "", walkSteps: "",
    weight: "", bodyFat: "", basal: ""
  });
  const FIELDS = {
    date: document.querySelector("#record-date"), kids: document.querySelector("#kids"),
    standing: document.querySelector("#standing"), walkMinutes: document.querySelector("#walk-minutes"),
    walkSeconds: document.querySelector("#walk-seconds"), distance: document.querySelector("#distance"),
    walkSteps: document.querySelector("#walk-steps"), weight: document.querySelector("#weight"),
    bodyFat: document.querySelector("#body-fat"), basal: document.querySelector("#basal")
  };
  const INPUT_ORDER = [FIELDS.walkMinutes, FIELDS.walkSeconds, FIELDS.distance, FIELDS.walkSteps, FIELDS.weight, FIELDS.bodyFat, FIELDS.basal];
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
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn("保存データを読み込めませんでした。", error);
      return {};
    }
  }

  function loadDate(date) {
    activeDate = date;
    currentEntry = { ...DEFAULT_ENTRY, ...(entries[date] || {}) };
    FIELDS.date.value = date;
    renderEntry();
  }

  function switchDate(date) {
    if (!date) return;
    if (date === activeDate) {
      FIELDS.date.value = activeDate;
      return;
    }
    // Persist the currently displayed entry under its original date before loading another.
    saveCurrentEntry();
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
    captureForm();
    entries[activeDate || FIELDS.date.value] = { ...currentEntry };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      const status = document.querySelector("#save-status");
      status.textContent = "保存済み";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { status.textContent = "この端末に自動保存されます"; }, 1400);
    } catch (error) {
      document.querySelector("#save-status").textContent = "保存できません。ブラウザの空き容量を確認してください";
      console.error("端末内への保存に失敗しました。", error);
    }
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

    const dates = previousWeekDates(selectedDate);
    const includeYear = dates[0].slice(0, 4) !== dates[6].slice(0, 4);
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
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", positionInputToolbar);
      window.visualViewport.addEventListener("scroll", positionInputToolbar);
    }
  }

  FIELDS.date.value = localDateString();
  loadDate(FIELDS.date.value);
  connectEvents();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("オフライン用キャッシュを有効にできませんでした。", error)));
  }
})();
