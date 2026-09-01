/**
 * PDP Solver Client — talks to the local OR-Tools server.
 * Falls back to client-side heuristic if server is unreachable.
 */
(function (global) {
  "use strict";
  var SOLVER_URL = "http://127.0.0.1:8766";

  function checkServer(cb) {
    fetch(SOLVER_URL + "/health", { signal: AbortSignal.timeout(2000) })
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(d.ok === true); })
      .catch(function () { cb(false); });
  }

  function solve(params, cb) {
    fetch(SOLVER_URL + "/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(null, d); })
      .catch(function (err) { cb(err, null); });
  }

  global.PDP_SOLVER = { check: checkServer, solve: solve, url: SOLVER_URL };
})(window);
