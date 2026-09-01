#!/usr/bin/env python3
"""
PDP Route Optimiser — OR-Tools VRP solver server.

Usage:
    pip install ortools fastapi uvicorn pydantic
    python solver_server.py [--port 8766]

Single endpoint: POST /solve
Health check:    GET  /health
"""

import argparse
import math
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class Customer(BaseModel):
    id: str
    lat: float
    lon: float

class Warehouse(BaseModel):
    id: str = "WH"
    lat: float
    lon: float
    name: str = ""

class SolveRequest(BaseModel):
    warehouse: Warehouse
    customers: list[Customer]
    num_vehicles: int = 20
    route_capacity: int = 7
    include_return: bool = True
    blocked_pairs: list[list[str]] = Field(default_factory=list)
    do_not_combine: list[list[str]] = Field(default_factory=list)
    locked_customers: dict[str, str] = Field(default_factory=dict)
    time_limit_seconds: int = 30

class RouteResult(BaseModel):
    id: str
    stops: list[str]

class SolveResponse(BaseModel):
    ok: bool
    solver: str = "ortools"
    solve_time_ms: float = 0
    objective_value: float = 0
    routes: list[RouteResult] = []
    unassigned: list[str] = []
    status: str = ""
    stats: dict = {}

# ---------------------------------------------------------------------------
# Haversine distance (km) — same formula as core.js
# ---------------------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="PDP OR-Tools Solver")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True, "solver": "ortools", "version": "14"}

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    t0 = time.time()

    # --- Build node list: [0] = warehouse, [1..N] = customers ---
    node_ids = ["WH"] + [c.id for c in req.customers]
    node_lats = [req.warehouse.lat] + [c.lat for c in req.customers]
    node_lons = [req.warehouse.lon] + [c.lon for c in req.customers]
    n_nodes = len(node_ids)
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    # --- Distance matrix (integer millimetres for OR-Tools) ---
    M_PENALTY = 10_000_000  # 10 000 km in mm — worse than any real arc
    blocked_set = set()
    for pair in req.blocked_pairs:
        if len(pair) == 2:
            a, b = pair
            blocked_set.add((a, b))
            blocked_set.add((b, a))

    def dist_mm(from_idx, to_idx):
        if from_idx == to_idx:
            return 0
        pair = (node_ids[from_idx], node_ids[to_idx])
        if pair in blocked_set:
            return M_PENALTY
        d = haversine_km(node_lats[from_idx], node_lons[from_idx],
                         node_lats[to_idx], node_lons[to_idx])
        return int(d * 1000)

    # --- OR-Tools routing model ---
    num_vehicles = req.num_vehicles
    depot = 0

    manager = pywrapcp.RoutingIndexManager(n_nodes, num_vehicles, depot)
    routing = pywrapcp.RoutingModel(manager)

    def transit_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return dist_mm(from_node, to_node)

    transit_cb = routing.RegisterTransitCallback(transit_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_cb)

    # --- Capacity dimension (demand = 1 per customer, 0 for depot) ---
    def demand_callback(index):
        node = manager.IndexToNode(index)
        return 0 if node == 0 else 1

    demand_cb = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_cb,
        0,                        # no slack
        [req.route_capacity] * num_vehicles,  # max capacity per vehicle
        True,                     # start cumul at zero
        "Capacity",
    )

    # --- Include return: add penalty on last->depot arc ---
    # Handled by making the return leg part of the transit cost naturally.
    # The depot is node 0; returning to depot = arc from last customer to 0.
    # The transit callback already handles this — the arc cost from any node
    # back to depot is the real Haversine distance (or M if blocked).
    # No extra dimension needed — the solver already minimises total arc cost
    # which includes the return leg when include_return=True.
    # When include_return=False, we zero out the return arcs:
    if not req.include_return:
        # Zero out arcs TO depot (last->WH)
        for v in range(num_vehicles):
            end_idx = routing.End(v)
            # We can't set individual arc costs after registration, so we
            # handle this differently: register a second transit callback
            # that zeroes return arcs and use it for a second dimension.
            pass
        # Simpler approach: when include_return=False, we don't need to
        # do anything special because the solver already minimises the
        # total path cost. The return leg is just another arc.
        # Actually, we need to zero out the return arc cost.
        # Use a vehicle-level approach:
        def return_transit_callback(from_index, to_index):
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            if to_node == 0:  # returning to depot
                return 0
            return dist_mm(from_node, to_node)

        return_cb = routing.RegisterTransitCallback(return_transit_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(return_cb)

    # --- Search parameters ---
    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_params.time_limit.seconds = req.time_limit_seconds

    # --- Solve ---
    solution = routing.SolveWithParameters(search_params)

    if solution is None:
        return SolveResponse(
            ok=False,
            solve_time_ms=round((time.time() - t0) * 1000),
            status="NO_SOLUTION",
        )

    status_name = routing.status_name(routing.solution_status())
    objective = solution.ObjectiveValue() / 1000.0  # convert mm back to km

    # --- Extract routes ---
    routes = []
    unassigned = []
    total_outbound = 0.0

    for v in range(num_vehicles):
        route_stops = []
        index = routing.Start(v)
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node != 0:
                route_stops.append(node_ids[node])
            index = solution.Value(routing.NextVar(index))

        if route_stops:
            # Compute outbound distance for this route
            route_km = 0.0
            prev = "WH"
            for cid in route_stops:
                d = haversine_km(
                    req.warehouse.lat if prev == "WH" else
                    next(c.lat for c in req.customers if c.id == prev),
                    req.warehouse.lon if prev == "WH" else
                    next(c.lon for c in req.customers if c.id == prev),
                    next(c.lat for c in req.customers if c.id == cid),
                    next(c.lon for c in req.customers if c.id == cid),
                )
                route_km += d
                prev = cid
            if req.include_return:
                last = route_stops[-1]
                route_km += haversine_km(
                    next(c.lat for c in req.customers if c.id == last),
                    next(c.lon for c in req.customers if c.id == last),
                    req.warehouse.lat, req.warehouse.lon,
                )
            total_outbound += route_km

            routes.append(RouteResult(
                id=f"R{v + 1:02d}",
                stops=route_stops,
            ))

    # --- Post-process: do-not-combine violations ---
    dnc_set = set()
    for pair in req.do_not_combine:
        if len(pair) == 2:
            dnc_set.add((pair[0], pair[1]))
            dnc_set.add((pair[1], pair[0]))

    if dnc_set:
        # Check for violations and relocate if needed
        for r in routes:
            for i, cid in enumerate(r.stops):
                for j in range(i + 1, len(r.stops)):
                    other = r.stops[j]
                    if (cid, other) in dnc_set:
                        # Violation found — try to relocate 'other' to another route
                        for r2 in routes:
                            if r2.id == r.id:
                                continue
                            if len(r2.stops) < req.route_capacity:
                                # Check if placing 'other' at end avoids blocked pairs
                                can_place = True
                                if r2.stops:
                                    last_on_r2 = r2.stops[-1]
                                    if (last_on_r2, other) in blocked_set:
                                        can_place = False
                                if can_place:
                                    r.stops.remove(other)
                                    r2.stops.append(other)
                                    break
                        break

    # --- Assign route IDs matching locked customers where possible ---
    # If a customer is locked to a route, swap them into that route
    if req.locked_customers:
        locked_by_route = {}  # route_id -> [customer_ids]
        for cid, rid in req.locked_customers.items():
            locked_by_route.setdefault(rid, []).append(cid)

        for rid, cids in locked_by_route.items():
            # Find the route with this ID
            target = None
            for r in routes:
                if r.id == rid:
                    target = r
                    break
            if not target:
                continue

            for cid in cids:
                # Find which route currently has this customer
                source = None
                for r in routes:
                    if cid in r.stops:
                        source = r
                        break
                if not source or source.id == target.id:
                    continue

                # Swap: find a non-locked customer on target to exchange
                source.stops.remove(cid)
                target.stops.append(cid)

    elapsed = round((time.time() - t0) * 1000)

    return SolveResponse(
        ok=True,
        solve_time_ms=elapsed,
        objective_value=round(objective, 2),
        routes=routes,
        unassigned=unassigned,
        status=status_name,
        stats={
            "total_outbound_km": round(total_outbound, 2),
            "routes_used": len(routes),
            "avg_stops_per_route": round(sum(len(r.stops) for r in routes) / max(len(routes), 1), 1),
        },
    )

# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description="PDP OR-Tools solver server")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print(f"PDP OR-Tools solver running on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
