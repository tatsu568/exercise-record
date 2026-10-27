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
    return Object.freeze({ register, show, current: () => active });
  }
  return Object.freeze({ mount });
});
