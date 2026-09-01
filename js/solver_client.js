/**
 * PDP Solver Client — loads OR-Tools WASM in the browser.
 * The actual solver lives in dist/solver.js (built by Vite from solver-entry.js).
 * This file is a thin shim that checks for the WASM module availability.
 *
 * Exposes window.PDP_SOLVER with:
 *   .ready  — Promise that resolves when WASM is loaded
 *   .solve(params) → {ok, routes, solve_time_ms, objective_value, status}
 *   .isReady() → boolean
 *   .check(cb)  — legacy compat: cb(true) when ready, cb(false) otherwise
 */
(function (global) {
  "use strict";

  // The WASM module (solver-entry.js) sets window.PDP_SOLVER directly.
  // This shim only adds the legacy .check() interface for ui.js detectSolver().

  var _pollTimer = null;

  function waitForReady(cb, timeout) {
    timeout = timeout || 15000;
    var start = Date.now();
    function tick() {
      if (global.PDP_SOLVER && global.PDP_SOLVER.isReady && global.PDP_SOLVER.isReady()) {
        cb(true);
        return;
      }
      if (Date.now() - start > timeout) {
        cb(false);
        return;
      }
      _pollTimer = setTimeout(tick, 200);
    }
    tick();
  }

  // If solver-entry.js already loaded PDP_SOLVER, just use it.
  // If not (solver.js not loaded yet), wait for it.
  if (!global.PDP_SOLVER) {
    global.PDP_SOLVER = {
      ready: Promise.reject(new Error("solver.js not loaded")),
      solve: function (params, cb) {
        cb(new Error("OR-Tools WASM not loaded. Add <script src=\"dist/solver.js\"> to index.html."), null);
      },
      isReady: function () { return false; },
      check: function (cb) { waitForReady(cb); },
    };
  }

  // Add legacy .check() if not already present (from solver-entry.js)
  if (!global.PDP_SOLVER.check) {
    global.PDP_SOLVER.check = function (cb) {
      if (global.PDP_SOLVER.isReady()) { cb(true); return; }
      waitForReady(cb);
    };
  }

})(window);
