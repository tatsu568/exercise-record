(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecordSave = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const KEY = "exercise-record.entries.v1";
  const LOCK_NAME = "exercise-record.records-and-ack.v1";
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  function failure(code, message, phase, outcome = "not-written", cause) {
    return Object.assign(new Error(message), { code, phase, outcome, cause });
  }
  function createStore({ storage, transfer, locks, isSecureContext, key = KEY, timeoutMs = 5000,
    timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) } }) {
    if (key !== KEY) throw new Error("記録保存キーが一致しません");
    const controllers = new Set();
    const supported = () => {
      try { return isSecureContext === true && typeof locks?.request === "function"; }
      catch { return false; }
    };
    function cancelPending() { for (const controller of controllers) controller.abort(); }
    function read(strictValues) {
      let raw;
      try { raw = storage.getItem(key); }
      catch (cause) { throw failure("READ_FAILED", "端末の保存内容を読み取れません。入力内容を残して保存を停止しました", "read", "not-written", cause); }
      try { return { raw, records: transfer.readSnapshot(raw, { strictValues }).records }; }
      catch (cause) { throw failure("INVALID_STORAGE", "保存データの形式を確認できません。既存記録は変更していません", "validate", "not-written", cause); }
    }
    async function locked(operation, { signal, onWaiting, onAcquired } = {}) {
      if (!supported()) throw failure("LOCK_UNAVAILABLE", "この接続では安全な保存機能を利用できません。HTTPSのテスト用URLを開いてください", "lock");
      const controller = new AbortController(), deadline = Date.now() + timeoutMs;
      let timedOut = false, acquired = false;
      const abort = () => controller.abort();
      controllers.add(controller);
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const timer = timers.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        onWaiting?.();
        return await locks.request(LOCK_NAME, { mode: "exclusive", signal: controller.signal }, () => {
          // An expired/aborted queue entry must never turn into a delayed write.
          if (controller.signal.aborted || Date.now() >= deadline) {
            timedOut ||= Date.now() >= deadline;
            throw failure(timedOut ? "LOCK_TIMEOUT" : "ABORTED", "保存待ちを中止しました。入力はこの画面に残っています", "lock");
          }
          acquired = true; timers.clearTimeout(timer); onAcquired?.();
          // Single-key read/build/check/write/read-back is synchronous inside the lock.
          return operation();
        });
      } catch (cause) {
        if (cause?.code && cause?.phase) throw cause;
        if (!acquired && (controller.signal.aborted || cause?.name === "AbortError")) {
          throw failure(timedOut ? "LOCK_TIMEOUT" : "ABORTED", timedOut ? "保存の順番待ちが長いため中止しました。入力を残しています。再試行してください" : "保存待ちを中止しました。入力はこの画面に残っています", "lock", "not-written", cause);
        }
        throw failure("LOCK_FAILED", "安全な保存処理を完了できませんでした。入力内容を残しています", acquired ? "operation" : "lock", acquired ? "unknown" : "not-written", cause);
      } finally {
        timers.clearTimeout(timer); controllers.delete(controller); signal?.removeEventListener("abort", abort);
      }
    }
    function persist(snapshot, records, strictValues) {
      try { transfer.validateRecordsMap(records, { strictValues }); }
      catch (cause) { throw failure("INVALID_CANDIDATE", "保存候補の形式を確認できません。入力を保持して停止しました", "validate", "not-written", cause); }
      const raw = JSON.stringify(records);
      let latest;
      try { latest = storage.getItem(key); }
      catch (cause) { throw failure("READ_FAILED", "保存直前の記録を確認できません。入力を保持して停止しました", "check", "not-written", cause); }
      if (latest !== snapshot.raw) throw failure("STALE", "別の画面で記録が変わりました。入力内容を残して保存を停止しました", "check");
      try { storage.setItem(key, raw); }
      catch (cause) { throw failure("WRITE_FAILED", "保存できませんでした。入力内容はこの画面に残っています。空き容量・保存権限を確認して再試行してください", "write", "not-written", cause); }
      try {
        const savedRaw = storage.getItem(key);
        const saved = transfer.readSnapshot(savedRaw, { strictValues }).records;
        if (Object.keys(saved).length !== Object.keys(records).length || stable(saved) !== stable(records)) throw new Error("mismatch");
        return { records: clone(saved), raw: savedRaw, outcome: "verified" };
      } catch (cause) {
        throw failure("VERIFY_FAILED", "保存後の照合に失敗しました。記録が変更済みの可能性があります。自動再保存せず、入力を控え、保存済み記録を確認してください", "verify", "unknown", cause);
      }
    }
    async function saveDay(getRequest, options) {
      return locked(() => {
        const request = getRequest();
        const { date, entry, expected, generation } = request;
        try { transfer.validateRecordsMap({ [date]: entry }); }
        catch (cause) { throw failure("INVALID_ENTRY", "入力値の型・日付・範囲を確認してください。記録は変更していません", "validate", "not-written", cause); }
        const snapshot = read(false);
        const actual = own(snapshot.records, date) ? snapshot.records[date] : undefined;
        // Different dates can safely coexist; a changed day requires explicit review.
        if (stable(actual) !== stable(expected)) throw failure("STALE", "別の画面で同じ日付の記録が変わりました。入力を残して停止しました。入力を控え、保存済み記録を確認してください", "compare");
        const records = clone(snapshot.records);
        records[date] = clone(entry);
        return { ...persist(snapshot, records, false), date, generation };
      }, options);
    }
    async function commitImport(plan, choices, confirmation, options) {
      // Freeze the user's confirmed choices before waiting; never apply later UI edits.
      if (confirmation?.backupConfirmed !== true || confirmation?.finalConfirmed !== true) {
        throw failure("CONFIRMATION", "復元前バックアップと最終確認が必要です", "confirmation");
      }
      const frozenPlan = clone(plan), frozenChoices = clone(choices || {});
      const evaluationChoices = clone(confirmation.evaluationChoices || {});
      return locked(() => {
        const snapshot = read(true);
        if (snapshot.raw !== frozenPlan.baselineRaw) throw failure("STALE", "現在の記録が変更されました。ファイルを選び直して再検証してください", "compare");
        let candidate;
        try { candidate = transfer.buildCandidate(frozenPlan, frozenChoices); }
        catch (cause) { throw failure("INVALID_CANDIDATE", "取り込み候補の形式を確認できません。保存を停止しました", "validate", "not-written", cause); }
        if (frozenPlan.evaluations) {
          const aiSnapshot = readAI();
          if (aiSnapshot.raw !== frozenPlan.evaluations.baselineRaw) throw failure("STALE", "AI評価が変更されました。ファイルを選び直して再検証してください", "compare");
          const aiCandidate = transfer.buildEvaluationCandidate(frozenPlan.evaluations, evaluationChoices);
          const result = persistPair(snapshot, candidate, aiSnapshot, aiCandidate);
          return { ...result, counts: candidate.counts, evaluationCounts: aiCandidate.counts };
        }
        if (!candidate.counts.added && !candidate.counts.replaced) return { ...candidate, raw: snapshot.raw, outcome: "verified" };
        return { ...persist(snapshot, candidate.records, true), counts: candidate.counts };
      }, options);
    }
    function readAI() {
      try { const raw = storage.getItem(transfer.AI_KEY); return { raw, records: transfer.readEvaluations(raw) }; }
      catch (cause) { throw failure("INVALID_AI_STORAGE", "保存済みAI評価を読み取れません。初期化せず停止しました", "read", "not-written", cause); }
    }
    function persistPair(snapshot, candidate, aiSnapshot, aiCandidate) {
      transfer.validateRecordsMap(candidate.records, { strictValues: true }); transfer.validateEvaluations(aiCandidate.records);
      const maps = [
        { key, before: snapshot.raw, after: JSON.stringify(candidate.records), changed: candidate.counts.added + candidate.counts.replaced },
        { key: transfer.AI_KEY, before: aiSnapshot.raw, after: JSON.stringify(aiCandidate.records), changed: aiCandidate.counts.added + aiCandidate.counts.replaced }
      ];
      if (maps.some(item => storage.getItem(item.key) !== item.before)) throw failure("STALE", "保存内容が変わりました。再検証してください", "check");
      const attempted = [];
      try {
        for (const item of maps.filter(item => item.changed)) { attempted.push(item); storage.setItem(item.key, item.after); }
        for (const item of maps) if (storage.getItem(item.key) !== (item.changed ? item.after : item.before)) throw new Error("readback mismatch");
      } catch (cause) {
        try {
          let rollbackError;
          for (const item of attempted.reverse()) {
            try {
              const current = storage.getItem(item.key);
              if (current === item.before) continue;
              if (current !== item.after) throw new Error("保存中に別の変更が検出されました");
              if (item.before === null) storage.removeItem(item.key); else storage.setItem(item.key, item.before);
            } catch (error) { rollbackError = error; }
          }
          if (rollbackError) throw rollbackError;
          if (maps.some(item => storage.getItem(item.key) !== item.before)) throw new Error("rollback mismatch");
        } catch (rollbackError) { throw failure("VERIFY_FAILED", "復元結果を確認できません。自動再実行せず、事前バックアップを保管し保存内容を確認してください", "verify", "unknown", rollbackError); }
        throw failure("RESTORE_FAILED", "復元に失敗し、保存内容を変更前へ戻しました。再検証してください", "write", "not-written", cause);
      }
      return { records: clone(candidate.records), raw: candidate.counts.added + candidate.counts.replaced ? maps[0].after : snapshot.raw, outcome: "verified" };
    }
    async function commitEvaluations(plan, choices, confirmation, options) {
      if (confirmation?.finalConfirmed !== true) throw failure("CONFIRMATION", "AI評価の保存内容を確認してください", "confirmation");
      const frozenPlan = clone(plan), frozenChoices = clone(choices || {}), overwrite = confirmation.overwriteConfirmed === true;
      return locked(() => {
        const snapshot = readAI();
        if (snapshot.raw !== frozenPlan.baselineRaw) throw failure("STALE", "AI評価が変更されました。再度プレビューしてください", "compare");
        const candidate = transfer.buildEvaluationCandidate(frozenPlan, frozenChoices);
        if (candidate.counts.replaced && !overwrite) throw failure("CONFIRMATION", "上書き対象の週と内容を確認してください", "confirmation");
        if (!candidate.counts.added && !candidate.counts.replaced) return { ...candidate, outcome: "verified" };
        if (storage.getItem(transfer.AI_KEY) !== snapshot.raw) throw failure("STALE", "AI評価が変更されました。再検証してください", "check");
        const raw = JSON.stringify(candidate.records);
        try { storage.setItem(transfer.AI_KEY, raw); }
        catch (cause) { throw failure("WRITE_FAILED", "AI評価を保存できませんでした。既存評価は変更していません", "write", "not-written", cause); }
        try { if (storage.getItem(transfer.AI_KEY) !== raw) throw new Error("mismatch"); transfer.readEvaluations(raw); }
        catch (cause) { throw failure("VERIFY_FAILED", "AI評価の保存結果を確認できません。自動再実行せず、保存内容を確認してください", "verify", "unknown", cause); }
        return { ...candidate, outcome: "verified" };
      }, options);
    }
    async function deleteDay({ date, expectedRaw, confirmed }, options) {
      if (confirmed !== true) throw failure("CONFIRMATION", "対象日付の削除確認が必要です", "confirmation");
      try {
        transfer.validateRecordsMap({ [date]: {} });
        if (typeof expectedRaw !== "string") throw new Error("missing snapshot");
      } catch (cause) { throw failure("INVALID_ENTRY", "削除対象の日付・保存内容を確認できません", "validate", "not-written", cause); }
      return locked(() => {
        const snapshot = read(false);
        if (snapshot.raw !== expectedRaw) throw failure("STALE", "確認中に保存内容が変わりました。最新の詳細を確認してから、削除をやり直してください", "compare");
        if (!own(snapshot.records, date)) throw failure("NOT_FOUND", "この日付には保存済み記録がありません", "compare");
        const entry = snapshot.records[date];
        try {
          transfer.validateRecordsMap({ [date]: entry }, { strictValues: true });
          if (!Object.keys(transfer.DEFAULT_ENTRY).every(field => own(entry, field))) throw new Error("incomplete record");
        } catch (cause) { throw failure("INVALID_ENTRY", "欠落・不正値のある記録は削除できません。保存内容を確認してください", "validate", "not-written", cause); }
        const records = clone(snapshot.records);
        delete records[date];
        return { ...persist(snapshot, records, false), date };
      }, options);
    }
    return Object.freeze({ key, storage, supported, saveDay, commitImport, commitEvaluations, deleteDay, cancelPending });
  }
  return Object.freeze({ KEY, LOCK_NAME, createStore });
});
