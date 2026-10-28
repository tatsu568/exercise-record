(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.AppNavigation = api;
    root.RecordAppNavigation = api.mount({ document, input: window.RecordHistoryInput });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Match input-screen gestures, leaving vertical scrolling and controls native.
  function connectPeriodSwipe({ element, window, enabled, move, width }) {
    let start = null;
    element.addEventListener("touchstart", (event) => {
      start = null;
      if (!enabled() || element.hidden || event.touches.length !== 1
        || event.target?.closest?.("input, button, select, textarea, label, a, summary, [role=button], [contenteditable], .graph-plot, .graph-selected")) return;
      const touch = event.touches[0], viewport = window.innerWidth || width();
      if (touch.clientX < 24 || touch.clientX > viewport - 24) return;
      start = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    element.addEventListener("touchmove", (event) => {
      if (!start) return;
      if (event.touches.length !== 1) { start = null; return; }
      const dx = Math.abs(event.touches[0].clientX - start.x), dy = Math.abs(event.touches[0].clientY - start.y);
      if (dy > 40 || (dy > 18 && dy > dx)) start = null;
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      const from = start; start = null;
      if (!from || !enabled() || element.hidden || event.changedTouches.length !== 1 || event.touches?.length) return;
      const dx = event.changedTouches[0].clientX - from.x, dy = event.changedTouches[0].clientY - from.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 2) move(dx > 0 ? -1 : 1);
    }, { passive: true });
    element.addEventListener("touchcancel", () => { start = null; }, { passive: true });
  }

  function mount({ document, input }) {
    const views = new Map();
    let active = "input";
    const get = (id) => document.querySelector(`#${id}`);

    // Independent screens can register without adding a main tab.
    function register(name, options = {}) {
      const previous = views.get(name);
      const view = { screen: `${name}-screen`, tab: `${name}-show`, ...previous, ...options };
      views.set(name, view);
      get(view.screen).hidden = name !== active;
      if (!previous && view.tab) get(view.tab).addEventListener("click", () => show(name));
    }

    function show(name) {
      const next = views.get(name);
      if (!next) return false;
      if (name === active) { next.onShow?.({ reenter: true }); return true; }
      const blocked = input.canBrowse() || views.get(active)?.canLeave?.({ destination: name });
      if (blocked) { input.notify(blocked); return false; }
      views.get(active)?.onHide?.();
      // Establish the save guard before blur/hide can trigger input events.
      input.setBrowsing(name !== "input");
      document.activeElement?.blur();
      const from = active;
      active = name;
      for (const [id, view] of views) {
        get(view.screen).hidden = id !== active;
        if (view.tab) get(view.tab).setAttribute("aria-pressed", String(id === active));
      }
      next.onShow?.({ reenter: false, from });
      if (next.heading) get(next.heading).focus({ preventScroll: true });
      return true;
    }

    for (const name of ["input", "history", "graph"]) register(name);
    return Object.freeze({ register, show, current: () => active,
      connectPeriodSwipe: (options) => connectPeriodSwipe({ ...options, width: () => document.documentElement?.clientWidth || 0 }) });
  }
  return Object.freeze({ mount });
});
