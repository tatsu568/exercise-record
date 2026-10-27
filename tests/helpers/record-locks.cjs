"use strict";
// In-memory Web Locks double. No browser profile or real storage is used.
function createLocks() {
  const queues = new Map(), held = new Set();
  function pump(name) {
    const queue = queues.get(name) || [];
    if (held.has(name) || !queue.length) return;
    const job = queue.shift();
    job.signal?.removeEventListener("abort", job.abort);
    held.add(name);
    Promise.resolve().then(() => job.callback({ name, mode: "exclusive" })).then(
      value => { held.delete(name); pump(name); job.resolve(value); },
      error => { held.delete(name); pump(name); job.reject(error); }
    );
  }
  return {
    request(name, { signal, mode }, callback) {
      if (mode !== "exclusive") return Promise.reject(new Error("exclusive required"));
      return new Promise((resolve, reject) => {
        const job = { signal, callback, resolve, reject };
        const queue = queues.get(name) || []; queues.set(name, queue);
        job.abort = () => { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
        if (signal?.aborted) { job.abort(); return; }
        signal?.addEventListener("abort", job.abort, { once: true });
        queue.push(job); pump(name);
      });
    },
    state: () => ({ held: held.size, pending: [...queues.values()].reduce((sum, jobs) => sum + jobs.length, 0) })
  };
}
module.exports = { createLocks };
