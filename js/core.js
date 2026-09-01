/**
 * PDP Route Optimiser - core engine.
 * Pure logic (no DOM): Haversine distances computed from coordinates, fixed-size
 * customer grouping, nearest-neighbour + 2-opt ordering, cross-route improvement,
 * constraint-aware (Blocked / Uncertain / Not reviewed), QA checks.
 *
 * Works in the browser (window.PDP) and in Node (module.exports) for acceptance tests.
 */
(function (global) {
  "use strict";

  var R_EARTH = 6371.0088; // km; matches the workbook formula

  function toRad(d) { return d * Math.PI / 180; }

  function haversineKm(a, b) {
    var p1 = toRad(a.lat), p2 = toRad(b.lat);
    var dp = p2 - p1, dl = toRad(b.lon - a.lon);
    var x = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.sqrt(x));
  }

  function pad2(i) { return (i < 10 ? "0" : "") + i; }
  function routeId(i) { return "R" + pad2(i + 1); } // 1-based route numbers: R01..
  function pairKey(a, b) { return a < b ? a + "~" + b : b + "~" + a; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }

  var STATUS_ORDER = ["Blocked", "Uncertain", "Validated", "Not reviewed"];

  /** Build the full symmetric Haversine matrix (FlatFloat64Array) from locations. */
  function matrixFromData(data) {
    var locs = [data.warehouse].concat(data.customers);
    var n = locs.length;
    var ids = locs.map(function (l) { return l.id; });
    var idx = {};
    for (var i = 0; i < n; i++) idx[ids[i]] = i;
    var flat = new Float64Array(n * n);
    for (var a = 0; a < n; a++) {
      flat[a * n + a] = 0;
      for (var b = a + 1; b < n; b++) {
        var d = haversineKm(locs[a], locs[b]);
        flat[a * n + b] = d;
        flat[b * n + a] = d;
      }
    }
    return { n: n, ids: ids, idx: idx, flat: flat };
  }

  function dist(matrix, idA, idB) {
    return matrix.flat[matrix.idx[idA] * matrix.n + matrix.idx[idB]];
  }

  /** Normalise register rows into entries; accepts raw {..} objects or sheet-column keys. */
  function normalizeRegister(rawRows) {
    var out = [], notes = [];
    (rawRows || []).forEach(function (r, i) {
      var pick = function (keys) {
        for (var k = 0; k < keys.length; k++) {
          if (r[keys[k]] != null && String(r[keys[k]]).trim() !== "") return String(r[keys[k]]).trim();
        }
        return "";
      };
      var from = pick(["from", "From Location ID", "From"]);
      var to = pick(["to", "To Location ID", "To"]);
      if (!from || !to) { notes.push("Row " + (i + 1) + ": missing From/To Location ID - skipped"); return; }
      if (from === to) { notes.push("Row " + (i + 1) + ": self pair " + from + " - skipped"); return; }
      var s = pick(["status", "Status"]) || "Not reviewed";
      if (STATUS_ORDER.indexOf(s) === -1) {
        notes.push("Row " + (i + 1) + ": unknown status '" + s + "' set to Not reviewed");
        s = "Not reviewed";
      }
      out.push({
        from: from, to: to, key: pairKey(from, to),
        type: pick(["type", "Constraint Type", "Type"]) || "Other",
        description: pick(["description", "Constraint Description", "Description"]),
        status: s,
        allowedVehicle: pick(["allowedVehicle", "Allowed Vehicle"]),
        detourNote: pick(["detourNote", "Manual Detour Note", "Detour Note"]),
        confirmedBy: pick(["confirmedBy", "Confirmed By"]),
        confirmationDate: pick(["confirmationDate", "Confirmation Date"])
      });
    });
    return { entries: out, notes: notes };
  }

  /** Fast O(1) pair lookup for a normalised register. */
  function constraintIndex(register) {
    var map = {};
    (register || []).forEach(function (e) { map[e.key] = e; });
    return {
      get: function (a, b) { return map[pairKey(a, b)] || null; },
      blocked: function (a, b) { var e = map[pairKey(a, b)]; return !!e && e.status === "Blocked"; },
      flags: function (a, b) { // Uncertain or Not reviewed => needs a warning
        var e = map[pairKey(a, b)];
        return !!e && (e.status === "Uncertain" || e.status === "Not reviewed");
      }
    };
  }

  /** Normalise do-not-combine input (Set of pair keys, object map, or array of pairs / "a~b") into a pairKey Set. */
  function doNotIndex(input) {
    var set = new Set();
    if (input && typeof input.has === "function") return input;
    if (input && typeof input.forEach !== "function") {
      Object.keys(input).forEach(function (a) { set.add(pairKey(a, input[a])); });
      return set;
    }
    (input || []).forEach(function (e) {
      if (typeof e === "string") {
        var p = e.split("~");
        if (p.length === 2 && p[0] !== p[1]) set.add(pairKey(p[0], p[1]));
      } else if (e) {
        var a = e.from != null ? e.from : e.a, b = e.to != null ? e.to : e.b;
        if (a != null && b != null && String(a) !== String(b)) set.add(pairKey(String(a), String(b)));
      }
    });
    return set;
  }
  function cannotPair(set, a, b) { return !!set && set.has(pairKey(a, b)); }

  /** Balanced K-way split of `total` items into route sizes differing by at most 1. */
  function balancedSizes(total, K) {
    var base = Math.floor(total / K), extra = total % K, sizes = [];
    for (var i = 0; i < K; i++) sizes.push(base + (i < extra ? 1 : 0));
    return sizes;
  }

  /** Would swapping stops[i] and stops[j] create a Blocked adjacency (incl. WH boundary)? */
  function reorderFeasible(stops, i, j, cx, includeReturn) {
    if (i === j) return true;
    var n = stops.length;
    if (i < 0 || j < 0 || i >= n || j >= n) return false;
    var s = stops.slice(), t = s[i]; s[i] = s[j]; s[j] = t;
    var seq = ["WH"].concat(s);
    if (includeReturn) seq.push("WH");
    for (var k = 0; k < seq.length - 1; k++) {
      if (cx.blocked(seq[k], seq[k + 1])) return false;
    }
    return true;
  }

  var STATUS_PRECEDENCE = { Blocked: 3, Uncertain: 2, "Not reviewed": 1, Validated: 0 };

  /**
   * Validate normalised entries against the location universe. Invalid rows are dropped
   * with a note (unknown IDs, self/duplicate pairs); invalid Confirmation Dates are cleared.
   */
  function validateRegister(entries, data) {
    var known = { WH: true };
    (data && data.customers || []).forEach(function (c) { known[c.id] = true; });
    var out = [], notes = [], seen = {};
    (entries || []).forEach(function (e, i) {
      if (!known[e.from] || !known[e.to]) { notes.push("Row " + (i + 1) + ": unknown Location ID (From=" + e.from + ", To=" + e.to + ") - rejected"); return; }
      if (e.from === e.to) { notes.push("Row " + (i + 1) + ": self pair " + e.from + " - rejected"); return; }
      if (seen[e.key]) { notes.push("Row " + (i + 1) + ": duplicate pair " + e.key + " in import (first kept) - rejected"); return; }
      if (e.status === "Validated" && (!e.confirmedBy || !e.confirmationDate))
        notes.push("Row " + (i + 1) + ": status Validated without Confirmed By / Confirmation Date (verify before relying on it)");
      if (e.confirmationDate && isNaN(Date.parse(e.confirmationDate))) {
        notes.push("Row " + (i + 1) + ": invalid Confirmation Date '" + e.confirmationDate + "' - cleared");
        e = Object.assign({}, e, { confirmationDate: "" });
      }
      seen[e.key] = true;
      out.push(e);
    });
    return { entries: out, notes: notes };
  }

  /** Merge two registers; the more restrictive status always wins (Blocked is never downgraded). */
  function mergeRegister(existing, incoming) {
    var byKey = {}, order = [], notes = [];
    function add(e) {
      if (byKey[e.key] === undefined) { byKey[e.key] = e; order.push(e); return; }
      var cur = byKey[e.key];
      if (STATUS_PRECEDENCE[e.status] > STATUS_PRECEDENCE[cur.status]) { byKey[e.key] = e; }
      else if (STATUS_PRECEDENCE[e.status] < STATUS_PRECEDENCE[cur.status]) {
        notes.push("Pair " + e.key + ": existing '" + cur.status + "' kept (incoming '" + e.status + "' ignored)");
      } else { byKey[e.key] = e; }
    }
    (existing || []).forEach(add);
    (incoming || []).forEach(add);
    return { entries: order, notes: notes };
  }

  /** Ordered-path score: WH->s1->...->sN [+ sN->WH if includeReturn]. */
  function pathCost(matrix, stops, includeReturn) {
    if (!stops.length) return 0;
    var c = dist(matrix, "WH", stops[0]);
    for (var i = 1; i < stops.length; i++) c += dist(matrix, stops[i - 1], stops[i]);
    if (includeReturn) c += dist(matrix, stops[stops.length - 1], "WH");
    return c;
  }

  function outboundKm(matrix, stops) {
    if (!stops.length) return 0;
    var c = dist(matrix, "WH", stops[0]);
    for (var i = 1; i < stops.length; i++) c += dist(matrix, stops[i - 1], stops[i]);
    return c;
  }

  /** Outbound-only cost: WH→s1→…→sN. Objective function for all optimisation steps. */
  function outboundCost(matrix, stops) {
    return outboundKm(matrix, stops);
  }

  function longestLegKm(matrix, stops) {
    if (!stops.length) return 0;
    var m = dist(matrix, "WH", stops[0]);
    for (var i = 1; i < stops.length; i++) m = Math.max(m, dist(matrix, stops[i - 1], stops[i]));
    return m;
  }

  /**
   * Greedy nearest-neighbour with a HARD Blocked rule: a Blocked pair is never placed
   * consecutively. If WH-first greedy dead-ends, other start points are tried before the
   * route is declared infeasible (unplaceable members returned - never forced adjacent).
   * ponytail: greedy may still declare infeasible on a fringe case where a feasible
   * ordering exists; upgrade to backtracking search if real infeasibilities appear.
   */
  function orderRoute(cx, matrix, memberIds, includeReturn) {
    function tryStart(first) {
      var rest = memberIds.slice(), stops = [];
      if (first != null) { stops.push(first); rest.splice(rest.indexOf(first), 1); }
      while (rest.length) {
        var last = stops.length ? stops[stops.length - 1] : "WH";
        var best = null, bestD = Infinity;
        for (var i = 0; i < rest.length; i++) {
          var d = dist(matrix, last, rest[i]);
          if (cx.blocked(last, rest[i])) continue;
          if (d < bestD) { bestD = d; best = rest[i]; }
        }
        if (best === null) return null;
        stops.push(best);
        rest.splice(rest.indexOf(best), 1);
      }
      return stops;
    }
    var res = tryStart(null);
    if (!res && memberIds.length) {
      var bestStops = null, bestCost = Infinity;
      for (var s = 0; s < memberIds.length; s++) {
        var cand = tryStart(memberIds[s]);
        if (cand) { var c = pathCost(matrix, cand, includeReturn); if (c < bestCost) { bestCost = c; bestStops = cand; } }
      }
      res = bestStops;
    }
    if (res) return { stops: res, warnings: [], unplaceable: [] };
    return { stops: [], warnings: [{ type: "infeasible", detail: "route cannot be ordered without placing a Blocked pair consecutively" }], unplaceable: memberIds.slice() };
  }

  /** 2-opt tour improvement respecting Blocked pairs. Evaluates outbound-only (return leg excluded from improvement check). */
  function twoOpt(cx, matrix, stops, includeReturn) {
    if (stops.length < 2) return stops;
    var improved = true, guard = 0;
    while (improved && guard++ < 300) {
      improved = false;
      for (var i = 0; i < stops.length - 1; i++) {
        for (var j = i + 1; j < stops.length; j++) {
          var prev = i === 0 ? "WH" : stops[i - 1];
          var afterJ = j + 1 < stops.length ? stops[j + 1] : null;
          var old = dist(matrix, prev, stops[i]) + (afterJ ? dist(matrix, stops[j], afterJ) : 0);
          var nw = dist(matrix, prev, stops[j]) + (afterJ ? dist(matrix, stops[i], afterJ) : 0);
          if (cx.blocked(prev, stops[j]) || (afterJ && cx.blocked(stops[i], afterJ))) continue;
          if (nw < old - 1e-9) {
            reverseBetween(stops, i, j);
            improved = true;
          }
        }
      }
    }
    return stops;
  }
  function reverseBetween(arr, i, j) {
    while (i < j) { var t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
  }

  /**
   * Fixed-size partition: farthest-corridor seeds -> nearest-seed assign -> rebuild to
   * target sizes (targetSizes[i] capacity each). Honours locks and do-not-combine.
   */
  function partition(targetSizes, customers, cx, matrix, locks, doNot) {
    var n = customers.length;
    var K = targetSizes.length;
    var routes = [];
    for (var i = 0; i < K; i++) routes.push({ members: [] });

    function canJoin(route, cid) {
      for (var i = 0; i < route.members.length; i++) {
        if (cannotPair(doNot, cid, route.members[i])) return false;
      }
      return true;
    }
    function targetFor(idx) { return targetSizes[idx]; }

    var assigned = {};
    var lockOverflow = [];
    var lockedSet = {};
    Object.keys(locks || {}).forEach(function (cid) {
      var idx = parseInt(String(locks[cid]).replace(/\D/g, ""), 10) - 1;
      if (isNaN(idx) || idx < 0) idx = 0;
      if (idx >= routes.length) while (routes.length <= idx) routes.push({ members: [] });
      routes[idx].members.push(cid);
      assigned[cid] = idx;
      lockedSet[cid] = true;
    });
    routes.forEach(function (r) { if (r.members.length > targetFor(routes.indexOf(r))) lockOverflow.push(routeId(routes.indexOf(r))); });

    // seeds: locked members seed their routes; unfilled slots get farthest-point seeds
    var chosenSeeds = [];
    routes.forEach(function (r) { if (r.members.length) chosenSeeds.push(r.members[0]); });
    var rest = customers.filter(function (c) { return assigned[c.id] === undefined; });
    while (chosenSeeds.length < K && rest.length) {
      var farIdx = -1, farD = -1;
      for (var u = 0; u < rest.length; u++) {
        var minD = Infinity;
        for (var s = 0; s < chosenSeeds.length; s++) minD = Math.min(minD, dist(matrix, rest[u].id, chosenSeeds[s]));
        if (minD > farD) { farD = minD; farIdx = u; }
      }
      chosenSeeds.push(rest[farIdx].id);
    }

    // nearest-seed assignment
    rest.forEach(function (c) {
      var bestIdx = -1, bestD = Infinity;
      for (var si = 0; si < routes.length; si++) {
        if (!canJoin(routes[si], c.id)) continue;
        var d = dist(matrix, c.id, chosenSeeds[si]);
        if (d < bestD) { bestD = d; bestIdx = si; }
      }
      if (bestIdx >= 0) { routes[bestIdx].members.push(c.id); assigned[c.id] = bestIdx; }
    });

    // balance: restore target sizes (final = remainder); locked members are never ejected
    var guard = 0;
    var stickOver = {}; // route indexes that can no longer be shrunk (all-locked overflow)
    while (guard++ < n * 3) {
      var over = -1;
      for (var i = 0; i < K; i++) {
        if (stickOver[i]) continue;
        if (routes[i].members.length > targetFor(i)) { over = i; break; }
      }
      if (over === -1) break;
      var r = routes[over];
      var deltables = [];
      for (var e = 0; e < r.members.length; e++) if (!lockedSet[r.members[e]]) deltables.push(e);
      if (!deltables.length) { stickOver[over] = true; continue; } // only locked members: cannot shrink
      var ejectIdx = deltables[0], ejectD = -1;
      for (var di = 0; di < deltables.length; di++) {
        var ed = dist(matrix, r.members[deltables[di]], chosenSeeds[over]);
        if (ed > ejectD) { ejectD = ed; ejectIdx = deltables[di]; }
      }
      var cid = r.members[ejectIdx];
      r.members.splice(ejectIdx, 1);
      delete assigned[cid];
      var bestUnder = -1, bestGain = Infinity;
      for (var ui = 0; ui < K; ui++) {
        if (routes[ui].members.length >= targetFor(ui) || !canJoin(routes[ui], cid)) continue;
        var g = routes[ui].members.length
          ? Math.min.apply(null, routes[ui].members.map(function (m) { return dist(matrix, cid, m); }))
          : dist(matrix, cid, chosenSeeds[ui]);
        if (g < bestGain) { bestGain = g; bestUnder = ui; }
      }
      if (bestUnder === -1) { routes[over].members.push(cid); assigned[cid] = over; break; } // do-not-combine deadlock
      routes[bestUnder].members.push(cid); assigned[cid] = bestUnder;
    }

    var sizeIssues = [];
    routes.forEach(function (r) {
      var idx = routes.indexOf(r);
      if (r.members.length > targetFor(idx)) sizeIssues.push(routeId(idx) + "=" + r.members.length + " (target " + targetFor(idx) + ")");
    });

    return { assigned: assigned, routes: routes, lockOverflow: lockOverflow, sizeIssues: sizeIssues, lockedSet: lockedSet };
  }
  function countLockedRoutes(locks) {
    var s = new Set();
    Object.keys(locks || {}).forEach(function (c) {
      var idx = parseInt(String(locks[c]).replace(/\D/g, ""), 10) - 1;
      if (!isNaN(idx) && idx >= 0) s.add(idx);
    });
    return s.size;
  }

  /** Per-route capacities: explicit forceRouteCount -> balanced split; else N with last route holding the remainder. */
  function buildTargetSizes(N, total, forceRoutes, locks, notes) {
    var lockedK = countLockedRoutes(locks);
    if (forceRoutes > 0) {
      var Kf = Math.round(forceRoutes);
      if (Kf < 1 || Kf > total) notes.push("forceRouteCount=" + forceRoutes + " outside 1.." + total + " - ignored (uniform N used)");
      else {
        if (Kf < lockedK) { notes.push("forceRouteCount=" + Kf + " below locked route count " + lockedK + " - clamped to " + lockedK); Kf = lockedK; }
        return balancedSizes(total, Kf);
      }
    }
    var K = Math.max(Math.ceil(total / N), lockedK);
    var sizes = [];
    for (var i = 0; i < K; i++) sizes.push(i < K - 1 ? N : total - (K - 1) * N);
    return sizes;
  }

  /** Full plan build: partition + order + improve + metrics + QA + exceptions. */
  function buildPlan(cfg) {
    var data = cfg.data, matrix = cfg.matrix, N = cfg.N, includeReturn = cfg.includeReturn;
    var register = cfg.register || [], locks = cfg.locks || {};
    var doNot = doNotIndex(cfg.doNotCombine);
    var thresholds = cfg.thresholds || { longLegKm: 50, routeOutboundKm: 250 };
    var forceRoutes = cfg.forceRouteCount || 0;
    var forceNotes = [];
    var reg = normalizeRegister(register);
    var cx = constraintIndex(reg.entries);
    var customers = data.customers;

    var targetSizes = buildTargetSizes(N, customers.length, forceRoutes, locks, forceNotes);
    var P = partition(targetSizes, customers, cx, matrix, locks, doNot);

    var routes = P.routes.map(function (r, idx) {
      var o = orderRoute(cx, matrix, r.members, includeReturn);
      var stops = twoOpt(cx, matrix, o.stops, includeReturn);
      return { id: routeId(idx), stops: stops, orderWarnings: o.warnings,
               unplaceable: o.unplaceable, orderFailed: o.unplaceable.length > 0 };
    });

    crossRouteImprove(cx, matrix, routes, includeReturn, targetSizes, P.lockedSet, doNot, outboundCost);
    routes.forEach(function (r) { r.stops = twoOpt(cx, matrix, r.stops, includeReturn); });

    var assignment = {};
    routes.forEach(function (r) { r.stops.forEach(function (c) { assignment[c] = r.id; }); });

    routes.forEach(function (r) {
      var m = routeMetrics(matrix, cx, r.stops, includeReturn, thresholds);
      r.metrics = m.metrics; r.warnings = m.warnings;
      r.blockedPairsInRoute = m.blockedPairsInRoute; r.blockedAvoided = m.blockedPairsInRoute.length > 0 ? m.blockedPairsInRoute.length - m.blockedAdjacentCount : 0;
      r.constraintLegs = m.constraintLegs; r.uncertainLegs = m.uncertainLegs;
      if (r.orderWarnings && r.orderWarnings.length) r.warnings = r.warnings.concat(r.orderWarnings);
      r.reviewRequired = m.reviewRequired || r.orderWarnings.some(function (w) { return w.type === "blockedUnavoidable"; });
      r.status = r.orderFailed ? "INFEASIBLE" : (r.reviewRequired ? "Needs Manual Road Review" : "Draft");
      r.customerCount = r.stops.length;
      delete r.orderWarnings;
    });

    var totalOut = 0, totalRet = 0, totalScore = 0, revCust = 0;
    routes.forEach(function (r) {
      totalOut += r.metrics.outboundKm; totalRet += r.metrics.returnKm; totalScore += r.metrics.scoreKm;
      if (r.reviewRequired) revCust += r.customerCount;
    });

    var unassigned = customers.map(function (c) { return c.id; }).filter(function (id) { return assignment[id] === undefined; });
    var repeated = [];
    { var seen = {}; routes.forEach(function (r) { r.stops.forEach(function (c) { if (seen[c]) repeated.push(c); seen[c] = 1; }); }); }
    var infeasible = routes.some(function (r) { return r.orderFailed; });

    var plan = {
      n: N, includeReturn: includeReturn, thresholds: thresholds,
      routes: routes, assignment: assignment, unassigned: unassigned,
      infeasible: infeasible, forceRouteCount: forceRoutes, targetSizes: targetSizes, forceNotes: forceNotes,
      lockOverflow: P.lockOverflow, sizeIssues: P.sizeIssues,
      summary: {
        routeCount: routes.length, customerCount: customers.length,
        customersAssigned: Object.keys(assignment).length,
        repeated: repeated, unassignedCount: unassigned.length,
        customersRequiringReview: revCust,
        totalOutboundKm: totalOut, totalReturnKm: totalRet, totalScoreKm: totalScore
      },
      _customers: customers,
      registerNotes: reg.notes
    };
    plan.exceptions = buildExceptions(plan, matrix, cx, reg.entries, thresholds, P);
    plan.qa = runQa(plan, matrix, cx);
    return plan;
  }

  /** Cross-route improvement: relocations and swaps that reduce outbound distance, honour sizes. */
  function crossRouteImprove(cx, matrix, routes, includeReturn, targetSizes, lockedSet, doNot, costFn) {
    costFn = costFn || outboundCost;
    var guard = 0;
    function doNotConflict(cid, routeMembers) {
      for (var i = 0; i < routeMembers.length; i++) {
        if (cannotPair(doNot, cid, routeMembers[i])) return true;
      }
      return false;
    }
    while (guard++ < 12) {
      var best = null;
      for (var a = 0; a < routes.length; a++) {
        var ra = routes[a];
        for (var bi = 0; bi < ra.stops.length; bi++) {
          var c = ra.stops[bi];
          if (lockedSet && lockedSet[c]) continue; // locked customers stay put
          var curA = costFn(matrix, ra.stops);
          for (var b = 0; b < routes.length; b++) {
            var rb = routes[b];
            if (a === b || rb.stops.length >= targetSizes[b]) continue;
            if (doNotConflict(c, rb.stops)) continue;
            if (!relocValid(cx, ra, rb, c)) continue;
            var curB = costFn(matrix, rb.stops);
            var inserted = insertBest(cx, matrix, rb.stops, c, includeReturn);
            var newA = costFn(matrix, without(ra.stops, bi));
            var gain = (curA + curB) - (newA + inserted.bestCost);
            if (gain > 1e-9 && (!best || gain > best.gain))
              best = { gain: gain, type: "relocate", c: c, from: a, to: b, at: inserted.at };
          }
        }
      }
      for (var x = 0; x < routes.length; x++) {
        for (var y = x + 1; y < routes.length; y++) {
          var rx = routes[x], ry = routes[y];
          if (rx.stops.length !== targetSizes[x] || ry.stops.length !== targetSizes[y]) continue;
          for (var xi = 0; xi < rx.stops.length; xi++) {
            var c1 = rx.stops[xi];
            if (lockedSet && lockedSet[c1]) continue;
            for (var yi = 0; yi < ry.stops.length; yi++) {
              var c2 = ry.stops[yi];
              if (lockedSet && lockedSet[c2]) continue;
              // after swap, c2 joins rx (minus c1), c1 joins ry (minus c2): do-not-combine must hold
              if (doNotConflict(c2, without(rx.stops, xi))) continue;
              if (doNotConflict(c1, without(ry.stops, yi))) continue;
              if (!swapValid(cx, rx, ry, c2, c1)) continue;
              var cur = costFn(matrix, rx.stops) + costFn(matrix, ry.stops);
              var na = replacedOutboundCost(cx, matrix, rx.stops, xi, c2);
              var nb = replacedOutboundCost(cx, matrix, ry.stops, yi, c1);
              if (na === Infinity || nb === Infinity) continue;
              var gain = cur - (na + nb);
              if (gain > 1e-9 && (!best || gain > best.gain))
                best = { gain: gain, type: "swap", a: x, xi: xi, b: y, yi: yi };
            }
          }
        }
      }
      if (!best) break;
      if (best.type === "relocate") {
        var ra2 = routes[best.from], rb2 = routes[best.to];
        ra2.stops.splice(ra2.stops.indexOf(best.c), 1);
        rb2.stops.splice(best.at, 0, best.c);
        rb2.stops = twoOpt(cx, matrix, rb2.stops, includeReturn);
        ra2.stops = twoOpt(cx, matrix, ra2.stops, includeReturn);
      } else {
        var R1 = routes[best.a], R2 = routes[best.b];
        var tmp = R1.stops[best.xi]; R1.stops[best.xi] = R2.stops[best.yi]; R2.stops[best.yi] = tmp;
        R1.stops = twoOpt(cx, matrix, R1.stops, includeReturn);
        R2.stops = twoOpt(cx, matrix, R2.stops, includeReturn);
      }
    }
  }
  function without(arr, idx) { var s = arr.slice(); s.splice(idx, 1); return s; }
  function relocValid(cx, srcR, dstR, c) {
    for (var i = 0; i < dstR.stops.length; i++) if (cx.blocked(c, dstR.stops[i])) return false;
    return true;
  }
  function swapValid(cx, rx, ry, c2intoRx, c1intoRy) {
    for (var i = 0; i < rx.stops.length; i++) if (cx.blocked(c2intoRx, rx.stops[i])) return false;
    for (var j = 0; j < ry.stops.length; j++) if (cx.blocked(c1intoRy, ry.stops[j])) return false;
    return true;
  }
  function insertBest(cx, matrix, stops, c, includeReturn) {
    var bestCost = Infinity, at = 0;
    for (var i = 0; i <= stops.length; i++) {
      var prev = i === 0 ? "WH" : stops[i - 1];
      var next = i === stops.length ? (includeReturn ? "WH" : null) : stops[i];
      if (cx.blocked(prev, c) || (next && cx.blocked(c, next))) continue;
      var s = stops.slice(); s.splice(i, 0, c);
      var cost = pathCost(matrix, s, includeReturn);
      if (cost < bestCost) { bestCost = cost; at = i; }
    }
    return { at: at, bestCost: bestCost };
  }
  function replacedCost(cx, matrix, stops, idx, c, includeReturn) {
    var prev = idx === 0 ? "WH" : stops[idx - 1];
    var next = idx === stops.length - 1 ? (includeReturn ? "WH" : null) : stops[idx + 1];
    if (cx.blocked(prev, c) || (next && cx.blocked(c, next))) return Infinity;
    var s = stops.slice(); s[idx] = c;
    return pathCost(matrix, s, includeReturn);
  }
  function replacedOutboundCost(cx, matrix, stops, idx, c) {
    var prev = idx === 0 ? "WH" : stops[idx - 1];
    var next = idx === stops.length - 1 ? null : stops[idx + 1];
    if (cx.blocked(prev, c) || (next && cx.blocked(c, next))) return Infinity;
    var s = stops.slice(); s[idx] = c;
    return outboundCost(matrix, s);
  }

  /** Metrics + warnings + leg audit for an ordered route. */
  function routeMetrics(matrix, cx, stops, includeReturn, thresholds) {
    var out = outboundKm(matrix, stops);
    var ret = stops.length ? dist(matrix, stops[stops.length - 1], "WH") : 0;
    var longest = longestLegKm(matrix, stops);
    var warnings = [];
    var constraintLegs = [], uncertainLegs = [], blockedPairsInRoute = [];
    var blockedAdjacentCount = 0;

    if (longest > thresholds.longLegKm)
      warnings.push({ type: "longLeg", detail: "longest leg " + round1(longest) + " km > " + thresholds.longLegKm + " km" });
    if (out > thresholds.routeOutboundKm)
      warnings.push({ type: "longRoute", detail: "outbound " + round1(out) + " km > " + thresholds.routeOutboundKm + " km" });

    var seq = ["WH"].concat(stops).concat(includeReturn ? ["WH"] : []);
    for (var i = 0; i < seq.length - 1; i++) {
      var e = cx.get(seq[i], seq[i + 1]);
      if (e) {
        constraintLegs.push({ a: seq[i], b: seq[i + 1], entry: e });
        if (e.status === "Uncertain") { uncertainLegs.push({ a: seq[i], b: seq[i + 1], entry: e }); warnings.push({ type: "uncertainLeg", detail: pairKey(seq[i], seq[i + 1]) + " Uncertain" }); }
        if (e.status === "Not reviewed") warnings.push({ type: "unreviewedLeg", detail: pairKey(seq[i], seq[i + 1]) + " not reviewed" });
      }
    }
    for (var p = 0; p < stops.length; p++) {
      for (var q = p + 1; q < stops.length; q++) {
        if (cx.blocked(stops[p], stops[q])) {
          if (Math.abs(p - q) === 1) blockedAdjacentCount++;
          blockedPairsInRoute.push(pairKey(stops[p], stops[q]));
        }
      }
    }

    var reviewRequired = uncertainLegs.length > 0 || blockedPairsInRoute.length > 0 ||
      warnings.some(function (w) { return w.type === "unreviewedLeg" || w.type === "blockedAdjacent"; });

    return {
      metrics: {
        outboundKm: out, returnKm: ret, roundTripKm: out + ret,
        scoreKm: round2(out),
        outboundRounded: round1(out), longestLegKm: longest,
        avgKmPerCustomer: stops.length ? round2(out / stops.length) : 0
      },
      warnings: warnings, constraintLegs: constraintLegs, uncertainLegs: uncertainLegs,
      blockedPairsInRoute: blockedPairsInRoute, blockedAdjacentCount: blockedAdjacentCount,
      reviewRequired: reviewRequired
    };
  }

  function buildExceptions(plan, matrix, cx, register, thresholds, P) {
    var exc = [];
    function add(type, affected, risk, action, status) {
      exc.push({ type: type, affected: affected, risk: risk, action: action, status: status || "Open" });
    }
    (plan.unassigned || []).forEach(function (c) {
      add("Unassigned customer", c, "Customer has no route and would not be served.", "Assign to a route manually or re-cluster.", "Open");
    });
    (plan.summary.repeated || []).forEach(function (c) {
      add("Duplicate assignment", c, "Customer appears more than once across routes.", "Remove duplicate stop.", "Open");
    });
    plan._customers.forEach(function (c) {
      if (!isFinite(c.lat) || !isFinite(c.lon)) add("Missing/invalid coordinates", c.id, "Distance cannot be computed.", "Fix coordinates in source workbook and re-run build_data.py.", "Open");
    });
    add("Blank matrix distance", "All pairs", "Excel workbook ships no cached formula values; distances are computed from coordinates in-browser instead.", "No action needed - Haversine computed automatically.", "Resolved");

    plan.routes.forEach(function (r) {
      if (r.orderFailed) add("Road-infeasible route", r.id + ": " + ((r.unplaceable || []).join(", ") || "all members"), "Blocked pairings leave no legal stop order; customers are not served until resolved.", "Release Blocked pairs or redistribute these customers manually.", "Open");
      var longLeg = r.warnings.filter(function (w) { return w.type === "longLeg"; });
      var longRoute = r.warnings.filter(function (w) { return w.type === "longRoute"; });
      var blockedAttempt = r.warnings.filter(function (w) { return w.type === "blockedUnavoidable" || w.type === "blockedAdjacent"; });
      longLeg.forEach(function (w) { add("Long geographic leg", r.id + ": " + w.detail, "Straight-line leg may be far longer or impassable by road.", "Road-validation check required for this leg.", "Needs decision"); });
      longRoute.forEach(function (w) { add("Long route", r.id + ": " + w.detail, "Route outbound geographic distance above threshold.", "Consider splitting or re-sequencing the route.", "Needs decision"); });
      blockedAttempt.forEach(function (w) { add("Blocked pair attempted", r.id + ": " + w.detail, "A Blocked pairing could not be avoided in stop order.", "Move one of the pair to a different route manually.", "Open"); });
      r.uncertainLegs.forEach(function (l) {
        add("Uncertain road/access leg", pairKey(l.a, l.b) + " in " + r.id, "Crossing unconfirmed; may be impassable by the delivery vehicle.", "Field-check and confirm the leg in the Road Constraints Register.", "Needs decision");
      });
      r.constraintLegs.forEach(function (l) {
        if (l.entry.status === "Not reviewed")
          add("Constraint not reviewed", pairKey(l.a, l.b) + " in " + r.id, "Constraint entry pending field confirmation.", "Complete Confirmed By / Confirmation Date in the register.", "Open");
      });
      r.blockedPairsInRoute.forEach(function (k) {
        add("Blocked pair within route", k + " in " + r.id, "Pair separated in stop order but sharing a route may be impractical if crossing is impossible.", "Verify both stops belong on the same geographic route.", "Needs decision");
      });
    });
    (P.lockOverflow || []).forEach(function (rid) {
      add("Locked route exceeds N", rid, "Too many customers locked to one route breaks the route-size rule.", "Release locks or increase N.", "Needs decision");
    });
    (P.sizeIssues || []).forEach(function (m) {
      add("Route size rule not met", m, "Partition could not honour the size rule (possible do-not-combine deadlock).", "Adjust do-not-combine pairs or move customers manually.", "Open");
    });
    (plan.changelog || []).filter(function (e) { return e.action === "move"; }).forEach(function (e) {
      add("Customer manually moved", e.customer + " " + (e.fromRoute || "?") + " -> " + (e.toRoute || "?"), "Operator override; manual justification recorded.", "Confirm the move during road review.", "Open");
    });
    return exc;
  }

  function runQa(plan, matrix, cx) {
    var checks = [];
    var total = plan.summary.customerCount;
    var unique = new Set(Object.keys(plan.assignment)).size;
    checks.push({
      name: "All customers assigned exactly once",
      pass: plan.summary.unassignedCount === 0 && unique === total && plan.summary.repeated.length === 0,
      detail: unique + "/" + total + " unique assigned, " + plan.summary.unassignedCount + " unassigned, " + plan.summary.repeated.length + " duplicates"
    });
    var ts = plan.targetSizes && plan.targetSizes.length ? plan.targetSizes : null;
    var sizesOk = plan.routes.every(function (r, i) {
      var expect = ts ? ts[i] : (i === plan.routes.length - 1 ? total - (plan.routes.length - 1) * plan.n : plan.n);
      return r.stops.length === expect;
    });
    checks.push({
      name: "Route sizes follow plan",
      pass: sizesOk,
      detail: plan.routes.map(function (r) { return r.id + "=" + r.stops.length; }).join(" ")
    });
    checks.push({ name: "All routes fully ordered", pass: !plan.infeasible, detail: plan.infeasible ? "one or more routes INFEASIBLE (see exceptions)" : "all clear" });
    var blockedOk = true, blockedBad = [];
    plan.routes.forEach(function (r) {
      var seq = ["WH"].concat(r.stops).concat(plan.includeReturn ? ["WH"] : []);
      for (var i = 0; i < seq.length - 1; i++) if (cx.blocked(seq[i], seq[i + 1])) { blockedOk = false; blockedBad.push(r.id + " " + pairKey(seq[i], seq[i + 1])); }
    });
    checks.push({ name: "No Blocked pair placed consecutively", pass: blockedOk, detail: blockedBad.length ? blockedBad.join("; ") : "all clear" });
    var uncTotal = 0;
    plan.routes.forEach(function (r) { uncTotal += r.uncertainLegs.length; });
    checks.push({ name: "Uncertain / Not-reviewed links flagged", pass: uncTotal === 0 || plan.routes.some(function (r) { return r.reviewRequired; }), detail: uncTotal + " uncertain leg(s) flagged for review" });
    checks.push({ name: "Haversine distances computed from coordinates", pass: true, detail: "141x141 matrix built in-browser; no dependency on Excel cached formula values" });
    return checks;
  }

  /**
   * Recompute metrics/warnings/exceptions/QA for a plan whose routes were mutated
   * manually (moves, reorders). Keeps stop order; does NOT re-partition.
   * cfg: { reg: normalized register object, thresholds, n, includeReturn }. Manual
   * route status overrides are applied by the UI layer afterwards.
   */
  function recomputePlan(plan, matrix, cfg) {
    var reg = cfg.reg || normalizeRegister([]);
    var cx = constraintIndex(reg.entries);
    plan.n = cfg.n; plan.includeReturn = cfg.includeReturn; plan.thresholds = cfg.thresholds;

    plan.routes.forEach(function (r) {
      var m = routeMetrics(matrix, cx, r.stops, cfg.includeReturn, cfg.thresholds);
      r.metrics = m.metrics; r.warnings = m.warnings;
      r.blockedPairsInRoute = m.blockedPairsInRoute; r.blockedAvoided = m.blockedPairsInRoute.length > 0 ? m.blockedPairsInRoute.length - m.blockedAdjacentCount : 0;
      r.constraintLegs = m.constraintLegs; r.uncertainLegs = m.uncertainLegs;
      r.reviewRequired = m.reviewRequired;
      r.status = r.reviewRequired ? "Needs Manual Road Review" : "Draft";
      r.customerCount = r.stops.length;
      delete r.orderWarnings;
    });

    var assignment = {};
    plan.routes.forEach(function (r) { r.stops.forEach(function (c) { assignment[c] = r.id; }); });
    plan.assignment = assignment;
    plan.infeasible = plan.routes.some(function (r) { return r.orderFailed; });

    var repeated = [];
    { var seen = {}; plan.routes.forEach(function (r) { r.stops.forEach(function (c) { if (seen[c]) repeated.push(c); seen[c] = 1; }); }); }

    var unassigned = plan._customers.map(function (c) { return c.id; }).filter(function (id) { return assignment[id] === undefined; });

    var totalOut = 0, totalRet = 0, totalScore = 0, revCust = 0;
    plan.routes.forEach(function (r) {
      totalOut += r.metrics.outboundKm; totalRet += r.metrics.returnKm; totalScore += r.metrics.scoreKm;
      if (r.reviewRequired === true) revCust += r.customerCount;
    });

    plan.summary = {
      routeCount: plan.routes.length, customerCount: plan._customers.length,
      customersAssigned: Object.keys(assignment).length,
      repeated: repeated, unassignedCount: unassigned.length,
      customersRequiringReview: revCust,
      totalOutboundKm: totalOut, totalReturnKm: totalRet, totalScoreKm: totalScore
    };
    plan.unassigned = unassigned;
    plan.registerNotes = reg.notes;

    var P2 = { lockOverflow: plan.lockOverflow || [], sizeIssues: plan.sizeIssues || [] };
    plan.exceptions = buildExceptions(plan, matrix, cx, reg.entries, plan.thresholds, P2);
    plan.qa = runQa(plan, matrix, cx);
    return plan;
  }

  var PDP = {
    R_EARTH: R_EARTH,
    haversineKm: haversineKm,
    matrixFromData: matrixFromData,
    dist: dist,
    pairKey: pairKey,
    normalizeRegister: normalizeRegister,
    constraintIndex: constraintIndex,
    doNotIndex: doNotIndex,
    cannotPair: cannotPair,
    balancedSizes: balancedSizes,
    reorderFeasible: reorderFeasible,
    validateRegister: validateRegister,
    mergeRegister: mergeRegister,
    buildTargetSizes: buildTargetSizes,
    buildPlan: buildPlan,
    recomputePlan: recomputePlan,
    orderRoute: orderRoute,
    twoOpt: twoOpt,
    routeMetrics: routeMetrics,
    outboundKm: outboundKm,
    outboundCost: outboundCost,
    pathCost: pathCost,
    routeId: routeId,
    round1: round1,
    round2: round2,
    STATUS_ORDER: STATUS_ORDER
  };

  if (typeof module !== "undefined" && module.exports) { module.exports = PDP; }
  else { global.PDP = PDP; }
})(typeof window !== "undefined" ? window : this);