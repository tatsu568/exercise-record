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
    currentEntry = { ...DEFAULT_ENTRY, ...(entries[date] || {}) };
    FIELDS.date.value = date;
    renderEntry();
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
    entries[FIELDS.date.value] = { ...currentEntry };
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
    document.querySelectorAll('[data-step="march"][data-delta="1"]').forEach((button) => { button.disabled = currentEntry.march >= 2; });
  }

  function circleCount(count) { return count > 0 ? "○".repeat(count) : ""; }
  function explicitValue(value) { return value === "" ? "" : value; }

  function walkText() {
    const parts = [];
    const minutes = explicitValue(FIELDS.walkMinutes.value);
    const seconds = explicitValue(FIELDS.walkSeconds.value);
    if (minutes !== "" || seconds !== "") parts.push(`${minutes === "" ? "" : `${minutes}分`}${seconds === "" ? "" : `${seconds}秒`}`);
    const distance = explicitValue(FIELDS.distance.value);
    if (distance !== "") parts.push(`${distance}km`);
    const steps = explicitValue(FIELDS.walkSteps.value);
    if (steps !== "") parts.push(`${steps}歩`);
    return parts.join(" ");
  }

  function exerciseRow() {
    const work = currentEntry.work;
    return [
      FIELDS.date.value,
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
    return [FIELDS.date.value, explicitValue(FIELDS.weight.value), explicitValue(FIELDS.bodyFat.value), explicitValue(FIELDS.basal.value)];
  }

  async function copyValues(values) {
    const text = values.join("\t");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else if (!legacyCopy(text)) {
        throw new Error("clipboard unavailable");
      }
      showToast("コピーしました");
    } catch (error) {
      console.error("クリップボードにコピーできませんでした。", error);
      showToast("コピーできませんでした。ページをHTTPSで開いてください", 3200);
    }
  }

  function legacyCopy(text) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
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
    FIELDS.date.addEventListener("change", () => loadDate(FIELDS.date.value || localDateString()));
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
    document.querySelector("#copy-all").addEventListener("click", () => copyValues([...exerciseRow(), ...bodyRow()]));
    document.querySelector("#copy-exercise").addEventListener("click", () => copyValues(exerciseRow()));
    document.querySelector("#copy-body").addEventListener("click", () => copyValues(bodyRow()));
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
