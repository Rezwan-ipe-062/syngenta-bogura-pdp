/**
 * PDP OR-Tools WASM Solver — Vite entry point.
 * Builds into dist/solver.js via `npm run build`.
 *
 * Exposes window.PDP_SOLVER with:
 *   .ready  — Promise that resolves when WASM is loaded
 *   .solve(params) → Promise<{ok, routes:[{id, stops}], solve_time_ms, objective_value, status}>
 *   .isReady() → boolean
 */
import {
  initRouting,
  RoutingIndexManager,
  RoutingModel,
  DefaultRoutingSearchParameters,
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
} from "or-tools-wasm/routing";

var M_PENALTY = 10_000_000; // 10 000 km in mm — worse than any real arc

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371.0;
  var dLat = ((lat2 - lat1) * Math.PI) / 180;
  var dLon = ((lon2 - lon1) * Math.PI) / 180;
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function solve(params) {
  var t0 = performance.now();

  // --- Build node list: [0] = warehouse, [1..N] = customers ---
  var nodeIds = ["WH"].concat(
    params.customers.map(function (c) { return c.id; })
  );
  var nodeLats = [params.warehouse.lat].concat(
    params.customers.map(function (c) { return c.lat; })
  );
  var nodeLons = [params.warehouse.lon].concat(
    params.customers.map(function (c) { return c.lon; })
  );
  var nNodes = nodeIds.length;
  var numVehicles = params.num_vehicles ||
    Math.ceil(params.customers.length / params.route_capacity);

  // --- Blocked pairs set ---
  var blockedSet = {};
  (params.blocked_pairs || []).forEach(function (pair) {
    if (pair.length === 2) {
      blockedSet[pair[0] + "~" + pair[1]] = true;
      blockedSet[pair[1] + "~" + pair[0]] = true;
    }
  });

  // --- OR-Tools routing model ---
  var manager = new RoutingIndexManager(nNodes, numVehicles, 0);
  var routing = new RoutingModel(manager);

  // Transit callback: distance in millimetres
  function transitCb(fromIdx, toIdx) {
    var fromNode = manager.indexToNode(fromIdx);
    var toNode = manager.indexToNode(toIdx);
    if (fromNode === toNode) return 0;
    var pair = nodeIds[fromNode] + "~" + nodeIds[toNode];
    if (blockedSet[pair]) return M_PENALTY;
    return Math.round(
      haversineKm(nodeLats[fromNode], nodeLons[fromNode],
                  nodeLats[toNode], nodeLons[toNode]) * 1000
    );
  }

  var transitIdx = routing.RegisterTransitCallback(transitCb);
  routing.SetArcCostEvaluatorOfAllVehicles(transitIdx);

  // --- Capacity dimension (demand = 1 per customer, 0 for depot) ---
  function demandCb(idx) {
    var node = manager.indexToNode(idx);
    return node === 0 ? 0 : 1;
  }
  var demandIdx = routing.RegisterUnaryTransitCallback(demandCb);
  routing.AddDimensionWithVehicleCapacity(
    demandIdx,
    0,
    new Array(numVehicles).fill(params.route_capacity),
    true,
    "Capacity"
  );

  // --- Include return: zero out return arcs when includeReturn=false ---
  if (!params.include_return) {
    function returnTransitCb(fromIdx, toIdx) {
      var toNode = manager.indexToNode(toIdx);
      if (toNode === 0) return 0; // returning to depot → zero cost
      return transitCb(fromIdx, toIdx);
    }
    var returnIdx = routing.RegisterTransitCallback(returnTransitCb);
    routing.SetArcCostEvaluatorOfAllVehicles(returnIdx);
  }

  // --- Search parameters ---
  var searchParams = DefaultRoutingSearchParameters();
  searchParams.firstSolutionStrategy = FirstSolutionStrategy.PATH_CHEAPEST_ARC;
  searchParams.localSearchMetaheuristic = LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH;

  // --- Solve (async — returns a Promise) ---
  return routing.SolveWithParameters(searchParams).then(function (assignment) {
    if (!assignment) {
      return {
        ok: false,
        solve_time_ms: Math.round(performance.now() - t0),
        status: "NO_SOLUTION",
        routes: [],
      };
    }

    // --- Extract routes ---
    var routes = [];
    for (var v = 0; v < numVehicles; v++) {
      var stops = [];
      var index = routing.Start(v);
      while (!routing.IsEnd(index)) {
        var node = manager.indexToNode(index);
        if (node !== 0) stops.push(nodeIds[node]);
        index = assignment.value(routing.NextVar(index));
      }
      if (stops.length > 0) {
        routes.push({
          id: "R" + String(v + 1).padStart(2, "0"),
          stops: stops,
        });
      }
    }

    var elapsed = Math.round(performance.now() - t0);
    var statusCode = routing.status();

    // --- Post-process: do-not-combine violations ---
    var dncSet = {};
    (params.do_not_combine || []).forEach(function (pair) {
      if (pair.length === 2) {
        dncSet[pair[0] + "~" + pair[1]] = true;
        dncSet[pair[1] + "~" + pair[0]] = true;
      }
    });
    if (Object.keys(dncSet).length > 0) {
      routes.forEach(function (r) {
        for (var i = 0; i < r.stops.length; i++) {
          for (var j = i + 1; j < r.stops.length; j++) {
            var key = r.stops[i] + "~" + r.stops[j];
            if (dncSet[key]) {
              for (var k = 0; k < routes.length; k++) {
                if (routes[k].id === r.id) continue;
                if (routes[k].stops.length < params.route_capacity) {
                  var canPlace = true;
                  if (routes[k].stops.length > 0) {
                    var lastOnTarget = routes[k].stops[routes[k].stops.length - 1];
                    if (blockedSet[lastOnTarget + "~" + r.stops[j]]) canPlace = false;
                  }
                  if (canPlace) {
                    r.stops.splice(j, 1);
                    routes[k].stops.push(r.stops[j]);
                    break;
                  }
                }
              }
              break;
            }
          }
        }
      });
    }

    return {
      ok: true,
      solve_time_ms: elapsed,
      objective_value: assignment.objectiveValue() / 1000.0,
      routes: routes,
      status: statusCode,
    };
  });
}

// --- Init WASM and expose API ---
var initPromise = initRouting()
  .then(function () {
    console.log("[PDP] OR-Tools WASM loaded");
  })
  .catch(function (err) {
    console.warn("[PDP] OR-Tools WASM failed to load:", err);
  });

window.PDP_SOLVER = {
  ready: initPromise,
  solve: solve,
  isReady: function () { return false; },
};

// Resolve isReady properly after init
initPromise.then(function () {
  window.PDP_SOLVER.isReady = function () { return true; };
});
