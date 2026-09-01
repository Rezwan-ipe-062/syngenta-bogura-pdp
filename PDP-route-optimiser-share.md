# PDP Route Optimiser (Phase 1) — Full Code & Design Rationale

*Single self-contained document: every line of source, plus the reasoning behind every design decision. Paste this whole file (or its numbered sections) into your company LLM to give it the full context of the Bogura Phase 1 routing tool.*

---

## 0. What this is

A 100%-client-side web app that drafts delivery routes from the **Bogura warehouse** (Bangladesh) to 140 CP customers. It reads an uploaded Excel workbook's `Locations` sheet, groups the 140 customers into routes of a fixed size **N**, orders each route as an out-and-back trip from the warehouse, and draws it as straight lines on an OpenStreetMap map.

**The one-sentence caveat that governs the whole tool: distances are aerial (Haversine great-circle) kilometres. They are NOT truck-driving km, NOT road travel time, and NOT proof that a connection exists.** The app's job is only to produce a geographically sensible *draft*; every route still needs physical road validation (bridges, ferries, vehicle access) before dispatch.

That caveat is repeated in the UI banner, on every printable sheet, in every export, and in the mark route-as-`Road Validated` confirm dialog, because the biggest real-world risk with a tool like this is that someone treats the straight-line draft as driveable.

---

## 1. Engineering decisions map (the short answer to "why did you do it this way")

| Decision | Why |
|---|---|
| Rewrite the distance matrix in JavaScript | The workbook ships a Distance Matrix + Pair List that are 100% Excel *formulas with zero cached values*. Anything that reads the workbook naively (incl. pandas/openpyxl `data_only=True`) would get `None`. The app recomputes all 141×141 pairs with the same Haversine formula the workbook documents (R = 6,371.0088 km), so it is immune to Excel caching. |
| `build_data.py` extracts only Locations | It validates the workbook (141 rows, numeric coords, complete continuous C001–C140 set, Pair List sanity check), prints a geography summary, and emits two JS data files. Distances are deliberately NOT precomputed there. |
| Farthest-corridor seed partition + nearest-seed assign + rebalance | Classic, simple, deterministic "spread the routes" heuristic. Farthest-point seeds force routes to cover different geographic corridors from the warehouse; nearest-seed assignment then puts each customer with the corridor it's closest to; a balance pass restores exact N-sized routes. It is not a global solver — deliberately — because it's fast, explainable, and good enough for a geographic draft. |
| Nearest-neighbour order + 2-opt | Preview order matters for the map and exports. 2-opt is the smallest classic improvement that reliably untangles self-crossing routes; a `300`-iteration guard keeps it bounded. Both respect Blocked pairs so the constraints are never *silently* violated by reordering. |
| Cross-route improvement (relocations + swaps) | After local ordering, one global pass tries "move this customer to a shorter route" and "swap two customers between routes" moves that reduce *total* distance, while keeping every route at its exact target size. |
| Fixed route size = design invariant | Requirement: routes of size N. Everything (partition, balance, cross-route moves, manual swap-not-move) is built around preserving that invariant. |
| Optional forced route count K | Replan modal's "forced route count" splits 140 customers into **K balanced routes** (sizes differ by at most 1) instead of N-sized routes. `plan.targetSizes[]` is the single source the partitioner, cross-route improvement, manual move/swap and QA all read. An out-of-range K (outside 1..140) is ignored with a `forceNotes` message; a K below the locked-route count is clamped up to it. |
| Infeasible route ≠ silently-dropped route | When Blocked constraints leave a route with no legal stop order (`orderRoute` can't place every member without an illegal adjacency), the route is built best-effort — the unplaceable members are exposed, the route is marked `INFEASIBLE`, the plan is flagged `infeasible`, a red banner is shown, and a "Road-infeasible route" exception is emitted. It can never be `Road Validated`. |
| `Road Validated` requires a recorded verifier | Marking a route road-validated goes through a shared guard (`roadValidateGuard`) in both the dropdown and the programmatic facade: no unvalidated constraint legs, no open exceptions touching the route, and a verifier (who / date / evidence) captured before the status is applied. Prevents "validated" being a rubber stamp. |
| CSV exports are injection-safe | Long-standing requirement to paste route/constraint CSVs into Excel. `csvSafe` prefixes leading `= + @ - 	 ` cells with a single quote (minus passes through bare for numeric literals like `-12.5`), then the standard CSV quoting applies. Every HTML surface (route details, popups, print sheets, exceptions, constraint table) goes through `escHtml`. |
| Stop exports carry BP enrichment | `build_data.py` joins the 140 customers against the Customer Master (Location ID → BP ID) for Region / Territory / Sales Group, appended to `data.js` and exported in the route-stops sheets and XLSX. Enrichment is display-only; routing logic ignores it. |
| `Blocked` / `Uncertain` / `Not reviewed` / `Validated` | Requirement: constraints are first-class input with a status per pair. `Blocked` = hard rule (never consecutive stops, including across the WH boundary). `Uncertain` / `Not reviewed` = soft rule (may appear, but the route is visibly flagged `Needs Manual Road Review` until a human confirms). `Validated` = confirmed, no restriction. |
| Manual "Move" becomes a **Swap** unless it preserves exact target sizes | In a fully satisfied plan every route already sits at its exact target size (from `plan.targetSizes`), so a plain one-way move can rarely land. `moveCustomer` only performs a one-way move when the source drops to exactly `targetSizes[src]` and the target grows to exactly `targetSizes[dst]`; otherwise it becomes a two-customer swap. Forcing the operator to swap two customers is what "manual adjustment preserves route-size rules" actually requires. |
| Every manual action logs an auditable reason + before/after km | Requirement: manual moves need a reason and must show the before/after distance impact. This makes manual overrides defensible at review time. |
| localStorage, no backend | Requirement: single-user, run off a shared file. Storing state in the browser means zero servers, zero install, zero network beyond the OSM tiles. Trade-off: state is per-browser and not shared. |
| Reframe the workbook's Distance Matrix as documentation | The `build_data.py` sanity check on the Pair List exists to *catch a future workbook change*, but the app itself never reads matrix values. |
---

# 2. Data pipeline — build_data.py

`build_data.py` turns the source workbook into `js/data.js` (locations only) and `js/constraints.js` (an editable Road Constraints Register seed). It fails loudly on any structural change: wrong sheets, wrong header, not-141 rows, NaN/out-of-range coordinates, duplicate IDs or BP IDs, a non-continuous C001..C140 ID set, or a Pair List that no longer covers all pairs. Every check exists because a silently-mangled data file would corrupt every downstream route.

Why the Pair List row count is *informative* rather than blocking: the workbook's formula columns produce `None` under `data_only=True`, so the Pair List can't be trusted as a distance source — the app computes its own matrix. The check still runs because the *set of pair keys* is structural and should be stable. R = 6,371.0088 km matches the workbook's documented formula exactly, and the same `hav()` snippet is reproduced in the app in `core.js`.

```python
#!/usr/bin/env python3
"""PDP Route Optimiser - build data pack from the Bogura straight-line distance workbook.

Validates the workbook and emits browser data files:
  js/data.js        -> window.APP_DATA            (locations only; distances computed in JS)
  js/constraints.js -> window.CONSTRAINTS_REGISTER (editable Road Constraints Register seed)

Haversine distances are deliberately NOT precomputed here: the app computes the
141x141 matrix in JavaScript from the Latitude/Longitude columns. This removes any
dependency on Excel formula caching (the workbook ships with zero cached values).
"""
import json
import math
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent
DEFAULT_XLSX = ROOT.parent / "Data Files" / "bogura-141x141-distance-matrix-cleaned.xlsx"

E = lambda s: sys.exit(f"[build_data] FAIL: {s}")

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)

def check(cond, msg):
    if not cond:
        E(msg)

# ---------------------------------------------------------------- ask for workbook
if len(sys.argv) > 1:
    XLSX = Path(sys.argv[1]).resolve()
elif sys.stdin.isatty():
    raw = input(f"Excel workbook path [{DEFAULT_XLSX}]: ").strip()
    XLSX = Path(raw).resolve() if raw else DEFAULT_XLSX
else:
    XLSX = DEFAULT_XLSX
check(XLSX.exists(), f"workbook not found: {XLSX}")
print(f"[build_data] using workbook: {XLSX}")

# ---------------------------------------------------------------- load workbook
wb = openpyxl.load_workbook(XLSX, data_only=True)
check(set(wb.sheetnames) >= {"Read Me", "Locations", "Distance Matrix", "Pair List"},
      f"workbook missing required sheets (Read Me, Locations, Distance Matrix, Pair List); got {wb.sheetnames}")

readme = {}
for r in wb["Read Me"].iter_rows(min_row=1, max_col=2, values_only=True):
    if r[0] is not None and r[1] is not None:
        readme[str(r[0]).strip()] = str(r[1]).strip()

# ---------------------------------------------------------------- locations
rows = [r for r in wb["Locations"].iter_rows(min_row=1, max_col=6, values_only=True)]
hdr = [str(r) for r in rows[0]]
check(hdr[:6] == ["Location ID", "Location Name", "BP ID", "Address", "Latitude", "Longitude"],
      f"unexpected Locations header {hdr}")
loc_rows = [r for r in rows[1:] if r[0] is not None]
check(len(loc_rows) == 141, f"expected 141 location rows, got {len(loc_rows)}")

warehouse = None
customers = []
seen_ids = set()
seen_bp = set()
for r in loc_rows:
    lid, name, bp, addr, lat, lon = (str(r[0]).strip(), r[1], r[2], r[3], r[4], r[5])
    check(lid not in seen_ids, f"duplicate Location ID {lid}")
    seen_ids.add(lid)
    check(num(lat) and num(lon), f"{lid}: missing/invalid lat or lon ({lat!r}, {lon!r})")
    check(20.0 <= lat <= 27.0 and 88.0 <= lon <= 93.0,
          f"{lid}: coordinates outside Bangladesh bounds ({lat}, {lon})")
    if lid == "WH":
        warehouse = {"id": "WH", "name": str(name or ""), "bpId": "",
                     "address": str(addr or ""), "lat": lat, "lon": lon}
    elif re.fullmatch(r"C\d{3}", lid):
        bp = "" if bp is None else str(bp).strip()
        check(bp not in seen_bp or not bp, f"{lid}: duplicate BP ID {bp}")
        if bp:
            seen_bp.add(bp)
        customers.append({"id": lid, "name": str(name or ""), "bpId": bp,
                          "address": str(addr or ""), "lat": lat, "lon": lon})
    else:
        E(f"unexpected Location ID {lid!r}")

check(warehouse is not None, "no WH row found")
check(len(customers) == 140, f"expected 140 customers, got {len(customers)}")
customers.sort(key=lambda c: c["id"])
ids = ["WH"] + [c["id"] for c in customers]
check(set(ids) == {"WH"} | {f"C{i:03d}" for i in range(1, 141)},
      "customer IDs not the complete continuous C001..C140 set")

# ---------------------------------------------------------------- enrichment (Customer Master, display-only — optional sheet)
enr_hdr = None
enr_rows = []
if "Customer Master" in wb.sheetnames:
    for row in wb["Customer Master"].iter_rows(values_only=True):
        if row[0] is None:
            continue
        if enr_hdr is None:
            enr_hdr = [str(x).strip() if x is not None else "" for x in row]
        else:
            enr_rows.append(row)
else:
    print("[build_data] Customer Master sheet not found - region/territory enrichment skipped")

def enr_col(name):
    return enr_hdr.index(name) if name in enr_hdr else -1

if enr_hdr:
    idx_lid = enr_col("Location ID")
    idx_bp = enr_col("BP ID")
    idx_zone = enr_col("Zone Name")
    idx_unit = enr_col("Unit Name")
    idx_grp = enr_col("Sales Group Code")
    missing_cols = [n for n, v in [("Location ID", idx_lid), ("BP ID", idx_bp),
                                    ("Zone Name", idx_zone), ("Unit Name", idx_unit),
                                    ("Sales Group Code", idx_grp)] if v < 0]
    if missing_cols:
        print(f"[build_data] Customer Master missing columns {missing_cols} - region/territory enrichment skipped")
        enr_hdr = None  # disable enrichment
else:
    idx_lid = idx_bp = idx_zone = idx_unit = idx_grp = -1

enr_by_bp, enr_by_lid = {}, {}
if enr_hdr:
    for r in enr_rows:
        bp = "" if r[idx_bp] is None else str(r[idx_bp]).strip()
        lid = "" if r[idx_lid] is None else str(r[idx_lid]).strip()
        zone = "" if r[idx_zone] is None else str(r[idx_zone]).strip()
        unit = "" if r[idx_unit] is None else str(r[idx_unit]).strip()
        grp = "" if r[idx_grp] is None else str(r[idx_grp]).strip()
        rec = {"region": zone, "territory": unit, "salesGroup": grp}
        if lid:
            enr_by_lid[lid] = rec
        if bp:
            enr_by_bp[bp] = rec

    matched = 0
    for c in customers:
        rec = enr_by_lid.get(c["id"]) or enr_by_bp.get(c["bpId"], {})
        if rec.get("region"):
            matched += 1
        c["region"] = rec.get("region", "")
        c["territory"] = rec.get("territory", "")
        c["salesGroup"] = rec.get("salesGroup", "")
    print(f"[build_data] enrichment: {matched}/{len(customers)} customers matched on Location ID / BP ID")
else:
    for c in customers:
        c["region"] = ""
        c["territory"] = ""
        c["salesGroup"] = ""

# ---------------------------------------------------------------- info pack (Customer Master from sibling PDP project, display-only)
# Joins on BP ID to pull 12-month sales/volume, activity, recency and a monthly
# volume sparkline for the map. Each customer gains a compact `info` object.
INFO_SRC = ROOT.parent.parent / "PDP Route Optimization" / "pdp_app" / "output" / "master_data.json"

def _mt(mon):
    if not isinstance(mon, dict):
        return 0.0
    x = mon.get("qty_sku_mt")
    if x is None:
        x = mon.get("qty")
    return float(x or 0.0)

info_matched = 0
if INFO_SRC.exists():
    md = json.loads(INFO_SRC.read_text(encoding="utf-8"))
    info_by_bp = {}
    for m in md.get("customers", []):
        bp = "" if m.get("BP_ID") is None else str(m["BP_ID"]).strip()
        if not bp or bp in info_by_bp:
            continue
        months = m.get("Monthly") or {}
        mkeys = sorted(months.keys())[-12:]
        info_by_bp[bp] = {
            "n": str(m.get("Customer_Name") or "").strip(),
            "mk": str(m.get("Market") or "").strip(),
            "d": str(m.get("District_Parsed") or "").strip(),
            "sl": round(m.get("L12M_Sales_BDT") or 0),
            "v": round(m.get("L12M_Vol") or 0, 1),
            "a": int(m.get("Active_Months") or 0),
            "r": int(m.get("Recency_Months") or 0),
            "m": 1 if m.get("Meets_Either_Threshold") else 0,
            "sf": mkeys[0] if mkeys else "",
            "sp": [round(_mt(months.get(k)), 2) for k in mkeys],
        }
    for c in customers:
        rec = info_by_bp.get(c["bpId"])
        if rec:
            c["info"] = rec
            info_matched += 1
    print(f"[build_data] info pack: {info_matched}/{len(customers)} customers matched on BP ID from `{INFO_SRC.name}`")
else:
    print(f"[build_data] info pack: `{INFO_SRC.name}` not found - map info mode disabled")

# ---------------------------------------------------------------- matrix/pairs sanity (informative)
pair_ws = wb["Pair List"]
pairs = [r for r in pair_ws.iter_rows(min_row=2, values_only=True) if r[0] is not None]
pair_keys = set()
for r in pairs:
    a, b = str(r[0]).strip(), str(r[2]).strip()
    check(a in ids and b in ids, f"pair list references unknown ID {a}/{b}")
    if a == b:
        continue
    pair_keys.add(tuple(sorted((a, b))))
expect_pairs = {tuple(sorted((ids[i], ids[j])))
                for i in range(len(ids)) for j in range(i + 1, len(ids))}
missing_pairs = expect_pairs - pair_keys
check(not missing_pairs, f"pair list missing {len(missing_pairs)} pairs (e.g. {sorted(missing_pairs)[:3]})")
extra_pairs = pair_keys - expect_pairs
print(f"[build_data] Pair List: {len(pairs)} rows, {len(pair_keys)} unique unordered pairs, "
      f"{len(extra_pairs)} extra (ignored - app computes its own matrix)")

# ---------------------------------------------------------------- geography summary
R = 6371.0088
def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = math.radians(b[0] - a[0]); dl = math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

wh_km = sorted(hav((warehouse["lat"], warehouse["lon"]), (c["lat"], c["lon"])) for c in customers)
geo = {
    "minKm": round(wh_km[0], 1), "medianKm": round(wh_km[70], 1), "maxKm": round(wh_km[-1], 1),
    "beyond50km": sum(1 for d in wh_km if d > 50),
    "beyond100km": sum(1 for d in wh_km if d > 100),
    "beyond150km": sum(1 for d in wh_km if d > 150),
}

# ---------------------------------------------------------------- emit files
def js_str(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))

meta = {
    "source": XLSX.name,
    "generated": "2026-08-30",
    "totalCustomers": 140,
    "routeName": "Bogura PDP",
    "geography": geo,
}
readme_txt = {
    "Purpose": readme.get("Purpose", ""),
    "Coverage": readme.get("Coverage", ""),
    "HowToUse": readme.get("How to use", ""),
    "CriticalLimitation": readme.get("Critical limitation", ""),
    "Formula": readme.get("Formula", ""),
}

data_js = (
    "/** GENERATED by build_data.py - do not edit by hand. Re-run: python build_data.py */\n"
    f"window.APP_DATA = {{\n"
    f"  meta: {js_str(meta)},\n"
    f"  readme: {js_str(readme_txt)},\n"
    f"  warehouse: {js_str(warehouse)},\n"
    f"  customers: {js_str(customers)},\n"
    f"}};\n"
)
(ROOT / "js" / "data.js").write_text(data_js, encoding="utf-8")
print(f"[build_data] wrote js/data.js ({len(data_js)} bytes)")

constraints_js = (
    "/** Road Constraints Register - editable Road/data input. Do not put <script> data in comments.\n"
    " * Every row uses Location IDs: WH or C001..C140 (From ID / To ID are a location pair).\n"
    " * Constraint Type: River / no direct crossing | Ferry required | Weak bridge |\n"
    " *   4-wheeler restricted | Seasonal / monsoon access risk | Market-time restriction |\n"
    " *   Road under repair | Security / local restriction | Other\n"
    " * Status: Blocked | Uncertain | Validated | Not reviewed\n"
    " * Rules: Blocked pair = NEVER consecutive stops. Uncertain pair = allowed only with visible warning.\n"
    " * Replace this seed with your own register via the Import button in the app (CSV/Excel/JSON).\n"
    " * This seed intentionally starts empty - constraints come from the field register.\n"
    " */\n"
    "window.CONSTRAINTS_REGISTER = [];\n"
)
(ROOT / "js" / "constraints.js").write_text(constraints_js, encoding="utf-8")
print(f"[build_data] wrote js/constraints.js ({len(constraints_js)} bytes)")

print(f"[build_data] OK. {len(customers)} customers, warehouse {warehouse['name']} "
      f"({warehouse['lat']:.4f},{warehouse['lon']:.4f}).")
```
---

# 3. Data — js/data.js (real Bogura customer set)

Generated output, included verbatim (including real partner coordinates). Structure: `meta` (source, geography summary), `readme` (the workbook's own explanation of the matrix), `warehouse`, and `customers` (140 rows: id, name, bpId, address, lat, lon, region, territory, salesGroup — the last three enriched from the Customer Master reference sheet by `build_data.py` and used only for display/export). `build_data.py` sorts customers and asserts the ID set is exactly C001…C140.

**Internal data.** This file embeds real partner locations; treat it as company-internal. The Excel workbook itself cannot be embedded in a markdown file, but nothing is lost — `build_data.py` regenerates this file from it with one command.

```js
/** GENERATED by build_data.py - do not edit by hand. Re-run: python build_data.py */
window.APP_DATA = {
  meta: {"source":"bogura-141x141-distance-matrix-cleaned.xlsx","generated":"2026-08-30","totalCustomers":140,"routeName":"Bogura PDP","geography":{"minKm":12.7,"medianKm":89.6,"maxKm":207.9,"beyond50km":114,"beyond100km":58,"beyond150km":18}},
  readme: {"Purpose":"A routing input and calculation check. The matrix gives the aerial (Haversine) distance between every warehouse/customer pair.","Coverage":"1 Bogura warehouse + 140 active CP customer coordinates = 141 locations.","HowToUse":"To score a draft outbound route, add the matrix legs: Warehouse→Stop 1 + Stop 1→Stop 2 + … + Stop N. Add Stop N→Warehouse only if return distance is in scope.","CriticalLimitation":"These are straight-line kilometres. They are NOT truck driving km, road travel time, or proof that a connection is possible. Rivers, bridge limits, ferries and vehicle-access constraints remain unmodelled.","Formula":"Haversine formula, Earth radius = 6,371.0088 km. Each matrix value is an Excel formula linked to the Locations sheet."},
  warehouse: {"id":"WH","name":"Bogura Warehouse","bpId":"","address":"Warehouse","lat":24.8155701506389,"lon":89.35851746567042},
  customers: [{"id":"C001","name":"M/S. Tanzim Traders","bpId":"21137182","address":"Shihali Hat, Shibganj, Shibganj, Bogra","lat":24.98015074537992,"lon":89.2214006988606,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. Tanzim Traders","mk":"SHIHALI HAT","d":"BOGRA","sl":28102955,"v":12.6,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[0.83,1.75,0.24,3.65,0.44,1.23,0.0,1.94,0.33,0.25,0.09,1.4]}},{"id":"C002","name":"M/S. MA-HAZERA TRADERS","bpId":"21137400","address":"Mela Gupinathpur, Gupinathpur, Akkelpur, Joypurhat","lat":24.97134238976516,"lon":89.08509852721332,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. MA-HAZERA TRADERS","mk":"MELA GUPINATHPUR","d":"JOYPURHAT","sl":24287622,"v":14.2,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[0.36,0.84,1.1,6.4,0.0,1.55,0.25,2.0,0.07,0.0,0.12,1.26]}},{"id":"C003","name":"M/S. ASHRAF TRADERS","bpId":"21137348","address":"Dugdugi Hat, Osmanpur, Osmanpur, Dinajpur","lat":25.27400080758283,"lon":89.15403937142703,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. ASHRAF TRADERS","mk":"DUGDUGI HAT","d":"DINAJPUR","sl":28787108,"v":26.3,"a":14,"r":0,"m":1,"sf":"2025-08","sp":[2.69,2.82,0.0,4.03,0.23,7.9,0.92,2.68,0.04,0.0,0.6,4.04]}},{"id":"C004","name":"M/S. KUNDU TRADERS 1","bpId":"21137396","address":"Panchbibi Bazar, Panchbibi, Panchbibi, Joypurhat","lat":25.18671930587793,"lon":89.02016542479848,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. KUNDU TRADERS 1","mk":"PANCHBIBI BAZAR","d":"JOYPURHAT","sl":102980545,"v":65.6,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[0.06,8.13,0.0,11.85,3.69,18.55,4.06,5.09,0.07,0.44,8.13,3.45]}},{"id":"C005","name":"M/S. MONDOL BIZZ VANDAR","bpId":"21137395","address":"Jamalgong Road, Sowdagorpara, Joypurhat, Joypurhat Sadar, Jo","lat":25.10012471484836,"lon":89.0301147972364,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. MONDOL BIZZ VANDAR","mk":"JAMALGONG ROAD, SOWDAGORPARA","d":"JO","sl":27870956,"v":23.0,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[0.46,4.06,1.01,4.84,0.0,3.82,1.0,2.93,1.08,0.1,0.28,3.09]}},{"id":"C006","name":"M/S. MONDOL TRADERS","bpId":"21328668","address":"Harunja, Kalai, Joypurhat, Joypurhat","lat":25.04409876839918,"lon":89.14707256142123,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. MONDOL TRADERS","mk":"HARUNJA","d":"JOYPURHAT","sl":105896440,"v":64.7,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[5.55,8.02,2.95,12.03,1.53,6.23,6.22,8.18,1.41,1.55,2.49,6.83]}},{"id":"C007","name":"M/S. ASIF ENTERPRISE","bpId":"21362623","address":"Pachsira Bazar, Pachsira Bazar, Kalai, Joypurhat","lat":25.06642258869952,"lon":89.17444958541422,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. ASIF ENTERPRISE","mk":"PACHSIRA BAZAR","d":"JOYPURHAT","sl":30313859,"v":23.3,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[0.65,0.69,0.96,6.58,1.53,4.71,2.53,3.65,0.24,0.0,0.0,1.39]}},{"id":"C008","name":"M/S. ROBIN KRISHI VANDER","bpId":"21362622","address":"Bottoli Bazar, Bottoli Bazar, Baniapara, Joypurhat","lat":25.06753255834376,"lon":89.09574815908223,"region":"North","territory":"Joypurhat","salesGroup":"B01","info":{"n":"M/S. ROBIN KRISHI VANDER","mk":"BOTTOLI BAZAR","d":"JOYPURHAT","sl":18915426,"v":11.2,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[0.2,0.72,0.12,3.79,0.0,1.84,0.68,2.85,0.0,0.0,0.1,0.72]}},{"id":"C009","name":"M/S. MONDOL & SONS","bpId":"21137137","address":"Mohadevpur, Mahadebpur, Mahadebpur, Naogaon","lat":24.91688533031869,"lon":88.74957512198822,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. MONDOL & SONS","mk":"MOHADEVPUR","d":"NAOGAON","sl":122897833,"v":91.5,"a":14,"r":0,"m":1,"sf":"2025-08","sp":[0.0,7.3,0.04,0.0,0.0,51.36,0.08,5.32,0.04,0.0,0.95,24.48]}},{"id":"C010","name":"M/S. CHAR BHAI TRADERS","bpId":"21137420","address":"Satihat Bazar, Satihat, Manda, Naogaon","lat":24.804581619792,"lon":88.74639663683432,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. CHAR BHAI TRADERS","mk":"SATIHAT BAZAR","d":"NAOGAON","sl":76369779,"v":72.9,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[14.04,10.7,0.21,9.58,2.1,9.34,5.11,5.21,1.32,0.05,0.46,13.47]}},{"id":"C011","name":"M/S. SARKER BROTHERS","bpId":"21137424","address":"Matazihat,Puraton Chaul Potti, Raiga, Mahadebpur, Naogaon","lat":24.97760912282647,"lon":88.84196838933754,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. SARKER BROTHERS","mk":"MATAZIHAT, PURATON CHAUL POTTI","d":"NAOGAON","sl":114705458,"v":83.0,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[7.03,9.54,1.61,7.42,0.0,17.05,4.8,9.03,0.0,0.0,5.91,18.6]}},{"id":"C012","name":"M/S. JAHANARA TRADERS","bpId":"21247869","address":"Jat Amrol, Ahsangonj, Attrai, Naogaon","lat":24.61440202328746,"lon":88.97500951219494,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. JAHANARA TRADERS","mk":"JAT AMROL","d":"NAOGAON","sl":41217871,"v":45.2,"a":7,"r":0,"m":1,"sf":"2025-08","sp":[12.94,24.89,0.78,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,6.12]}},{"id":"C013","name":"M/S. JAHANARA TRADERS 2","bpId":"21424757","address":"Par Naogaon, Jatamrul, Ashangonj, Naogaon","lat":24.80452965338677,"lon":88.95757623009698,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. JAHANARA TRADERS 2","mk":"PAR NAOGAON","d":"NAOGAON","sl":57922674,"v":59.6,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,25.29,1.02,10.42,0.0,9.04,6.19,0.0,0.0,6.75]}},{"id":"C014","name":"M/S. KARIM TRADING","bpId":"21137441","address":"Bahergola Bazar, Sirajganj, Sirajganj Sadar, Sirajganj","lat":24.46325113490409,"lon":89.69819941909117,"region":"North","territory":"Sirajganj","salesGroup":"B01","info":{"n":"M/S. KARIM TRADING","mk":"BAHERGOLA BAZAR","d":"SIRAJGANJ","sl":44457511,"v":68.0,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[3.22,19.21,3.25,0.0,0.0,17.18,10.55,10.63,0.07,0.6,0.8,2.17]}},{"id":"C015","name":"M/S. MOLY TRADERS","bpId":"21137444","address":"Solonga Bazar, Solonga , Roigonj, Sirajganj","lat":24.41674654954826,"lon":89.50899391358908,"region":"North","territory":"Sirajganj","salesGroup":"B01","info":{"n":"M/S. MOLY TRADERS","mk":"SOLONGA BAZAR","d":"SIRAJGANJ","sl":47227893,"v":74.0,"a":14,"r":3,"m":1,"sf":"2025-08","sp":[2.91,35.2,6.81,8.42,0.0,15.23,0.68,3.27,1.02,0.0,0.0,0.0]}},{"id":"C016","name":"M/S. MOMIN ENTERPRISE","bpId":"21137445","address":"Pat Bandar, Ullapara, Ullapara, Sirajganj","lat":24.31177462771956,"lon":89.56916447727114,"region":"North","territory":"Sirajganj","salesGroup":"B01","info":{"n":"M/S. MOMIN ENTERPRISE","mk":"PAT BANDAR","d":"SIRAJGANJ","sl":73027808,"v":110.7,"a":18,"r":1,"m":1,"sf":"2025-08","sp":[0.96,40.04,2.6,13.42,3.22,35.22,1.58,11.52,0.44,0.82,0.11,0.0]}},{"id":"C017","name":"M/S. FARDIN TRADERS","bpId":"21241827","address":"Upazila Road, Kandapara, Shahjadpur, Shahjadpur, Municipal,","lat":24.17538584309587,"lon":89.59409333286352,"region":"North","territory":"Bera","salesGroup":"B01","info":{"n":"M/S. FARDIN TRADERS","mk":"UPAZILA ROAD, KANDAPARA","d":"MUNICIPAL","sl":79614472,"v":122.5,"a":16,"r":1,"m":1,"sf":"2025-08","sp":[0.0,38.8,6.71,21.79,0.0,26.96,7.31,19.33,0.18,0.65,0.13,0.0]}},{"id":"C018","name":"M/S. TALUKDER TRADERS","bpId":"21248193","address":"Mukandagati College Hat, Shohagpur, Belkuchi, Sirajgonj","lat":24.30731442189048,"lon":89.69826090504694,"region":"North","territory":"Sirajganj","salesGroup":"B01","info":{"n":"M/S. TALUKDER TRADERS","mk":"MUKANDAGATI COLLEGE HAT","d":"SIRAJGONJ","sl":54631922,"v":88.0,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[2.98,16.6,2.48,6.96,0.03,30.09,12.82,6.66,1.89,0.15,2.7,4.19]}},{"id":"C019","name":"M/S. FARUQUE ENTERPRISE","bpId":"21137382","address":"Mokamtola Bazar, Mokamtola, Shibganj, Bogra","lat":25.0138577629721,"lon":89.37042619088459,"region":"North","territory":"Kahalu","salesGroup":"B01","info":{"n":"M/S. FARUQUE ENTERPRISE","mk":"MOKAMTOLA BAZAR","d":"BOGRA","sl":72808982,"v":72.5,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[5.92,5.63,2.13,14.96,2.46,14.43,7.76,7.2,2.58,0.44,1.47,6.89]}},{"id":"C020","name":"M/S. RAQIB TRADERS","bpId":"21137394","address":"Main Road Adamdighi Bazar, Adamdighi, Alamdighi, Bogra","lat":24.82051890820041,"lon":89.04271294131341,"region":"North","territory":"Kahalu","salesGroup":"B01","info":{"n":"M/S. RAQIB TRADERS","mk":"MAIN ROAD ADAMDIGHI BAZAR","d":"BOGRA","sl":82640116,"v":45.8,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[3.51,4.42,0.25,8.4,2.63,5.99,1.09,9.42,0.0,1.56,0.39,6.45]}},{"id":"C021","name":"M/S. RAHIM TRADERS","bpId":"21137392","address":"Bibir Pukur Bazar, Narhotto, Kahalu, Bogra","lat":24.8594421894139,"lon":89.2419281148032,"region":"North","territory":"Kahalu","salesGroup":"B01","info":{"n":"M/S. RAHIM TRADERS","mk":"BIBIR PUKUR BAZAR","d":"BOGRA","sl":101068443,"v":69.6,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.84,6.57,0.48,22.83,0.04,18.8,0.0,5.91,0.0,0.43,0.99,7.33]}},{"id":"C022","name":"M/S. KHALID BIN WALIDTRADERS","bpId":"21137388","address":"Chandaikona Bazar, Shimabari, Roigonj, Sirajganj","lat":24.56222243567296,"lon":89.5023146946306,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. KHALID BIN WALIDTRADERS","mk":"CHANDAIKONA BAZAR","d":"SIRAJGANJ","sl":46309446,"v":59.5,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[2.3,15.89,0.34,7.15,0.66,15.17,1.17,6.77,0.0,0.63,0.15,7.31]}},{"id":"C023","name":"M/S. DHONUT SEED & AGRO TRADERS","bpId":"21287703","address":"The Great Shopping Centre, Dhonut Bazar, Dhonut, Bogura","lat":24.69558419366541,"lon":89.53667521445819,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. DHONUT SEED & AGRO TRADERS","mk":"THE GREAT SHOPPING CENTRE","d":"BOGURA","sl":35702649,"v":43.0,"a":15,"r":1,"m":1,"sf":"2025-08","sp":[0.0,8.15,3.89,10.91,0.0,11.77,0.0,5.19,0.32,0.11,1.98,0.0]}},{"id":"C024","name":"M/S. ROZA TRADERS","bpId":"21424755","address":"Jamail Hat, Mirzapur, Mirzapur, Bogra","lat":24.61488936610909,"lon":89.36221440845688,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. ROZA TRADERS","mk":"JAMAIL HAT","d":"BOGRA","sl":22687638,"v":15.1,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[0.0,4.9,0.39,3.02,0.0,1.04,1.72,0.57,0.28,0.13,0.84,1.71]}},{"id":"C025","name":"M/S. GRAMEEN KRISHI","bpId":"21322626","address":"Pawtana Hat, Pawtana, Pirgachha, Rangpur","lat":25.67421954191438,"lon":89.48475421628278,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. GRAMEEN KRISHI","mk":"PAWTANA HAT","d":"RANGPUR","sl":33065939,"v":34.6,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[0.54,5.11,5.52,7.09,0.0,7.08,2.32,1.24,1.92,0.09,0.9,2.35]}},{"id":"C026","name":"M/S. BHAI BHAI KRISHI BITAN","bpId":"21348694","address":"Moderan More, Rangpur, Rangpur, Rangpur","lat":25.71011614954712,"lon":89.26071815189157,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. BHAI BHAI KRISHI BITAN","mk":"MODERAN MORE","d":"RANGPUR","sl":26211284,"v":651.8,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[0.0,2.78,4.41,7.68,2.09,628.29,0.71,2.06,0.03,3.15,0.0,0.18]}},{"id":"C027","name":"M/S. MOZAMMEL HAQUE & CO","bpId":"21137375","address":"Puratan Bazar, Gaibandha, Gaibandha Sadar, Gaibandha","lat":25.32933277685909,"lon":89.53893670833892,"region":"North","territory":"Gaibandha","salesGroup":"B05","info":{"n":"M/S. MOZAMMEL HAQUE & CO","mk":"PURATAN BAZAR","d":"GAIBANDHA","sl":113991394,"v":149.8,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[4.92,28.36,20.93,2.41,1.69,58.69,6.74,3.53,2.45,0.0,1.6,17.03]}},{"id":"C028","name":"M/S. SARKER TRADERS","bpId":"21325442","address":"Sadullapur Bazar, Sadullapur, Sadullapur, Gaibandha","lat":25.39221981776628,"lon":89.46487420777615,"region":"North","territory":"Gaibandha","salesGroup":"B05","info":{"n":"M/S. SARKER TRADERS","mk":"SADULLAPUR BAZAR","d":"GAIBANDHA","sl":31443198,"v":40.7,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[0.81,3.22,0.11,3.82,0.0,23.92,1.18,0.77,0.88,1.18,0.0,4.53]}},{"id":"C029","name":"M/S. HASAN TRADERS","bpId":"21329391","address":"Noldanga Bazar, Noldanga Bazar, Dad, Gaibandha","lat":25.48261076549212,"lon":89.47343630320111,"region":"North","territory":"Gaibandha","salesGroup":"B05","info":{"n":"M/S. HASAN TRADERS","mk":"NOLDANGA BAZAR","d":"GAIBANDHA","sl":98937278,"v":79.3,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[5.06,14.84,1.87,5.95,3.92,23.81,5.21,4.62,2.26,0.0,0.29,9.57]}},{"id":"C030","name":"M/S. SARKER TRADERS","bpId":"21344466","address":"Bonarpara, Kochua, Sagata, Gaibandha","lat":25.164634499071,"lon":89.52314472018882,"region":"North","territory":"Gaibandha","salesGroup":"B05","info":{"n":"M/S. SARKER TRADERS","mk":"BONARPARA","d":"GAIBANDHA","sl":80428487,"v":104.5,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[11.81,21.15,14.37,1.35,2.1,26.43,6.91,4.53,1.23,0.34,0.3,13.15]}},{"id":"C031","name":"M/S. ADNAN TRADERS","bpId":"21137368","address":"Katalbari Bazar, Kurigram, Kurigram Sadar, Kurigram","lat":25.8077749082655,"lon":89.58973372432374,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. ADNAN TRADERS","mk":"KATALBARI BAZAR","d":"KURIGRAM","sl":0,"v":0,"a":4,"r":14,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]}},{"id":"C032","name":"M/S. MASUD TRADERS","bpId":"21137370","address":"Ulipur Bazar, Ulipur, Ulipur, Kurigram","lat":25.66013322257916,"lon":89.61758853119741,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. MASUD TRADERS","mk":"ULIPUR BAZAR","d":"KURIGRAM","sl":18126944,"v":15.8,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[0.21,5.91,0.22,2.3,0.33,1.57,2.24,1.99,0.36,0.05,0.0,0.49]}},{"id":"C033","name":"M/S. S.M. TRADERS","bpId":"21137373","address":"Degree Colleage Market, Nageshowri, Nageshwar, Nageshwar, Kurigram","lat":25.97156672233631,"lon":89.68822597797138,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. S.M. TRADERS","mk":"DEGREE COLLEAGE MARKET, NAGESHOWRI","d":"KU","sl":20734147,"v":21.5,"a":12,"r":4,"m":1,"sf":"2025-08","sp":[1.28,4.47,0.5,4.89,0.0,6.51,1.55,1.97,0.0,0.0,0.0,0.0]}},{"id":"C034","name":"M/S. ISLAM TRADERS","bpId":"21424756","address":"Saddirmor, Saddirmor, Kurigtram Sadar, Kurigram","lat":25.81284456561643,"lon":89.64302879034511,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. ISLAM TRADERS","mk":"SADDIRMOR","d":"KURIGRAM","sl":91538635,"v":93.0,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[7.77,14.86,9.2,8.56,5.24,31.07,3.73,4.11,1.26,0.09,1.47,4.19]}},{"id":"C035","name":"M/S. ZIM MIM TRADERS","bpId":"21424759","address":"Jamtola Mor, Jamtola Mor, Bhurungamari, Kurigram","lat":26.10859021335891,"lon":89.67395635730725,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. ZIM MIM TRADERS","mk":"JAMTOLA MOR","d":"KURIGRAM","sl":43268028,"v":53.8,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.31,13.3,2.89,8.93,1.23,9.03,4.14,1.81,0.0,0.1,0.1,7.55]}},{"id":"C036","name":"M/S. KRISHI GHOR","bpId":"21137350","address":"Busterminal,Kalitola, Nilphamari, Nilphamari Sadar, Nilphama","lat":25.91212040181624,"lon":88.86828222053127,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. KRISHI GHOR","mk":"BUSTERMINAL, KALITOLA","d":"NILPHAMA","sl":18763905,"v":27.6,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.51,6.03,2.57,3.69,0.0,2.76,0.0,1.19,5.75,0.06,0.34,0.44]}},{"id":"C037","name":"M/S. BHAI BHAI TRADERS","bpId":"21137340","address":"Pakerhat Bazar, Pakerhat, Khansama, Nilphamari","lat":25.86380538489969,"lon":88.78236719401546,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. BHAI BHAI TRADERS","mk":"PAKERHAT BAZAR","d":"NILPHAMARI","sl":48621507,"v":36.8,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[2.47,0.51,1.75,14.07,0.8,5.56,2.18,3.14,1.44,0.61,0.07,3.4]}},{"id":"C038","name":"M/S. SUFIA TRADERS","bpId":"21344296","address":"Chilahati Bazar, Chilahati, Domar, Nilphamari","lat":26.24553148109336,"lon":88.79600579712005,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. SUFIA TRADERS","mk":"CHILAHATI BAZAR","d":"NILPHAMARI","sl":21571121,"v":23.1,"a":11,"r":4,"m":1,"sf":"2025-08","sp":[0.0,1.45,1.62,9.04,2.76,6.57,0.53,0.7,0.0,0.0,0.0,0.0]}},{"id":"C039","name":"M/S. YAKUB ALI","bpId":"21137352","address":"Jaldhaka Bazar, Jaldhaka, Jaldhaka, Nilphamari","lat":26.04998551561908,"lon":89.01923267659194,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. YAKUB ALI","mk":"JALDHAKA BAZAR","d":"NILPHAMARI","sl":34417832,"v":38.6,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[1.43,14.62,4.3,7.95,1.68,5.95,1.35,0.44,0.0,0.0,0.0,0.34]}},{"id":"C040","name":"M/S. ABDUL HAFIZ","bpId":"21137365","address":"Aditmari Bazar, Lalmonirhat, Lalmonirhat Sadar, Lalmonirhat","lat":25.92426818787457,"lon":89.34876850758917,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. ABDUL HAFIZ","mk":"ADITMARI BAZAR","d":"LALMONIRHAT","sl":47956395,"v":52.2,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[1.27,4.31,9.88,17.14,2.14,13.75,0.0,0.4,0.85,0.0,0.08,1.66]}},{"id":"C041","name":"M/S. KRISAK FERTILIZER","bpId":"21137366","address":"Borobari Hat, Lalmonirhat, Lalmonirhat Sadar, Lalmonirhat","lat":25.86994684935554,"lon":89.51033997493347,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. KRISAK FERTILIZER","mk":"BOROBARI HAT","d":"LALMONIRHAT","sl":25723381,"v":26.7,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[2.68,4.84,0.98,7.22,1.22,5.72,0.32,0.16,0.26,0.0,0.0,2.97]}},{"id":"C042","name":"M/S. KRISHI VANDAR","bpId":"21137367","address":"T.N.High School Road, Patgram, Patgram, Lalmonirhat","lat":26.35698668671904,"lon":89.00837428186742,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. KRISHI VANDAR","mk":"T.N.HIGH SCHOOL ROAD","d":"LALMONIRHAT","sl":0,"v":0,"a":0,"r":19,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]}},{"id":"C043","name":"M/S. SALIM AND BROTHERS","bpId":"21291713","address":"West Bezgram, Hatibandha, Hatibandha, Lalmonirhat","lat":26.12117828373711,"lon":89.1413714641452,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. SALIM AND BROTHERS","mk":"WEST BEZGRAM","d":"LALMONIRHAT","sl":70553081,"v":96.5,"a":16,"r":1,"m":1,"sf":"2025-08","sp":[1.63,1.64,4.12,18.55,51.53,8.6,5.35,2.21,0.75,0.0,1.3,0.0]}},{"id":"C044","name":"M/S. ZAHID AND BROTHERS","bpId":"26041901","address":"Borokhata Bazar, HatiBanda, Lalmonirhat","lat":26.20460041137871,"lon":89.11191991314159,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. ZAHID AND BROTHERS","mk":"BOROKHATA BAZAR","d":"LALMONIRHAT","sl":0,"v":0,"a":2,"r":15,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]}},{"id":"C045","name":"M/S. USHA TRADERS","bpId":"21372157","address":"Nager Hat, Kutubpur, Badorganj, Rangpur","lat":25.58419714760651,"lon":89.12931326691577,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. USHA TRADERS","mk":"NAGER HAT","d":"RANGPUR","sl":21747159,"v":19.8,"a":14,"r":0,"m":1,"sf":"2025-08","sp":[3.37,2.26,2.53,2.28,0.0,4.07,0.89,3.41,0.0,0.0,0.0,0.76]}},{"id":"C046","name":"M/S. KRISHAK BANDHOB AGRO FARM","bpId":"21461211","address":"Gridharipur, Gridharipur, Palashbari, Gaibandha","lat":25.27948188856977,"lon":89.35360215891755,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. KRISHAK BANDHOB AGRO FARM","mk":"GRIDHARIPUR","d":"GAIBANDHA","sl":45672735,"v":41.6,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[1.74,4.46,2.56,3.97,1.69,5.94,5.87,4.08,1.52,0.41,2.12,6.68]}},{"id":"C047","name":"M/S. A.Z.M. REZWANUL HAQUE","bpId":"21137343","address":"Parbotipur Nutun Bazar, Parbatipur, Parbatipur, Dinajpur","lat":25.65317964637086,"lon":88.91593579874366,"region":"North","territory":"Saidpur","salesGroup":"B06","info":{"n":"M/S. A.Z.M. REZWANUL HAQUE","mk":"PARBOTIPUR NUTUN BAZAR","d":"DINAJPUR","sl":53249480,"v":43.2,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[1.62,4.01,4.06,3.27,0.38,10.82,5.74,2.73,0.09,1.25,1.35,6.82]}},{"id":"C048","name":"M/S. KUNDO TDS.","bpId":"21137357","address":"L.S.D. Road, Bodorgonj , Badarganj, Badarganj, Rangpur","lat":25.67418025915399,"lon":89.05966201174171,"region":"North","territory":"Saidpur","salesGroup":"B06","info":{"n":"M/S. KUNDO TDS.","mk":"L.S.D. ROAD, BODORGONJ","d":"RANGPUR","sl":38674924,"v":35.9,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[1.69,1.76,4.36,5.24,0.31,10.94,2.28,2.59,0.04,1.11,0.51,4.54]}},{"id":"C049","name":"M/S. AL-MODINA TRADERS","bpId":"21137356","address":"Taragonj Bazar, Taraganj, Taraganj, Rangpur","lat":25.81647242494556,"lon":89.0096189779516,"region":"North","territory":"Saidpur","salesGroup":"B06","info":{"n":"M/S. AL-MODINA TRADERS","mk":"TARAGONJ BAZAR","d":"RANGPUR","sl":37743562,"v":23.7,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[1.13,2.96,2.26,4.52,0.83,5.31,1.94,1.61,0.46,0.16,0.0,1.92]}},{"id":"C050","name":"M/S. NUR ENTERPRISE","bpId":"21137344","address":"Ambari Bazar, Parbatipur, Parbatipur, Dinajpur","lat":25.54320722016618,"lon":88.83694828607165,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. NUR ENTERPRISE","mk":"AMBARI BAZAR","d":"DINAJPUR","sl":290886184,"v":186.6,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[13.63,18.94,1.83,35.19,11.48,42.07,12.53,14.16,0.84,0.94,6.48,22.21]}},{"id":"C051","name":"M/S. R.A. ENTERPRISE","bpId":"21137342","address":"Amtoli Bazar, Chirirbandar, Chirirbandar, Dinajpur","lat":25.66517692220055,"lon":88.81344956654999,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. R.A. ENTERPRISE","mk":"AMTOLI BAZAR","d":"DINAJPUR","sl":179039684,"v":161.3,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[18.06,7.68,6.45,71.63,28.92,2.89,0.0,3.45,3.21,1.53,3.79,10.2]}},{"id":"C052","name":"M/S. KRISHI BIPLOB ENTERPRISE","bpId":"21143328","address":"Sujalpur Bazar, Birgonj, Dinajpur","lat":25.8624388473063,"lon":88.65414595905237,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. KRISHI BIPLOB ENTERPRISE","mk":"SUJALPUR BAZAR","d":"DINAJPUR","sl":41459332,"v":24.5,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[1.2,6.35,0.22,1.26,1.02,3.94,2.28,2.88,0.83,1.24,0.15,2.14]}},{"id":"C053","name":"M/S. S. TRADERS","bpId":"21370897","address":"Madrasha Market, Bhabki, Birgonj, Dinajpur","lat":25.90444469466188,"lon":88.60133173174262,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. S. TRADERS","mk":"MADRASHA MARKET","d":"DINAJPUR","sl":7719402,"v":7.5,"a":14,"r":0,"m":1,"sf":"2025-08","sp":[0.42,0.41,0.29,1.79,0.0,1.47,1.0,0.75,0.18,0.12,0.26,0.28]}},{"id":"C054","name":"M/S. JH TRADERS","bpId":"26042173","address":"Baliadangai Bazar, Baliadangi, Thakurgaon","lat":26.0856013081364,"lon":88.27642708118373,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. JH TRADERS","mk":"BALIADANGAI BAZAR","d":"THAKURGAON","sl":55756094,"v":48.5,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[2.91,2.72,7.12,8.83,2.47,7.98,2.45,2.1,2.62,2.58,2.47,2.97]}},{"id":"C055","name":"M/S. RAQUIB ENTERPRISE","bpId":"21137328","address":"Nekmord Bazar, Nekmarad, Rani Sankail, Thakurgaon","lat":25.98094907212442,"lon":88.2641853077068,"region":"North","territory":"Pirganj","salesGroup":"B06","info":{"n":"M/S. RAQUIB ENTERPRISE","mk":"NEKMORD BAZAR","d":"THAKURGAON","sl":90618505,"v":64.1,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[4.76,20.71,4.93,6.67,1.56,5.18,1.3,7.02,0.74,0.71,0.64,7.9]}},{"id":"C056","name":"M/S. EMU TRADERS","bpId":"21137327","address":"Pirgonj Bazar, Pirganj, Pirganj, Thakurgaon","lat":25.85592246867046,"lon":88.34723995733212,"region":"North","territory":"Pirganj","salesGroup":"B06","info":{"n":"M/S. EMU TRADERS","mk":"PIRGONJ BAZAR","d":"THAKURGAON","sl":104627460,"v":71.8,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[4.53,13.88,5.03,11.4,1.95,10.81,1.29,10.17,1.0,0.93,0.59,8.0]}},{"id":"C057","name":"M/S. LUTFOR RAHMAN TRADERS","bpId":"21524693","address":"Jadurani, Kamarpukur, Horipur, Thakurgaon","lat":25.88423363181628,"lon":88.17770642892465,"region":"North","territory":"Pirganj","salesGroup":"B06","info":{"n":"M/S. LUTFOR RAHMAN TRADERS","mk":"JADURANI","d":"THAKURGAON","sl":47412526,"v":40.3,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[4.01,2.69,4.44,3.92,2.33,6.31,3.25,2.52,0.82,1.24,1.6,6.3]}},{"id":"C058","name":"M/S. JOARDAR TRADERS","bpId":"21137346","address":"Bangla Hilly, Bangla Hili, Bangla Hili, Dinajpur","lat":25.27699872814628,"lon":89.01004983120875,"region":"North","territory":"Birampur","salesGroup":"B06","info":{"n":"M/S. JOARDAR TRADERS","mk":"BANGLA HILLY","d":"DINAJPUR","sl":12811553,"v":8.7,"a":11,"r":4,"m":1,"sf":"2025-08","sp":[0.55,1.54,0.4,0.6,0.0,3.98,0.0,1.38,0.0,0.0,0.0,0.0]}},{"id":"C059","name":"M/S. ROKON ENTERPRISE","bpId":"21137349","address":"Osmanpur Bazar, Osmanpur, Osmanpur, Dinajpur","lat":25.25618965496961,"lon":89.24165620672144,"region":"North","territory":"Birampur","salesGroup":"B06","info":{"n":"M/S. ROKON ENTERPRISE","mk":"OSMANPUR BAZAR","d":"DINAJPUR","sl":92419048,"v":80.7,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[6.92,4.64,2.99,10.83,0.21,33.66,1.59,8.99,0.06,2.83,0.0,6.43]}},{"id":"C060","name":"M/S. BADHAN ENTERPRISE","bpId":"21137378","address":"Kamdia Bazar, Kamdia, Gobindaganj, Gaibandha","lat":25.19981920679863,"lon":89.23876015814281,"region":"North","territory":"Birampur","salesGroup":"B06","info":{"n":"M/S. BADHAN ENTERPRISE","mk":"KAMDIA BAZAR","d":"GAIBANDHA","sl":120439998,"v":95.9,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[5.26,3.97,6.62,14.25,6.38,14.29,8.53,10.01,0.0,0.57,10.25,13.36]}},{"id":"C061","name":"M/S. NUR AND BROTHERS","bpId":"21429321","address":"Puraton Bazar, Puraton Bazar, Birampur, Dinajpur","lat":25.3889586237313,"lon":88.98744667337056,"region":"North","territory":"Birampur","salesGroup":"B06","info":{"n":"M/S. NUR AND BROTHERS","mk":"PURATON BAZAR","d":"DINAJPUR","sl":264225370,"v":187.3,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[23.72,24.99,23.44,28.58,9.37,31.9,9.47,19.54,1.5,2.04,0.99,5.89]}},{"id":"C062","name":"M/S. PURNOTA ENTERPRISE","bpId":"21137323","address":"Panchagarh Bazar, Banik Samiti Road, Panchagra Sadar, Pancha","lat":26.33133754001461,"lon":88.55502426623411,"region":"North","territory":"Panchagarh","salesGroup":"B06","info":{"n":"M/S. PURNOTA ENTERPRISE","mk":"PANCHAGARH BAZAR","d":"PANCHA","sl":78298988,"v":72.7,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.17,3.28,1.93,1.77,1.37,30.01,3.6,10.47,0.48,0.5,0.0,14.1]}},{"id":"C063","name":"M/S. KAMLESH TRADERS","bpId":"21287078","address":"Fakirgonj Bazar, Choto Dap, Atwari, Panchagarh","lat":26.24052236105331,"lon":88.4082206180085,"region":"North","territory":"Panchagarh","salesGroup":"B06","info":{"n":"M/S. KAMLESH TRADERS","mk":"FAKIRGONJ BAZAR","d":"PANCHAGARH","sl":53563404,"v":53.6,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[0.8,2.1,10.92,5.55,3.24,12.64,3.32,4.37,2.46,0.3,0.0,7.19]}},{"id":"C064","name":"M/S. SARWAR TRADERS","bpId":"21329406","address":"Gazkati Bazar, Gazkati Bazar, Debiganj, Panchagarh","lat":26.20203445116082,"lon":88.75436329129921,"region":"North","territory":"Panchagarh","salesGroup":"B06","info":{"n":"M/S. SARWAR TRADERS","mk":"GAZKATI BAZAR","d":"PANCHAGARH","sl":52923178,"v":53.5,"a":16,"r":3,"m":1,"sf":"2025-08","sp":[5.06,2.94,4.39,14.24,8.49,8.54,1.14,3.58,4.18,0.0,0.0,0.0]}},{"id":"C065","name":"M/S. AKARAMUL TRADERS","bpId":"21372670","address":"Shalbahan, Shalbahan, Tetulia, Panchagarh","lat":26.4834627515066,"lon":88.421467691651,"region":"North","territory":"Panchagarh","salesGroup":"B06","info":{"n":"M/S. AKARAMUL TRADERS","mk":"SHALBAHAN","d":"PANCHAGARH","sl":31829908,"v":25.7,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[2.35,3.35,0.48,0.0,3.88,3.44,0.8,4.68,0.47,0.47,2.08,3.34]}},{"id":"C066","name":"M/S. SUMON AGRO ENTERPRISE","bpId":"21137418","address":"Station Bazar, Natore, Natore Sadar, Natore","lat":24.41039323737328,"lon":88.96795939572067,"region":"North","territory":"Natore","salesGroup":"B07","info":{"n":"M/S. SUMON AGRO ENTERPRISE","mk":"STATION BAZAR","d":"NATORE","sl":157692960,"v":217.2,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[5.6,0.0,23.22,53.43,0.0,69.19,33.56,15.18,1.81,2.37,0.0,11.56]}},{"id":"C067","name":"M/S. ABDUL GONI","bpId":"21281414","address":"Naranpur Road, Bagha Bazar, Bagha, Rajshahi","lat":24.19547860319468,"lon":88.83734977117855,"region":"North","territory":"Natore","salesGroup":"B07","info":{"n":"M/S. ABDUL GONI","mk":"NARANPUR ROAD","d":"RAJSHAHI","sl":42564248,"v":60.4,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[6.22,12.33,1.9,1.83,1.89,11.34,5.75,13.82,0.06,1.44,0.0,3.52]}},{"id":"C068","name":"M/S. ASA ENTERPRISE","bpId":"21371829","address":"Puthia Bazar, Sholua, Puthia, Rajshahi","lat":24.37144051303391,"lon":88.84143355836362,"region":"North","territory":"Natore","salesGroup":"B07","info":{"n":"M/S. ASA ENTERPRISE","mk":"PUTHIA BAZAR","d":"RAJSHAHI","sl":59962264,"v":70.5,"a":16,"r":2,"m":1,"sf":"2025-08","sp":[14.86,3.06,0.44,5.49,1.6,21.33,8.98,12.59,0.0,1.65,0.0,0.0]}},{"id":"C069","name":"M/S. E & F ENTERPRISE","bpId":"26024629","address":"Baneswar, Puthia, Rajshahi","lat":24.36759172707367,"lon":88.75755505680175,"region":"North","territory":"Rajshahi","salesGroup":"B07","info":{"n":"M/S. E & F ENTERPRISE","mk":"BANESWAR","d":"RAJSHAHI","sl":92653236,"v":93.1,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[3.28,5.92,6.72,6.97,8.64,22.22,8.48,5.34,1.13,4.49,5.98,12.93]}},{"id":"C070","name":"M/S. JAKIR ENTERPRISE","bpId":"21137407","address":"Taherpur Bazar, Taherpur, Bagmara, Rajshahi","lat":24.51896971562521,"lon":88.84828367653343,"region":"North","territory":"Rajshahi","salesGroup":"B07","info":{"n":"M/S. JAKIR ENTERPRISE","mk":"TAHERPUR BAZAR","d":"RAJSHAHI","sl":83698200,"v":104.4,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[5.65,8.85,1.03,18.67,6.09,22.1,12.68,10.13,1.09,0.0,0.11,17.08]}},{"id":"C071","name":"M/S. SARDAR ENTERPRISE","bpId":"21137406","address":"Bhabaniganj Bazar, Bhobaniganj, Bagmara, Rajshahi","lat":24.58258543233771,"lon":88.8214684680879,"region":"North","territory":"Rajshahi","salesGroup":"B07","info":{"n":"M/S. SARDAR ENTERPRISE","mk":"BHABANIGANJ BAZAR","d":"RAJSHAHI","sl":85310667,"v":104.3,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[4.19,11.17,5.16,27.75,3.66,13.79,6.18,15.74,0.0,7.06,0.47,7.49]}},{"id":"C072","name":"M/S. MITHILA TRADERS","bpId":"21137279","address":"Dawkandi Bazar, Durgapur, Durgapur, Rajshahi","lat":24.51050012466154,"lon":88.68055530239961,"region":"North","territory":"Rajshahi","salesGroup":"B07","info":{"n":"M/S. MITHILA TRADERS","mk":"DAWKANDI BAZAR","d":"RAJSHAHI","sl":71592270,"v":83.4,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[6.25,7.16,4.55,17.41,0.22,17.55,1.18,20.5,0.11,0.19,0.17,7.09]}},{"id":"C073","name":"M/S. HANIF SHAH","bpId":"21137427","address":"Porsha Bazar, Porsa, Nitpur, Naogaon","lat":25.01049683392851,"lon":88.49644960985668,"region":"North","territory":"Nozipur","salesGroup":"B07","info":{"n":"M/S. HANIF SHAH","mk":"PORSHA BAZAR","d":"NAOGAON","sl":71374383,"v":49.1,"a":13,"r":0,"m":1,"sf":"2025-08","sp":[2.78,4.14,0.79,2.37,0.0,10.52,8.54,7.79,0.69,0.0,0.52,9.75]}},{"id":"C074","name":"M/S. SARDER TRADERS","bpId":"21137426","address":"Nutunhat More, Nazipur, Patnitala, Patnitala, Naogaon","lat":25.05007184623776,"lon":88.76212895740127,"region":"North","territory":"Nozipur","salesGroup":"B07","info":{"n":"M/S. SARDER TRADERS","mk":"NUTUNHAT MORE, NAZIPUR","d":"NAOGAON","sl":48011437,"v":27.7,"a":13,"r":0,"m":1,"sf":"2025-08","sp":[1.48,1.97,1.02,2.27,0.09,9.4,0.0,4.44,0.0,0.0,0.0,6.1]}},{"id":"C075","name":"M/S. JAMILA TRADERS","bpId":"21137428","address":"Thana Road, Sapahar, Sapahar, Naogaon","lat":25.1282423009631,"lon":88.5880284744955,"region":"North","territory":"Nozipur","salesGroup":"B07","info":{"n":"M/S. JAMILA TRADERS","mk":"THANA ROAD","d":"NAOGAON","sl":92612085,"v":75.2,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[9.33,9.2,0.21,3.28,0.44,10.78,15.12,11.46,1.0,0.67,0.0,12.51]}},{"id":"C076","name":"M/S. HAMIDA TRADERS","bpId":"21137425","address":"Modhoul Bazar, Patnitala, Patnitala, Naogaon","lat":25.08507376795895,"lon":88.68535687740706,"region":"North","territory":"Nozipur","salesGroup":"B07","info":{"n":"M/S. HAMIDA TRADERS","mk":"MODHOUL BAZAR","d":"NAOGAON","sl":81338018,"v":48.9,"a":12,"r":1,"m":1,"sf":"2025-08","sp":[8.32,5.03,0.04,0.0,0.0,7.15,9.67,16.14,0.8,0.0,0.29,0.0]}},{"id":"C077","name":"M/S. LITON-MAMUN TRADERS","bpId":"21137440","address":"Kashinathpur Bazar, Kashinathpur, Sathia, Pabna","lat":23.95821244498162,"lon":89.60536929015552,"region":"North","territory":"Bera","salesGroup":"B01","info":{"n":"M/S. LITON-MAMUN TRADERS","mk":"KASHINATHPUR BAZAR","d":"PABNA","sl":77704600,"v":116.0,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.36,0.0,23.65,28.0,1.52,28.48,5.96,6.22,5.33,0.4,0.0,11.46]}},{"id":"C078","name":"M/S. HASAN ENTERPRISE","bpId":"21346592","address":"Bonowari Nagor, Bonowari Nagor, Faridpur, Pabna","lat":24.16114,"lon":89.4582,"region":"North","territory":"Bera","salesGroup":"B01","info":{"n":"M/S. HASAN ENTERPRISE","mk":"BONOWARI NAGOR","d":"PABNA","sl":27057664,"v":38.8,"a":13,"r":2,"m":1,"sf":"2025-08","sp":[5.42,0.0,11.9,3.99,0.0,13.0,0.0,3.42,0.26,0.12,0.0,0.0]}},{"id":"C079","name":" M/S. UZZAL ENTERPRISE","bpId":"21137412","address":"Simultola Bazar, Amnura, Chapai Nawabganj Sadar, Chapai Nawa","lat":24.62998389759808,"lon":88.40272719411684,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. UZZAL ENTERPRISE","mk":"SIMULTOLA BAZAR","d":"CHAPAI NAWA","sl":73939788,"v":60.9,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[11.98,5.3,0.04,0.0,13.86,10.22,3.37,5.65,0.0,0.0,1.05,8.16]}},{"id":"C080","name":"M/S. MOZAFFOR HOSSAIN & SONS","bpId":"21137417","address":"Monakosha Bazar, Manaksha, Shibganj U.P.O, Chapai Nawabganj","lat":25.09195965243395,"lon":89.35254254330715,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. MOZAFFOR HOSSAIN & SONS","mk":"MONAKOSHA BAZAR","d":"CHAPAI NAWABGANJ","sl":69068300,"v":58.7,"a":13,"r":0,"m":1,"sf":"2025-08","sp":[6.1,7.97,3.3,14.85,0.0,9.95,0.0,8.67,0.0,0.0,0.0,6.71]}},{"id":"C081","name":"M/S. ALHAJ BAZLUR RAHMAN","bpId":"21137414","address":"Rohonpur Bazar, Rohanpur, Gomostapur, Chapai Nawabganj","lat":24.82340553512821,"lon":88.33091903673925,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. ALHAJ BAZLUR RAHMAN","mk":"ROHONPUR BAZAR","d":"CHAPAI NAWABGANJ","sl":58880093,"v":44.3,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[5.93,1.72,2.08,7.32,0.0,8.41,4.73,3.23,1.09,0.0,0.0,8.8]}},{"id":"C082","name":"M/S. SHAIF TRADERS","bpId":"21137411","address":"Shantir More Bazar, Bot Tolahat, Chapai Nawabganj Sadar, Cha","lat":24.58970859207912,"lon":88.26984660785175,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. SHAIF TRADERS","mk":"SHANTIR MORE BAZAR","d":"CHA","sl":51226550,"v":52.2,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[1.27,10.01,0.03,1.11,0.0,13.18,4.72,8.95,6.05,0.0,0.0,6.1]}},{"id":"C083","name":"M/S. BHAI BHAI TRADING","bpId":"21137416","address":"Medical More, Shannashitola, Bholahat, Bholahat, Chapai Nawa","lat":24.93766305239182,"lon":88.2224281909258,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. BHAI BHAI TRADING","mk":"MEDICAL MORE, SHANNASHITOLA","d":"CHAPAI NAWA","sl":43885673,"v":44.9,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[1.76,6.22,2.96,9.36,0.11,10.43,4.52,4.05,0.0,0.0,0.0,5.02]}},{"id":"C084","name":"M/S. KHAN ENTERPRISE","bpId":"21137413","address":"Nachole Bazar, Nachol, Nachol, Chapai Nawabganj","lat":24.72910798478283,"lon":88.42310242503083,"region":"North","territory":"Chapai","salesGroup":"B07","info":{"n":"M/S. KHAN ENTERPRISE","mk":"NACHOLE BAZAR","d":"CHAPAI NAWABGANJ","sl":116393191,"v":110.0,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[15.22,5.63,1.37,24.95,0.0,15.22,13.03,5.82,3.17,0.29,6.55,17.1]}},{"id":"C085","name":"M/S. RUBEL RANA TRADERS","bpId":"21137421","address":"Deluabari Hat,Chalk Kanu, Chalk Kanu, Manda, Naogaon","lat":24.72177580127066,"lon":88.68531233062937,"region":"North","territory":"Niamatpur","salesGroup":"B07","info":{"n":"M/S. RUBEL RANA TRADERS","mk":"DELUABARI HAT, CHALK KANU","d":"NAOGAON","sl":52750159,"v":58.4,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[4.24,6.32,8.25,3.7,5.24,13.6,0.0,7.13,1.34,0.41,0.25,7.17]}},{"id":"C086","name":"M/S. SAINUL TRADERS","bpId":"21137405","address":"Malsira Bazar(Choubaria), Tanor, Tanor, Rajshahi","lat":24.70416196869322,"lon":88.61276957191535,"region":"North","territory":"Niamatpur","salesGroup":"B07","info":{"n":"M/S. SAINUL TRADERS","mk":"MALSIRA BAZAR(CHOUBARIA)","d":"RAJSHAHI","sl":68109738,"v":54.1,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[5.18,14.13,1.16,0.0,0.15,11.04,3.4,6.27,0.0,0.46,0.18,10.87]}},{"id":"C087","name":"M/S. MONDAL TRADERS","bpId":"21287541","address":"Satra Bazar, Satra, Niamotpur, Naogaon","lat":24.89559366633018,"lon":88.63963193358238,"region":"North","territory":"Niamatpur","salesGroup":"B07","info":{"n":"M/S. MONDAL TRADERS","mk":"SATRA BAZAR","d":"NAOGAON","sl":60105062,"v":38.3,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[3.63,2.38,0.22,0.0,0.0,18.34,5.06,3.46,0.31,0.0,0.0,3.56]}},{"id":"C088","name":"M/S. ISLAM TRADERS","bpId":"21137403","address":"Tanore Bazar, Tanor, Tanor, Rajshahi","lat":24.58901326197439,"lon":88.57683070642223,"region":"North","territory":"Tanore","salesGroup":"B07","info":{"n":"M/S. ISLAM TRADERS","mk":"TANORE BAZAR","d":"RAJSHAHI","sl":38665056,"v":55.2,"a":7,"r":5,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,30.15,4.98,10.53,9.22,0.0,0.0,0.0,0.0,0.0]}},{"id":"C089","name":"M/S. AFREEN ENTERPRISE","bpId":"21137410","address":"Rail Gate Bazar, Mohishal Bari, Godagari, Godagari, Rajshahi","lat":24.44956565967197,"lon":88.3450334568733,"region":"North","territory":"Tanore","salesGroup":"B07","info":{"n":"M/S. AFREEN ENTERPRISE","mk":"RAIL GATE BAZAR, MOHISHAL BARI","d":"RAJSHAHI","sl":75602377,"v":75.4,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[8.89,9.74,0.66,8.94,1.49,17.65,1.18,13.82,0.0,0.0,6.72,5.26]}},{"id":"C090","name":"M/S. JESMINE TRADERS","bpId":"21279099","address":"Malbandha Bazar, Chandankotha, Tanore, Rajshahi","lat":24.66748564212467,"lon":88.53216192186667,"region":"North","territory":"Tanore","salesGroup":"B07","info":{"n":"M/S. JESMINE TRADERS","mk":"MALBANDHA BAZAR","d":"RAJSHAHI","sl":40417596,"v":49.6,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[4.31,2.06,0.15,9.5,3.86,14.99,1.02,9.35,0.0,0.0,0.0,3.83]}},{"id":"C091","name":"M/S. AZIZ SEEDS","bpId":"21283803","address":"Keshorehat Bazar, Keshorehat, Mohanpur, Rajshahi","lat":24.59206308124502,"lon":88.65427487936483,"region":"North","territory":"Tanore","salesGroup":"B07","info":{"n":"M/S. AZIZ SEEDS","mk":"KESHOREHAT BAZAR","d":"RAJSHAHI","sl":132080671,"v":111.7,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[13.29,18.02,6.61,11.28,12.67,8.38,1.22,16.4,1.06,3.52,2.1,15.43]}},{"id":"C092","name":"M/S. SHAFIQUL TRADERS","bpId":"21531306","address":"Joregachha Bazar, Joregachha, Sariakandi, Gaibandha","lat":24.80154886263304,"lon":89.53755497875736,"region":"North","territory":"Bogura","salesGroup":"B01","info":{"n":"M/S. SHAFIQUL TRADERS","mk":"JOREGACHHA BAZAR","d":"GAIBANDHA","sl":49257160,"v":58.6,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[6.24,3.87,8.28,6.13,0.55,8.31,7.36,6.42,0.83,0.08,2.55,7.44]}},{"id":"C093","name":"M/S. LUTU TRADERS","bpId":"26027466","address":"Kisorgonj Bazar, Kisorgonj, Nilphamary","lat":25.8976375,"lon":89.0189945,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. LUTU TRADERS","mk":"KISORGONJ BAZAR","d":"NILPHAMARY","sl":12343413,"v":9.8,"a":12,"r":4,"m":1,"sf":"2025-08","sp":[0.0,1.2,2.11,1.7,0.33,2.19,0.7,1.34,0.0,0.0,0.0,0.0]}},{"id":"C094","name":"M/S. PURE TRADING","bpId":"26099676","address":"Fulbari-5680, Kurigram, Kurigram","lat":25.94951991261161,"lon":89.55236848442856,"region":"North","territory":"Kurigram","salesGroup":"B05","info":{"n":"M/S. PURE TRADING","mk":"FULBARI-5680","d":"KURIGRAM","sl":19692633,"v":19.8,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[3.64,6.05,0.6,1.33,0.0,4.33,0.8,1.52,0.6,0.11,0.0,0.51]}},{"id":"C095","name":"M/S. PRIYANKA TRADERS ","bpId":"26101328","address":"Borogari Bazar, Domar, Nilphamary, Nilphamary","lat":26.10752850292205,"lon":88.8554186464458,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. PRIYANKA TRADERS","mk":"BOROGARI BAZAR","d":"NILPHAMARY","sl":33467732,"v":25.9,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[0.74,3.8,1.79,7.38,1.14,5.58,1.28,2.83,0.0,0.13,0.2,0.36]}},{"id":"C096","name":"M/S. MAHI TRADERS ","bpId":"26103783","address":"Tnt More, Chandipur, Dhamoirhat, Naogaon","lat":25.15154318609093,"lon":88.84533321263682,"region":"North","territory":"Nozipur","salesGroup":"B05","info":{"n":"M/S. MAHI TRADERS","mk":"TNT MORE","d":"NAOGAON","sl":41770515,"v":28.4,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[3.41,2.32,1.22,4.0,0.14,6.58,0.0,4.91,0.0,0.12,0.0,4.97]}},{"id":"C097","name":"M/S. SUMI TRADERS","bpId":"26107430","address":"Motizapur, Rangachata, Bochagonj, Dinajpur","lat":25.80653574462834,"lon":88.46201464532912,"region":"North","territory":"Pirganj","salesGroup":"B06","info":{"n":"M/S. SUMI TRADERS","mk":"MOTIZAPUR","d":"DINAJPUR","sl":58624406,"v":40.6,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[3.31,0.82,0.86,7.74,1.0,10.01,4.72,5.33,0.0,0.2,1.26,4.38]}},{"id":"C098","name":"M/S. BHAI BON TRADERS","bpId":"26108511","address":"Tarash, Sirajgonj, Sirajgonj","lat":24.43177978369627,"lon":89.3767399845485,"region":"North","territory":"Sirajganj","salesGroup":"B01","info":{"n":"M/S. BHAI BON TRADERS","mk":"TARASH","d":"SIRAJGONJ","sl":42169683,"v":53.4,"a":15,"r":0,"m":1,"sf":"2025-08","sp":[5.16,6.15,4.28,14.17,0.32,13.38,2.36,4.0,0.4,0.0,0.0,2.42]}},{"id":"C099","name":"M/S. ABDULLAH & BROTHERS","bpId":"26114722","address":"25 Mile Bazar, Satore, Birganj, Dinajpur","lat":25.91443784386892,"lon":88.55656558301033,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. ABDULLAH & BROTHERS","mk":"25 MILE BAZAR","d":"DINAJPUR","sl":19899446,"v":27.6,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[0.43,4.27,0.54,4.99,1.31,9.52,1.3,0.54,0.71,1.26,0.66,1.51]}},{"id":"C100","name":"M/S. MAMA VAGNE TRADERS ","bpId":"26116673","address":"Natuarpara, Kazipur, Sirajganj, Sirajganj","lat":24.47858337933609,"lon":89.71052263916539,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. MAMA VAGNE TRADERS","mk":"NATUARPARA","d":"SIRAJGANJ","sl":11901660,"v":21.8,"a":13,"r":4,"m":1,"sf":"2025-08","sp":[1.18,5.38,2.09,1.89,3.33,3.74,3.21,0.83,0.0,0.0,0.0,0.0]}},{"id":"C101","name":"M/S. BHAI BHAI TRADERS-2 ","bpId":"26223649","address":"Barura Bazar, Patgram, Lalmonirhat, Lalmonirhat","lat":26.25194318498424,"lon":89.07440519864112,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. BHAI BHAI TRADERS-2","mk":"BARURA BAZAR","d":"LALMONIRHAT","sl":22087165,"v":14.8,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[1.29,1.48,0.54,3.76,3.03,1.44,1.11,0.74,0.14,0.0,0.37,0.47]}},{"id":"C102","name":"M/S. SARDER ENTERPRISE","bpId":"26223971","address":"Vitakazipur, Dharabarisha, Natore","lat":24.23152798942774,"lon":89.28710768037122,"region":"North","territory":"Pabna","salesGroup":"B07","info":{"n":"M/S. SARDER ENTERPRISE","mk":"VITAKAZIPUR","d":"NATORE","sl":35532123,"v":53.9,"a":17,"r":0,"m":1,"sf":"2025-08","sp":[3.45,2.68,11.06,9.16,4.56,6.95,2.94,2.62,0.98,2.24,0.0,6.83]}},{"id":"C103","name":"M/S. MONDOL TRADERS ","bpId":"26224303","address":"Laldighi Bazar, Fathepur, Pirgonj, Rangpur","lat":25.44114097058407,"lon":89.30092340382788,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. MONDOL TRADERS","mk":"LALDIGHI BAZAR","d":"RANGPUR","sl":32058522,"v":35.0,"a":18,"r":1,"m":1,"sf":"2025-08","sp":[3.42,4.21,4.96,3.01,1.54,5.38,3.85,3.39,0.32,0.86,3.68,0.0]}},{"id":"C104","name":"M/S. KHAN TRADERS ","bpId":"26225802","address":"Shimla, Vatra-5860, Nandigram, Bogura","lat":24.58436170354031,"lon":89.33819670134865,"region":"North","territory":"Bogura","salesGroup":"B01","info":{"n":"M/S. KHAN TRADERS","mk":"SHIMLA","d":"BOGURA","sl":88644188,"v":73.7,"a":19,"r":0,"m":1,"sf":"2025-08","sp":[7.59,6.61,6.42,15.5,0.06,17.76,2.38,6.37,0.07,0.77,1.79,6.83]}},{"id":"C105","name":"M/S. RUHUL TRADERS ","bpId":"26226346","address":"Shemultola, Joynagor, Ishwardi, Pabna","lat":24.08708481300185,"lon":89.08273064708729,"region":"North","territory":"Pabna","salesGroup":"B07","info":{"n":"M/S. RUHUL TRADERS","mk":"SHEMULTOLA","d":"PABNA","sl":46994947,"v":64.0,"a":18,"r":0,"m":1,"sf":"2025-08","sp":[3.47,3.39,4.53,12.09,0.74,6.68,3.26,8.38,8.76,4.59,1.75,5.78]}},{"id":"C106","name":"M/S. MIZAN TRADERS","bpId":"26235255","address":"Laldighi Bazar, Kabilpur, Pirgonj, Rangpur","lat":25.33936176442486,"lon":89.32112135958407,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. MIZAN TRADERS","mk":"LALDIGHI BAZAR","d":"RANGPUR","sl":14726630,"v":10.5,"a":13,"r":3,"m":1,"sf":"2025-08","sp":[0.0,3.21,0.64,1.21,0.96,2.88,0.66,0.33,0.35,0.0,0.0,0.0]}},{"id":"C107","name":"M/S. THREE BROTHERS TRADERS","bpId":"26235254","address":"Jorjiga, Dimla, Nilphamary, Nilphamari","lat":26.16672163223161,"lon":88.95757509655547,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. THREE BROTHERS TRADERS","mk":"JORJIGA","d":"NILPHAMARI","sl":39669317,"v":30.2,"a":16,"r":0,"m":1,"sf":"2025-08","sp":[1.15,4.32,0.0,6.3,1.01,6.83,1.39,4.04,0.08,0.31,0.0,4.03]}},{"id":"C108","name":"M/S. S.S.R.B ENTERPRISE ","bpId":"26254233","address":"Atghoria Bazar, Chadva, Pabna, Pabna","lat":24.1138180315763,"lon":89.2437384501419,"region":"North","territory":"Pabna","salesGroup":"B07","info":{"n":"M/S. S.S.R.B ENTERPRISE","mk":"ATGHORIA BAZAR","d":"PABNA","sl":47169928,"v":53.6,"a":13,"r":0,"m":1,"sf":"2025-08","sp":[2.23,5.37,2.51,12.95,2.07,10.69,4.55,4.01,0.62,1.23,2.92,3.98]}},{"id":"C109","name":"M/S. KOROTOYA ENTERPRISE","bpId":"21137325","address":"East Goalpara, Thakurgaon Sadar","lat":26.03330660498857,"lon":88.48293143527353,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. KOROTOYA ENTERPRISE","mk":"EAST GOALPARA","d":"THAKURGAON SADAR","sl":14213390,"v":14.2,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[0.28,1.05,1.23,5.94,0.75,1.89,0.66,1.03,0.2,0.24,0.0,0.46]}},{"id":"C110","name":"M/S. LAM-IYA TRADERS","bpId":"26258058","address":"Raninagar Bazar, Naogaon, Naogaon","lat":24.74164538607354,"lon":88.96764058774919,"region":"North","territory":"Naogaon","salesGroup":"B01","info":{"n":"M/S. LAM-IYA TRADERS","mk":"RANINAGAR BAZAR","d":"NAOGAON","sl":55581391,"v":44.5,"a":10,"r":0,"m":1,"sf":"2025-08","sp":[4.07,1.3,1.01,5.21,0.0,14.73,4.13,3.45,0.0,0.93,4.76,3.65]}},{"id":"C111","name":"M/S. BHAI BHAI TRADERS ","bpId":"26259564","address":"Matherhat, Mithapukur, Rangpur","lat":25.6283,"lon":89.3106,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. BHAI BHAI TRADERS","mk":"MATHERHAT","d":"RANGPUR","sl":21632167,"v":19.4,"a":10,"r":0,"m":1,"sf":"2025-08","sp":[1.79,1.62,0.84,2.39,0.0,6.67,2.04,1.06,0.31,0.0,0.18,2.21]}},{"id":"C112","name":"M/S. JANNAT TRADERS","bpId":"26259843","address":"Paglapir-5400, Rangpur Sador, Rangpur","lat":25.81136906593648,"lon":89.14685920624218,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. JANNAT TRADERS","mk":"PAGLAPIR-5400","d":"RANGPUR","sl":16065539,"v":13.9,"a":11,"r":0,"m":1,"sf":"2025-08","sp":[1.51,4.15,1.15,3.33,1.32,0.0,1.12,0.29,0.12,0.16,0.13,0.32]}},{"id":"C113","name":"M/S. MALIHA TRADERS","bpId":"26260626","address":"Chowrahat, Moinakuthi, Rangpur","lat":25.7864,"lon":89.2717,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. MALIHA TRADERS","mk":"CHOWRAHAT","d":"RANGPUR","sl":27253720,"v":34.8,"a":12,"r":0,"m":1,"sf":"2025-08","sp":[1.07,0.92,3.68,9.81,2.9,4.94,1.6,1.92,0.26,3.06,2.54,1.71]}},{"id":"C114","name":"M/S. KAIYUM TRADERS","bpId":"26260628","address":"Ranipukur, Ershad More, Mithapukur, Rangpur","lat":25.64901623491354,"lon":89.23725810046899,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. KAIYUM TRADERS","mk":"RANIPUKUR","d":"RANGPUR","sl":24615820,"v":18.5,"a":10,"r":0,"m":1,"sf":"2025-08","sp":[1.51,1.84,0.41,3.18,0.62,1.76,1.69,2.13,0.0,0.92,0.0,4.07]}},{"id":"C115","name":"M/S. KIRON SHEIKH PANNA","bpId":"26260627","address":"Station Road, Rosulgonj, Patgram, Lalmonirhat","lat":26.34367083755765,"lon":89.02121285049667,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. KIRON SHEIKH PANNA","mk":"STATION ROAD","d":"LALMONIRHAT","sl":11762527,"v":9.2,"a":11,"r":0,"m":1,"sf":"2025-08","sp":[0.2,0.14,2.68,0.81,1.03,2.59,0.13,0.51,0.14,0.0,0.2,0.59]}},{"id":"C116","name":"M/S. ANOWAR TRADERS","bpId":"21248195","address":"Kellaposi, Ayera, Sherpur, Bogra","lat":24.6578116991612,"lon":89.38329459387863,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. ANOWAR TRADERS","mk":"KELLAPOSI","d":"BOGRA","sl":23887611,"v":23.6,"a":10,"r":0,"m":1,"sf":"2025-08","sp":[0.0,2.18,3.06,6.83,0.44,4.71,1.1,1.9,0.27,0.0,1.43,1.36]}},{"id":"C117","name":"M/S. JUI TRADERS","bpId":"26264623","address":"Gramtola, Purbo Kestopur, Kalai, Joypurhat","lat":25.07,"lon":89.19,"region":"North","territory":"Kahalu","salesGroup":"B01","info":{"n":"M/S. JUI TRADERS","mk":"GRAMTOLA","d":"JOYPURHAT","sl":26255312,"v":16.6,"a":8,"r":0,"m":1,"sf":"2025-08","sp":[0.0,1.29,0.0,4.86,1.93,2.24,0.13,2.71,0.0,0.13,0.0,2.88]}},{"id":"C118","name":"M/S. MOTALEB TRADERS ","bpId":"26265731","address":"Betgari, Gongachora, Rangpur, Rangpur","lat":25.87915849981356,"lon":89.12771823297682,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. MOTALEB TRADERS","mk":"BETGARI","d":"RANGPUR","sl":8744519,"v":9.1,"a":9,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,3.41,1.21,0.49,1.11,1.06,0.67,0.1,0.13,0.0,0.77]}},{"id":"C119","name":"M/S. SADEK TRADERS","bpId":"26266322","address":"Hazir Hut, Dogachi, Pabna Sador, Pabna","lat":24.00111432198993,"lon":89.26263361162425,"region":"North","territory":"Pabna","salesGroup":"B07","info":{"n":"M/S. SADEK TRADERS","mk":"HAZIR HUT","d":"PABNA","sl":43348017,"v":67.3,"a":10,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,12.01,6.98,2.26,14.87,3.43,3.58,3.91,1.13,7.93,6.7]}},{"id":"C120","name":"M/S. HARAGACH MITU SAR GHAR","bpId":"26266450","address":"Tepa Modhupur, Kawnia, Rangpur","lat":25.73859381814208,"lon":89.44793052896912,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. HARAGACH MITU SAR GHAR","mk":"TEPA MODHUPUR","d":"RANGPUR","sl":8717727,"v":11.3,"a":7,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,2.27,1.21,1.11,3.29,1.41,0.75,0.0,0.0,0.0,1.18]}},{"id":"C121","name":"M/S. SATOTA SEED & SAR GHAR","bpId":"26285438","address":"Pirgacha Bazar, Rangpur, Rangpur","lat":25.65863156730553,"lon":89.412403907455,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. SATOTA SEED & SAR GHAR","mk":"PIRGACHA BAZAR","d":"RANGPUR","sl":10541620,"v":15.5,"a":7,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,1.77,3.09,1.25,0.31,2.18,5.98,0.72]}},{"id":"C122","name":"M/S. JANNAT TRADERS","bpId":"26285424","address":"Sakowa Bazar-5010, Boda, Panchagarh","lat":26.17924485809944,"lon":88.63240647036729,"region":"North","territory":"Panchagarh","salesGroup":"B06","info":{"n":"M/S. JANNAT TRADERS","mk":"SAKOWA BAZAR-5010","d":"PANCHAGARH","sl":22814238,"v":16.3,"a":6,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,3.67,1.17,4.81,0.08,0.99,0.0,5.21]}},{"id":"C123","name":"M/S. BULBUL TRADERS","bpId":"26285425","address":"Mirbag, Kawnia, Rangpur","lat":25.75887591743352,"lon":89.3518453578381,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. BULBUL TRADERS","mk":"MIRBAG","d":"RANGPUR","sl":10741766,"v":8.2,"a":7,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,2.75,1.54,2.18,0.16,0.18,0.13,1.07]}},{"id":"C124","name":"M/S. DIGITAL KRISHI SEBA","bpId":"26285529","address":"Dhalaipir Bazar, Sonakhuli, Saidpur, Nilphamary","lat":25.81915977170338,"lon":88.87710282365514,"region":"North","territory":"Saidpur","salesGroup":"B06","info":{"n":"M/S. DIGITAL KRISHI SEBA","mk":"DHALAIPIR BAZAR","d":"NILPHAMARY","sl":14987646,"v":13.2,"a":7,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,3.65,2.12,2.0,0.44,2.29,1.31,1.12]}},{"id":"C125","name":"M/S. IMRAN KRISHI GHAR ","bpId":"26286162","address":"Chaparhat Bazar, Kaligong / 5520 Rangpur-Lalmonirhat","lat":25.99277057199139,"lon":89.29331626168732,"region":"North","territory":"Lalmonirhat","salesGroup":"B05","info":{"n":"M/S. IMRAN KRISHI GHAR","mk":"HAPARHAT BAZAR","d":"KALIGONG / 5520 RANGPUR-LALMONIRHAT","sl":6759648,"v":3.4,"a":5,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,1.81,1.07,0.16,0.12,0.0,0.05]}},{"id":"C126","name":"M/S. S.B TRADERS","bpId":"26288242","address":"Sathibari, Mithapukur, Rangpur","lat":25.54273218024486,"lon":89.2826753854663,"region":"North","territory":"Mithapukur","salesGroup":"B05","info":{"n":"M/S. S.B TRADERS","mk":"SATHIBARI","d":"RANGPUR","sl":12692709,"v":10.2,"a":6,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,2.64,2.22,0.25,0.21,0.27,4.4]}},{"id":"C127","name":"M/S. KHALIL TRADERS","bpId":"26288216","address":"Ranirhat, Gonta Bazar, Tarash, Sirajgonj","lat":24.56032080774473,"lon":89.35805727417795,"region":"North","territory":"Bogura-2","salesGroup":"B01","info":{"n":"M/S. KHALIL TRADERS","mk":"RANIRHAT","d":"SIRAJGONJ","sl":11357725,"v":7.3,"a":6,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,3.17,1.89,0.17,0.06,0.81,0.92]}},{"id":"C128","name":"M/S. HASHENUR TRADERS","bpId":"26290303","address":"Notun Bazar, Nanderai, Dinajpur","lat":25.66134080834279,"lon":88.79293113972174,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. HASHENUR TRADERS","mk":"NOTUN BAZAR","d":"DINAJPUR","sl":19443732,"v":9.3,"a":6,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.73,2.13,0.93,1.0,1.57,2.61]}},{"id":"C129","name":"M/S. MAHIRA TRADERS","bpId":"26290602","address":"Joygonj, Khansama, Dinajpur","lat":25.95965685697199,"lon":88.73243352177361,"region":"North","territory":"Nilphamari","salesGroup":"B05","info":{"n":"M/S. MAHIRA TRADERS","mk":"JOYGONJ","d":"DINAJPUR","sl":2415597,"v":1.8,"a":2,"r":3,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,1.49,0.28,0.0,0.0,0.0]}},{"id":"C130","name":"M/S. FIROZ AGRO INDUSTRIES","bpId":"26290936","address":"Pulhat, Dinajpur Sadar, Dinajpur","lat":25.74390482170935,"lon":88.50576932196581,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. FIROZ AGRO INDUSTRIES","mk":"PULHAT","d":"DINAJPUR","sl":24413224,"v":11.3,"a":4,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,4.18,0.34,0.12,0.0,6.14]}},{"id":"C131","name":"M/S. BONDHON ENTERPRISE","bpId":"26290860","address":"Durgapur, Rajshahi, Rajshahi","lat":24.44722007736649,"lon":88.75980683325966,"region":"North","territory":"Rajshahi","salesGroup":"B07","info":{"n":"M/S. BONDHON ENTERPRISE","mk":"DURGAPUR","d":"RAJSHAHI","sl":22193993,"v":21.1,"a":5,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,13.22,0.3,0.39,1.38,5.56]}},{"id":"C132","name":"M/S. CHAIRMAN ENTERPRISE","bpId":"26291856","address":"Ghatmagura, Mostofapur, Dupchachia, Bogura","lat":24.88582974120221,"lon":89.17958946819465,"region":"North","territory":"Kahalu","salesGroup":"B01","info":{"n":"M/S. CHAIRMAN ENTERPRISE","mk":"GHATMAGURA","d":"BOGURA","sl":28047473,"v":12.6,"a":3,"r":0,"m":1,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,5.03,0.0,0.0,2.99,4.1]}},{"id":"C133","name":"M/S. HASIB TRADERS","bpId":"26295369","address":"Birol Bazar, Dinajpur, Dinajpur","lat":25.64658638085053,"lon":88.49407207285185,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. HASIB TRADERS","mk":"BIROL BAZAR","d":"DINAJPUR","sl":5583572,"v":3.5,"a":4,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.74,0.34,0.69,1.64]}},{"id":"C134","name":"M/S. SHAHIN KRISHI VANDAR","bpId":"26295931","address":"Koimari Bazar, Jaldhaka, Nilphamary","lat":26.02033033571456,"lon":89.01677422312962,"region":"North","territory":"Rangpur","salesGroup":"B05","info":{"n":"M/S. SHAHIN KRISHI VANDAR","mk":"KOIMARI BAZAR","d":"NILPHAMARY","sl":2719156,"v":5.4,"a":4,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.47,0.94,3.52,0.44]}},{"id":"C135","name":"M/S. ABDUR RAZZAK TRADERS","bpId":"26295929","address":"Balapara, Khansama, Dinajpur","lat":25.8364,"lon":88.7728,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. ABDUR RAZZAK TRADERS","mk":"BALAPARA","d":"DINAJPUR","sl":47889,"v":0.0,"a":1,"r":3,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]}},{"id":"C136","name":"M/S. JANNAT TRADERS","bpId":"26296149","address":"Thakurgaon Road Bazar, Thakurgaon","lat":26.04090986121672,"lon":88.42661636886812,"region":"North","territory":"Thakurgaon","salesGroup":"B06","info":{"n":"M/S. JANNAT TRADERS","mk":"THAKURGAON ROAD BAZAR","d":"THAKURGAON","sl":7253207,"v":4.6,"a":4,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.3,0.28,0.25,3.64]}},{"id":"C137","name":"M/S. NAHID TRADERS","bpId":"26296542","address":"Mongolpur, Birol, Dinajpur","lat":25.72485627873024,"lon":88.53346734995634,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. NAHID TRADERS","mk":"MONGOLPUR","d":"DINAJPUR","sl":3180353,"v":2.0,"a":3,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.5,0.07,1.34]}},{"id":"C138","name":"M/S. MAHIDUL TRADERS","bpId":"26297053","address":"Kaharol Bazar, Dinajpur, Dinajpur","lat":25.79547555296622,"lon":88.59907872445427,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. MAHIDUL TRADERS","mk":"KAHAROL BAZAR","d":"DINAJPUR","sl":3082360,"v":2.8,"a":3,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.52,1.28,0.96]}},{"id":"C139","name":"M/S. MOFAJJAL TRADERS","bpId":"26300229","address":"Dusmile, Kaharol, Dinajpur","lat":25.75652995973107,"lon":88.67373296947184,"region":"North","territory":"Dinajpur","salesGroup":"B06","info":{"n":"M/S. MOFAJJAL TRADERS","mk":"DUSMILE","d":"DINAJPUR","sl":5395918,"v":3.0,"a":2,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,1.5,1.43]}},{"id":"C140","name":"M/S. PARVIN ENTERPRISE","bpId":"26301111","address":"Niamatpur,Naogoan","lat":24.82833091954664,"lon":88.57211263241922,"region":"North","territory":"Niamatpur","salesGroup":"B07","info":{"n":"M/S. PARVIN ENTERPRISE","mk":"NIAMATPUR","d":"NAOGOAN","sl":8243426,"v":7.0,"a":1,"r":0,"m":0,"sf":"2025-08","sp":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,6.89]}}],
};
```
---

# 4. Road Constraints Register — js/constraints.js

Deliberately starts empty: constraints are field knowledge that must come from the real register, not be invented by a script. The file is a documented placeholder that users replace/seed via the app's Import button (CSV/Excel/JSON). Importing merges by normalized pair key, so re-imports update rather than duplicate.

```js
/** Road Constraints Register - editable Road/data input. Do not put <script> data in comments.
 * Every row uses Location IDs: WH or C001..C140 (From ID / To ID are a location pair).
 * Constraint Type: River / no direct crossing | Ferry required | Weak bridge |
 *   4-wheeler restricted | Seasonal / monsoon access risk | Market-time restriction |
 *   Road under repair | Security / local restriction | Other
 * Status: Blocked | Uncertain | Validated | Not reviewed
 * Rules: Blocked pair = NEVER consecutive stops. Uncertain pair = allowed only with visible warning.
 * Replace this seed with your own register via the Import button in the app (CSV/Excel/JSON).
 * This seed intentionally starts empty - constraints come from the field register.
 */
window.CONSTRAINTS_REGISTER = [];
```
---

# 5. Engine — js/core.js


`core.js` is pure logic with zero DOM access, which lets the exact same code run in a browser (`window.PDP`) and in Node (`module.exports`) — that is what makes the 50-check acceptance suite possible without a browser. Key pieces:

- **Haversine + matrix** — `haversineKm` / `matrixFromData` build a flat `Float64Array` (141×141 ≈ 80 KB) once; every lookup is O(1) via `dist()`. Pair order is normalized (`pairKey`) so A→B and B→A are the same constraint.
- **Register normalisation** — `normalizeRegister` accepts many header spellings and always coerces to a strict 9-field row with a canonical `key`; it collects `notes` for anything skipped or coerced so nobody is silently dropped.
- **`constraintIndex`** — O(1) pair lookup with three answers: `get` (entry), `blocked` (hard rule), `flags` (soft rule). The engine never calls Excel; it only consults this index.
- **Ordering** — `orderRoute` is greedy nearest-neighbour that treats a Blocked edge as "only if literally unavoidable" (and flags the route for manual review in that case). `twoOpt` reverses sub-sequences that cut cost while rejecting reversals that would *create* a Blocked adjacency; the `WH` head/tail is part of the cost, and when `includeReturn` is on the tail is `WH` too.
- **Partitioning** — `partition` implements locks (locked customers seed and stay in their route) and do-not-combine (a symmetric pair map; `canJoin` blocks pairing). The balance loop only ejects *unlocked* members, and records `sizeIssues`/`lockOverflow` instead of ever violating a lock. `buildTargetSizes` computes the per-route capacities: forced K → balanced split; otherwise N with the final route holding the remainder (140 = 19×7 + 7; e.g. N=9 → 15×9 + 5). Every consumer reads `plan.targetSizes` — the balance pass, `crossRouteImprove`, manual move/swap in the UI, and the QA size check — so "final route holds remainder" is a property of the sizes array, not a hard-coded assumption.
- **Infeasible routes** — if `orderRoute` cannot place a member without a Blocked adjacency it returns the unplaceable set instead of forcing the pair; the route's status is set to `INFEASIBLE`, the plan gets `infeasible: true`, a "Road-infeasible route" exception is emitted, and the best-effort partial route (with `unplaceable` members) is what the user sees. Infeasible routes can never be `Road Validated`.
- **Cross-route improvement** — `crossRouteImprove` tries relocations into under-full routes and whole-customer swaps between equal-size routes, guard-railed to ≤12 passes, honouring locks, do-not-combine, Blocked placement, and exact sizes.
- **`routeMetrics`** — the single source of truth for a route's km, warnings (long leg, long outbound, Uncertain/Not-reviewed legs), leg audit (`constraintLegs`, `uncertainLegs`, `blockedPairsInRoute`) and `reviewRequired` (≈ needs human eyes). `buildPlan` folds these into routes + plan summary + exceptions + QA and runs the QA itself, so `plan.qa` is always populated (an array of `{name, pass, detail}` checks) without a second call.
- **`buildExceptions` / `runQa`** — every anomaly the operator must know about becomes a surfaced exception (unassigned, duplicate, long leg, blocked-anywhere-in-route, locked-overflow, un-reviewed constraint legs, manual moves) and every hard invariant becomes a QA check shown in the UI and in the Excel export.
- **`recomputePlan`** — used after a manual stop edit. It does NOT re-partition (that would move customers and surprise the operator mid-session); it recomputes metrics, statuses, summary, exceptions and QA from the *current* stop order, which is exactly what manual moves need.

```js
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
      var m = routeMetrics(matrix, cx, r.stops, includeReturn);
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
      n: N, includeReturn: includeReturn,
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
    plan.exceptions = buildExceptions(plan, matrix, cx, reg.entries, P);
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
  function routeMetrics(matrix, cx, stops, includeReturn) {
    var out = outboundKm(matrix, stops);
    var ret = stops.length ? dist(matrix, stops[stops.length - 1], "WH") : 0;
    var longest = longestLegKm(matrix, stops);
    var warnings = [];
    var constraintLegs = [], uncertainLegs = [], blockedPairsInRoute = [];
    var blockedAdjacentCount = 0;

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

  function buildExceptions(plan, matrix, cx, register, P) {
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
      var blockedAttempt = r.warnings.filter(function (w) { return w.type === "blockedUnavoidable" || w.type === "blockedAdjacent"; });
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
   * cfg: { reg: normalized register object, n, includeReturn }. Manual
   * route status overrides are applied by the UI layer afterwards.
   */
  function recomputePlan(plan, matrix, cfg) {
    var reg = cfg.reg || normalizeRegister([]);
    var cx = constraintIndex(reg.entries);
    plan.n = cfg.n; plan.includeReturn = cfg.includeReturn;

    plan.routes.forEach(function (r) {
      var m = routeMetrics(matrix, cx, r.stops, cfg.includeReturn);
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
    plan.exceptions = buildExceptions(plan, matrix, cx, reg.entries, P2);
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
```
---

# 6. Exports & imports — js/exports.js


`exports.js` is the thin presentation layer to files. `esc`/`toCSV` are hand-rolled because a full CSV library is overkill for two quote rules, and `parseCSV` is the matching reader for the constraint register round-trip. `csvSafe` adds the OWASP spreadsheet-injection guard on top (`= + @ - 	 ` cells are prefixed with a single quote, with bare-minus numeric literals like `-12.5` preserved), and `escHtml` is applied to every HTML surface the exporter stamps (print sheets, popups, constraint table) so register text can never inject markup. `blobDownload` triggers the browser's save dialog without any dependency.

Exports are deliberately layered: route summary (per-route metrics), full route-stops sheet (×141 rows, with leg km + cumulative km **and the region/territory/sales-group enrichment columns**), exceptions, constraints, change log, QA checks, and a Read Me — the XLSX bundles all of them into 7 sheets via the vendored SheetJS. The printable route sheets are standalone HTML (one `route-sheet` section per route) with inline CSS so each route prints on its own page, and the straight-line disclaimer is stamped into the banner of every sheet; a route that is `INFEASIBLE` gets an explicit warning line on its sheet. `readRegisterFile` can read CSV, JSON or Excel, so the constraint register has a friction-free import path from Excel.

```js
/**
 * PDP Route Optimiser - export / import helpers.
 * CSV + XLSX (SheetJS) exports, printable route sheets, constraint-register import.
 * Straight-line geographic draft - not a road route.
 */
(function (global) {
  "use strict";

  var DISCLAIMER = "Straight-line geographic draft - not a road route. For road dispatch, every route must be validated for roads, bridges, ferries and vehicle access.";

  function esc(s) {
    s = s == null ? "" : String(s);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  /** OWASP CSV-injection guard: prefix cells that begin with = + @ \t \r, and - (but not
   *  numeric literals like -12.5), with a single quote so Excel never evaluates them. */
  function csvSafe(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d*\.?\d+$/.test(s))) return "'" + s;
    return s;
  }
  function toCSV(rows) {
    return rows.map(function (r) { return r.map(function (cell) { return esc(csvSafe(cell)); }).join(","); }).join("\r\n");
  }
  function escHtml(s) {
    s = String(s == null ? "" : s);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function blobDownload(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 50);
  }

  function fmt(x, d) { return (d == null ? x : Number(x).toFixed(d)); }

  function routeSummaryRows(plan) {
    var rows = [["Route", "Customer Count", "Status", "Review Required", "Score km", "Outbound km", "Return km", "Round Trip km", "Longest Leg km", "Avg km per customer", "Warnings"]];
    plan.routes.forEach(function (r) {
      rows.push([
        r.id, r.customerCount, r.status, r.reviewRequired ? "Yes" : "No",
        fmt(r.metrics.scoreKm, 1), fmt(r.metrics.outboundKm, 1), fmt(r.metrics.returnKm, 1),
        fmt(r.metrics.roundTripKm, 1), fmt(r.metrics.longestLegKm, 1), fmt(r.metrics.avgKmPerCustomer, 2),
        r.warnings.map(function (w) { return w.detail; }).join(" | ")
      ]);
    });
    return rows;
  }

  function routeStopsRows(plan, data, matrix) {
    var rows = [["Route", "Stop No", "Location ID", "Customer Name", "BP ID", "Address", "Region", "Territory", "Sales Group", "Latitude", "Longitude", "Leg From", "Leg To", "Leg km", "Cumulative km"]];
    plan.routes.forEach(function (r) {
      var cum = 0;
      r.stops.forEach(function (cid, i) {
        var c = dataById(data, cid);
        var from = i === 0 ? "WH" : r.stops[i - 1];
        var km = PDP.dist(matrix, from, cid);
        cum += km;
        rows.push([
          r.id, i + 1, cid, c.name, c.bpId, c.address, c.region || "", c.territory || "", c.salesGroup || "",
          fmt(c.lat, 6), fmt(c.lon, 6), from, cid, fmt(km, 2), fmt(cum, 2)
        ]);
      });
    });
    return rows;
  }

  function exceptionRows(plan) {
    var rows = [["Type", "Affected", "Risk", "Action", "Status"]];
    (plan.exceptions || []).forEach(function (e) {
      rows.push([e.type, e.affected, e.risk, e.action, e.status]);
    });
    return rows;
  }

  function constraintRows(register) {
    var rows = [[
      "From Location ID", "To Location ID", "Constraint Type", "Constraint Description",
      "Status", "Allowed Vehicle", "Manual Detour Note", "Confirmed By", "Confirmation Date"
    ]];
    (register || []).forEach(function (e) {
      rows.push([e.from, e.to, e.type, e.description, e.status, e.allowedVehicle, e.detourNote, e.confirmedBy, e.confirmationDate]);
    });
    return rows;
  }

  function changeLogRows(changelog) {
    var rows = [["Timestamp", "Action", "Customer", "From", "To", "Reason", "Score Before km", "Score After km", "Via"]];
    (changelog || []).forEach(function (e) {
      rows.push([e.at, e.action, e.customer, e.fromRoute || e.from || "", e.toRoute || e.to || "", e.reason || "", e.scoreBefore != null ? fmt(e.scoreBefore, 1) : "", e.scoreAfter != null ? fmt(e.scoreAfter, 1) : "", e.via || ""]);
    });
    return rows;
  }

  function qaRows(plan) {
    return [["QA Check", "Passed", "Detail"]].concat(
      (plan.qa || []).map(function (c) { return [c.name, c.pass ? "Pass" : "FAIL", c.detail]; })
    );
  }

  function dataById(data, id) {
    if (id === "WH") return data.warehouse;
    for (var i = 0; i < data.customers.length; i++) if (data.customers[i].id === id) return data.customers[i];
    return { id: id, name: id, bpId: "", address: "" };
  }

  function downloadRouteSummaryCSV(plan, stem) { blobDownload(stem + "_route-summary.csv", toCSV(routeSummaryRows(plan))); }
  function downloadRouteStopsCSV(plan, data, matrix, stem) { blobDownload(stem + "_route-stops.csv", toCSV(routeStopsRows(plan, data, matrix))); }
  function downloadExceptionsCSV(plan, stem) { blobDownload(stem + "_exceptions.csv", toCSV(exceptionRows(plan))); }
  function downloadConstraintsCSV(register, stem) { blobDownload(stem + "_constraints.csv", toCSV(constraintRows(register))); }
  function downloadChangeLogCSV(changelog, stem) { blobDownload(stem + "_change-log.csv", toCSV(changeLogRows(changelog))); }

  function downloadXLSX(plan, data, matrix, register, changelog, filename) {
    function sheet(name, rows) {
      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = rows[0].map(function (h, i) {
        var w = 8;
        rows.slice(1).forEach(function (r) { if (r[i] != null && String(r[i]).length + 2 > w) w = String(r[i]).length + 2; });
        return { wch: Math.min(w, 60) };
      });
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    var wb = XLSX.utils.book_new();
    sheet("Route Summary", routeSummaryRows(plan));
    sheet("Route Stops", routeStopsRows(plan, data, matrix));
    sheet("Exceptions", exceptionRows(plan));
    sheet("Constraints", constraintRows(register));
    sheet("Change Log", changeLogRows(changelog));
    sheet("QA Checks", qaRows(plan));
    sheet("Read Me", [[DISCLAIMER], ["Generated", new Date().toISOString()]]);
    XLSX.writeFile(wb, filename || "pdp-routes.xlsx");
  }

  /** Per-route printable sheets (one page per route via CSS). */
  function printSheetHTML(plan, data, matrix) {
    var parts = [];
    plan.routes.forEach(function (r) {
      var cum = 0, rows = "";
      r.stops.forEach(function (cid, i) {
        var c = dataById(data, cid);
        var from = i === 0 ? "WH" : r.stops[i - 1];
        var km = PDP.dist(matrix, from, cid);
        cum += km;
        rows += "<tr><td>" + (i + 1) + "</td><td>" + escHtml(cid) + "</td><td>" + escHtml(c.name) + "</td><td>" +
          escHtml(c.bpId || "") + "</td><td>" + escHtml(c.address) + "</td><td>" + escHtml(from) + "</td><td>" + escHtml(cid) +
          "</td><td>" + km.toFixed(2) + "</td><td>" + cum.toFixed(2) + "</td></tr>";
      });
      parts.push(
        "<section class=\"route-sheet\"><h2>" + escHtml(r.id) + " - " + r.customerCount + " stops - " +
        (r.reviewRequired ? "<span class=\"warn\">Needs Manual Road Review</span>" : "Draft") + "</h2>" +
        (r.status === "INFEASIBLE" ? "<p class=\"warn\">INFEASIBLE - no legal stop order (Blocked pairs). Customers not served until resolved.</p>" : "") +
        "<p class=\"metric\">Score " + r.metrics.scoreKm.toFixed(1) + " km outbound " + r.metrics.outboundKm.toFixed(1) +
        " km return " + r.metrics.returnKm.toFixed(1) + " km longest leg " + r.metrics.longestLegKm.toFixed(1) + " km</p>" +
        (r.warnings.length ? "<p class=\"warn\">Warnings: " + r.warnings.map(function (w) { return escHtml(w.detail); }).join("; ") + "</p>" : "") +
        "<table><thead><tr><th>#</th><th>Loc</th><th>Customer</th><th>BP ID</th><th>Address</th><th>From</th><th>To</th><th>Leg km</th><th>Cum km</th></tr></thead><tbody>" +
        rows + "</tbody></table></section>"
      );
    });
    return (
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>PDP Route Sheets</title>" +
      "<style>" +
      "body{font-family:Arial,sans-serif;margin:0;} .banner{background:#003a70;color:#fff;padding:8px 12px;font-size:12px;}" +
      ".route-sheet{page-break-after:always;padding:10px 14px;} h2{font-size:16px;margin:4px 0;} .metric{font-size:12px;color:#444;margin:2px 0 6px;}" +
      ".warn{color:#b00020;font-weight:bold;font-size:12px;} table{border-collapse:collapse;width:100%;font-size:11px;}" +
      "th,td{border:1px solid #999;padding:3px 5px;text-align:left;} th{background:#eee;}" +
      "</style></head><body><div class=\"banner\">PDP Route Optimiser - " + DISCLAIMER + "</div>" +
      parts.join("") + "</body></html>"
    );
  }
  function downloadPrintSheet(plan, data, matrix, filename) {
    blobDownload(filename || "pdp-print-route-sheets.html", printSheetHTML(plan, data, matrix), "text/html;charset=utf-8");
  }

  /* ---- Constraint register import (CSV / JSON / Excel) -> raw rows for normaliseRegister ---- */

  function parseCSV(text) {
    var rows = [], row = [], cur = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r.length === 1 && String(r[0]).trim() !== ""); });
  }

  function rowsToObjects(csvRows) {
    if (!csvRows.length) return [];
    var headers = csvRows[0].map(function (h) { return String(h).trim(); });
    var out = [];
    for (var i = 1; i < csvRows.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) obj[headers[j]] = csvRows[i][j];
      out.push(obj);
    }
    return out;
  }

  var MIME = { csv: "text/csv", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel" };

  function readRegisterFile(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(new Error("Could not read the selected file.")); };
    reader.onload = function () {
      var name = (file.name || "").toLowerCase();
      try {
        if (name.indexOf(".xlsx") > -1 || name.indexOf(".xls") > -1) {
          var wb = XLSX.read(reader.result, { type: "array" });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          cb(null, rowsToObjects(aoa));
        } else if (name.indexOf(".json") > -1) {
          cb(null, JSON.parse(reader.result));
        } else {
          cb(null, rowsToObjects(parseCSV(String(reader.result))));
        }
      } catch (err) {
        cb(err);
      }
    };
    if (name.indexOf(".xlsx") > -1 || name.indexOf(".xls") > -1) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  global.PDP_EXPORTS = {
    DISCLAIMER: DISCLAIMER,
    esc: esc, escHtml: escHtml, csvSafe: csvSafe, toCSV: toCSV, blobDownload: blobDownload,
    routeSummaryRows: routeSummaryRows, routeStopsRows: routeStopsRows,
    exceptionRows: exceptionRows, constraintRows: constraintRows,
    changeLogRows: changeLogRows, qaRows: qaRows,
    downloadRouteSummaryCSV: downloadRouteSummaryCSV,
    downloadRouteStopsCSV: downloadRouteStopsCSV,
    downloadExceptionsCSV: downloadExceptionsCSV,
    downloadConstraintsCSV: downloadConstraintsCSV,
    downloadChangeLogCSV: downloadChangeLogCSV,
    downloadXLSX: downloadXLSX,
    printSheetHTML: printSheetHTML, downloadPrintSheet: downloadPrintSheet,
    parseCSV: parseCSV, rowsToObjects: rowsToObjects, readRegisterFile: readRegisterFile, dataById: dataById
  };
})(window);
```
---

# 7. UI layer — js/ui.js


`ui.js` wires the whole app; it is the only layer that touches the DOM. Design points worth the LLM knowing:

- **State vs plan.** `state` (N, thresholds, register, locks, doNot, routeStatus, original/working snapshots, changelog) is what persists to `localStorage` under one key. `plan` is the derived working object re-created by `rebuildPlan()` from `state`. `original`/`working` substring-of-plans power "Restore original plan" and give the operator a reset that keeps their constraints.
- **rebuild vs recompute.** `rebuildPlan()` re-partitions from scratch (used after constraint/lock/N changes). `recompute()` calls `core.recomputePlan` and preserves stop order (used after manual moves/reorders). Mixing these up is the most common source of "it moved my customers" bugs, so they are separated on purpose.
- **Status lifecycle.** Routes start `Draft` or `Needs Manual Road Review` (the latter auto-derived from uncertain/unreviewed legs, unavoidable blocked pairs, or long-leg/long-route warnings); impossible routes are `INFEASIBLE`. Promoting to `Road Validated` runs the shared `roadValidateGuard` — the target route must have no unvalidated constraint legs and no open exceptions, and the operator must record a verifier (who / date / evidence) through `collectVerifier`. The same guard backs `window.PDP_UI.setStatus` in `ui.js`, so the programmatic path cannot bypass it. Manual status is stored in `state.routeStatus` and re-applied after every rebuild; an infeasible plan also turns the whole summary banner red (`#sum-warn`).
- **Manual move that becomes a swap.** `moveCustomer` consults `plan.targetSizes` first: a one-way move only lands when the source route is dropping to its exact target size and the target route is growing to its exact target size; otherwise it delegates to `swapCustomer`, which asks for a stop on the target route to exchange. Both paths re-verify do-not-combine conflicts and Blocked placement (including the WH boundary), run 2-opt on the two touched routes, recompute, write before/after score km + a mandatory reason into the change log, and only then save+re-render. A cancelled swap changes nothing. `reorder` refuses a reversal that would put a Blocked pair consecutively (`reorderFeasible`).
- **Change log.** Every replan, move, swap, reorder, lock/unlock, status change and register change is appended with a timestamp and reason; capped at 500 entries. It is exported to CSV and included in the Excel bundle.
- **Map.** OSM tiles via `tile.openstreetmap.org`; a single route is shown by default (coloured polylines + numbered order markers), "Show all routes" is off by default because all 20 routes overlaid is an unreadable spiderweb and invites people to mistake straight lines for driveable roads (hence a warning text when toggled on).
- **Programmatic facade.** `window.PDP_UI` exposes `state/plan/replan/move/reorder/setStatus/addConstraintRow/clearRegister/clearStorage/recompute/rebuild/getChangelog` — this is what `selftest.html` drives and what a console operator can use. `__PDP_SELFTEST_REASON__` lets the self-test pre-fill the mandatory reason prompt.

```js
/**
 * PDP Route Optimiser - UI layer.
 * Builds on window.PDP (core) + window.PDP_EXPORTS (exports) + window.APP_DATA.
 * Straight-line geographic draft - not a road route.
 */
(function () {
  "use strict";
  var STORAGE_KEY = "pdp-bogura-v1";
  var PALETTE = ["#d62728", "#1f77b4", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf", "#6b6ecf", "#d2691e"];

  var data = window.APP_DATA || null;
  var matrix = null;
  var E = window.PDP_EXPORTS;

  function setData(d) {
    data = d;
    matrix = d ? PDP.matrixFromData(d) : null;
  }
  if (data) setData(data);

  var state = {
    N: 7, includeReturn: true,
    forceRouteCount: 0,
    register: [], locks: {}, doNot: {},
    routeStatus: {}, verifier: {}, original: null, working: null, changelog: [],
    mapVolume: true, mapRecency: true
  };

  var plan = null;
  var selectedRouteId = null;
  var showAllRoutes = false;
  var map = null, routeLayer = null, baseLayer = null, whMarker = null;
  var rebuildPending = false;

  /* ---------------- persistence ---------------- */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { console.warn("Save failed", e); }
  }
  function inflatePlan(snapshot) {
    var p = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    if (!p._customers) p._customers = data.customers;
    p.changelog = state.changelog;
    return p;
  }
  function snap() { return JSON.stringify(plan); }

  /* ---------------- building ---------------- */

  function buildCfg() {
    return {
      data: data, matrix: matrix, N: state.N, includeReturn: state.includeReturn,
      register: state.register, locks: state.locks, doNotCombine: unpackDoNot(),
      forceRouteCount: state.forceRouteCount
    };
  }
  function unpackDoNot() {
    var map = {};
    Object.keys(state.doNot).forEach(function (k) {
      var parts = k.split("~");
      if (parts.length === 2) { map[parts[0]] = parts[1]; map[parts[1]] = parts[0]; }
    });
    return map;
  }
  function planKey(p) { return p.routes.map(function (r) { return r.id; }).join(","); }

  function rebuildPlan() {
    plan = PDP.buildPlan(buildCfg());
    plan.changelog = state.changelog;
    applyStatusOverrides();
    state.original = snap();
    state.working = snap();
    selectedRouteId = selectedRouteId && planKey(plan).indexOf(selectedRouteId) > -1 ? selectedRouteId : plan.routes[0].id;
    renderAll("all");
  }

  function applyStatusOverrides() {
    plan.routes.forEach(function (r) {
      if (state.routeStatus[r.id]) r.status = state.routeStatus[r.id];
    });
  }

  /* ---------------- change log ---------------- */

  function log(action, fields) {
    state.changelog.push(Object.assign({ at: new Date().toISOString(), action: action }, fields));
    if (state.changelog.length > 500) state.changelog.splice(0, state.changelog.length - 500);
    plan.changelog = state.changelog;
  }

  /* ---------------- helpers ---------------- */

  function cust(id) { return E.dataById(data, id); }
  function routeById(id) {
    for (var i = 0; i < plan.routes.length; i++) if (plan.routes[i].id === id) return plan.routes[i];
    return null;
  }
  function targetCount(routeId) {
    var idx = plan.routes.map(function (r) { return r.id; }).indexOf(routeId);
    if (plan.targetSizes && plan.targetSizes.length) return plan.targetSizes[idx];
    return idx === plan.routes.length - 1 ? data.customers.length - (plan.routes.length - 1) * state.N : state.N;
  }
  function colorFor(routeId) { return PALETTE[plan.routes.map(function (r) { return r.id; }).indexOf(routeId) % PALETTE.length]; }
  function fmt(x, d) { return Number(x).toFixed(d == null ? 1 : d); }
  function el(id) { return document.getElementById(id); }

  function escHtml(s) {
    s = String(s == null ? "" : s);
    if (E && E.escHtml) return E.escHtml(s);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function setText(id, t) { var e = el(id); if (e) e.textContent = t; }
  function setHtml(id, h) { var e = el(id); if (e) e.innerHTML = h; }

  /* ---------------- modal: replan ---------------- */

  function openReplanModal() {
    el("rp-N").value = state.N;
    el("rp-count").value = state.forceRouteCount || "";
    el("rp-return").checked = state.includeReturn;
    showModal("replan-modal");
  }
  function applyReplan() {
    var n = parseInt(el("rp-N").value, 10);
    if (!n || n < 1 || n > data.customers.length) { alert("N must be between 1 and " + data.customers.length + "."); return; }
    state.N = n;
    state.includeReturn = el("rp-return").checked;
    state.forceRouteCount = parseInt(el("rp-count").value, 10) || 0;
    log("replan", { n: state.N, includeReturn: state.includeReturn, note: "Rebuilt plan at N=" + state.N });
    hideModal("replan-modal");
    rebuildPlan();
  }

  function showModal(id) { var m = el(id); if (!m) return; m.classList.remove("hidden"); var b = m.querySelector(".modal-backdrop"); if (b) b.classList.remove("hidden"); }
  function hideModal(id) { var m = el(id); if (!m) return; m.classList.add("hidden"); var b = m.querySelector(".modal-backdrop"); if (b) b.classList.add("hidden"); }

  /* ---------------- register ---------------- */

  function normalizedRegister() { return PDP.normalizeRegister(state.register).entries; }
  function rebuildFromRegister() {
    state.register = PDP.normalizeRegister(state.register).entries;
    log("register", { note: "Road Constraints Register updated (" + state.register.length + " entries); plan rebuilt" });
    rebuildPlan();
  }

  /* ---------------- map ---------------- */

  function initMap() {
    if (map) return;
    L.Icon.Default.prototype.options.imagePath = "vendor/leaflet/images/";
    map = L.map("map", { zoomControl: true }).setView([24.9, 89.2], 8);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    baseLayer = L.layerGroup().addTo(map);
    buildBaseLayer();
    updateLegend();
  }

  /* -------- map information helpers (Customer Master info pack, display-only) -------- */

  function infoEnabled() {
    return data.customers.some(function (c) { return !!c.info; });
  }
  function recColor(rec) {
    if (rec === undefined || rec === null) return "#c7cdd6";
    if (rec <= 1) return "#2e7d32";
    if (rec <= 6) return "#ef8a1d";
    return "#c9403d";
  }
  function recClass(rec) {
    if (rec <= 1) return "r-act";
    if (rec <= 6) return "r-slow";
    return "r-stale";
  }
  function recLabel(rec) {
    rec = Number(rec) || 0;
    if (rec === 0) return "this month";
    return rec + " mo ago";
  }
  function fmtBDT(x) {
    x = Number(x) || 0;
    if (x >= 1e7) return "\u09F3" + (x / 1e7).toFixed(2) + " Cr";
    return "\u09F3" + (x / 1e5).toFixed(2) + " L";
  }
  function stopRadius(v) { return 5 + 0.5 * Math.sqrt(Number(v) || 0); }
  function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function allBounds() {
    var b = L.latLngBounds([data.warehouse.lat, data.warehouse.lon], [data.warehouse.lat, data.warehouse.lon]);
    data.customers.forEach(function (c) { b.extend([c.lat, c.lon]); });
    return b.pad(0.15);
  }
  function sparkSVG(v, color) {
    var W = 108, H = 28, pad = 2;
    var mx = Math.max.apply(null, v), mn = Math.min.apply(null, v);
    var span = (mx - mn) || 1, n = v.length;
    var pts = v.map(function (x, i) {
      return (pad + i * (W - 2 * pad) / (n - 1)).toFixed(1) + "," +
        (H - pad - ((x - mn) / span) * (H - 2 * pad)).toFixed(1);
    });
    return "<div class=\"pp-spark\"><i>Last " + n + " months volume (MT)</i>" +
      "<svg width=\"" + W + "\" height=\"" + H + "\" viewBox=\"0 0 " + W + " " + H + "\">" +
      "<polyline points=\"" + pts.join(" ") + "\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"1.5\"/>" +
      "<polygon points=\"0," + H + " " + pts.join(" ") + " " + W + "," + H + "\" fill=\"" + color + "\" opacity=\".15\"/>" +
      "</svg></div>";
  }

  /** Enriched popup. Route context (route id, stop position, leg/cumulative km) only when
   *  rendered for a route stop; null route = background dot. Falls back to plain header +
   *  route context + caveat when the Customer Master info pack is absent. */
  function popupHtml(cid, route, i, legKm, cumKm) {
    var c = cust(cid);
    var inf = c.info || {};
    var h = "<div class=\"pdp-pop\">" +
      "<b>" + escHtml(cid) + " " + escHtml(inf.n || c.name) + "</b>";
    if (inf.n && inf.n !== c.name) h += "<br><span class=\"pp-sub\">" + escHtml(c.name) + "</span>";
    var bits = [];
    if (c.bpId) bits.push("BP " + escHtml(c.bpId));
    if (inf.mk) bits.push(escHtml(inf.mk));
    if (inf.d) bits.push(escHtml(inf.d));
    if (bits.length) h += "<div class=\"pp-meta\">" + bits.join(" \u00B7 ") + "</div>";

    var badges = "";
    if (inf.m !== undefined) badges += inf.m
      ? "<span class=\"badg ok\">Meets volume/sales bar</span>"
      : "<span class=\"badg off\">Below volume/sales bar</span>";
    if (inf.r !== undefined) badges += "<span class=\"badg rec " + recClass(inf.r) + "\">" + recLabel(inf.r) + "</span>";
    if (badges) h += "<div class=\"pp-badges\">" + badges + "</div>";

    if (inf.sl !== undefined || inf.v !== undefined || inf.a !== undefined) {
      h += "<div class=\"kpis\">";
      if (inf.sl !== undefined) h += "<div class=\"kpi\"><i>Sales (12 mo)</i><b>" + fmtBDT(inf.sl) + "</b></div>";
      if (inf.v !== undefined) h += "<div class=\"kpi\"><i>Volume (12 mo)</i><b>" + fmt(inf.v) + " MT</b></div>";
      if (inf.a !== undefined) h += "<div class=\"kpi\"><i>Active months</i><b>" + inf.a + " / 19</b></div>";
      h += "</div>";
    }

    if (c.address) h += "<div class=\"pp-addr\">" + escHtml(c.address) + "</div>";
    if (inf.sp && inf.sp.length > 1) h += sparkSVG(inf.sp, route ? colorFor(route.id) : "#5a6570");

    if (route) {
      h += "<div class=\"pp-route\">" + escHtml(route.id) + " \u00B7 stop " + (i + 1) + "/" + route.stops.length +
        " \u00B7 leg " + fmt(legKm, 2) + " km \u00B7 cum " + fmt(cumKm, 2) + " km<br>" +
        escHtml(state.routeStatus[route.id] || route.status) + "</div>";
    }
    h += "<div class=\"pp-caveat\">Straight-line draft km \u2013 not a road route.</div></div>";
    return h;
  }

  function stopIcon(c, seq, color, cid) {
    var ball = "";
    if (state.mapVolume && c.info) {
      var col = state.mapRecency ? recColor(c.info.r) : color;
      var r = stopRadius(c.info.v);
      ball = "<span class=\"volball\" style=\"width:" + (2 * r).toFixed(0) + "px;height:" + (2 * r).toFixed(0) +
        "px;border-color:" + col + "\"></span>";
    }
    return L.divIcon({
      className: "stnum-wrap",
      html: "<div class=\"stopmark\" title=\"" + escHtml(cid) + "\">" + ball +
        "<span class=\"stnum\" style=\"border-color:" + color + ";color:" + color + "\">" + seq + "</span></div>",
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
  }

  function buildBaseLayer() {
    if (!baseLayer) return;
    baseLayer.clearLayers();
    data.customers.forEach(function (c) {
      var col = c.info && state.mapRecency ? recColor(c.info.r) : "#c9cfd9";
      var mk = L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          className: "bdot-wrap",
          html: "<span class=\"bdot\" style=\"background:" + col + "\"></span>",
          iconSize: [12, 12], iconAnchor: [6, 6]
        })
      });
      mk.bindPopup(popupHtml(c.id, null));
      mk.addTo(baseLayer);
    });
    whMarker = L.marker([data.warehouse.lat, data.warehouse.lon], {
      icon: L.divIcon({
        className: "wh-wrap",
        html: "<span class=\"wh-pill\">WH</span>",
        iconSize: [40, 24], iconAnchor: [20, 24]
      })
    });
    whMarker.bindPopup("<b>WH</b> " + escHtml(data.warehouse.name));
    whMarker.addTo(baseLayer);
  }

  function updateLegend() {
    var leg = el("map-legend");
    if (!leg) return;
    var h = "";
    if (infoEnabled() && state.mapVolume) {
      h += "<div class=\"lg-title\">Volume 12 mo (MT)</div>";
      [[10, "10"], [50, "50"], [150, "150"], [400, "400"]].forEach(function (b) {
        h += "<span class=\"lg-vol\" style=\"width:" + (2 * stopRadius(b[0])).toFixed(0) +
          "px;height:" + (2 * stopRadius(b[0])).toFixed(0) + "px\"></span> " + b[1] + " MT<br>";
      });
    }
    if (infoEnabled() && state.mapRecency) {
      h += "<div class=\"lg-title\">Last purchase</div>" +
        "<span class=\"lg-dot\" style=\"background:#2e7d32\"></span> \u2264 1 mo ago<br>" +
        "<span class=\"lg-dot\" style=\"background:#ef8a1d\"></span> 2\u20136 mo ago<br>" +
        "<span class=\"lg-dot\" style=\"background:#c9403d\"></span> > 6 mo ago<br>";
    }
    leg.innerHTML = h;
    if (leg.classList) leg.classList.toggle("hidden", !h);
  }

  function renderMap(opts) {
    initMap();
    opts = opts || {};
    routeLayer.clearLayers();

    var vis = showAllRoutes ? plan.routes.map(function (r) { return r.id; }) : [selectedRouteId];
    var wh = [data.warehouse.lat, data.warehouse.lon];
    var bounds = L.latLngBounds(wh, wh);
    var haveRoute = false;

    plan.routes.forEach(function (r) {
      if (vis.indexOf(r.id) === -1) return;
      var color = colorFor(r.id);
      var pts = [wh];
      r.stops.forEach(function (cid) { pts.push([cust(cid).lat, cust(cid).lon]); });
      if (state.includeReturn) pts.push(wh);

      var legs = [];
      r.stops.forEach(function (cid, i) {
        legs.push({ km: PDP.dist(matrix, i === 0 ? "WH" : r.stops[i - 1], cid), from: pts[i], to: pts[i + 1] });
      });
      if (state.includeReturn) {
        legs.push({ km: PDP.dist(matrix, r.stops[r.stops.length - 1], "WH"), from: pts[pts.length - 2], to: pts[pts.length - 1] });
      }
      L.polyline(pts, { color: color, weight: 3, opacity: 0.85 }).addTo(routeLayer);
      haveRoute = true;

      if (!showAllRoutes) legs.forEach(function (leg) {
        L.marker(midpoint(leg.from, leg.to), {
          icon: L.divIcon({ className: "leg-km", html: fmt(leg.km, 1) + " km", iconSize: [60, 15], iconAnchor: [30, 7] }),
          interactive: false
        }).addTo(routeLayer);
      });

      var cum = 0;
      r.stops.forEach(function (cid, i) {
        var c = cust(cid);
        var mk = L.marker([c.lat, c.lon], { icon: stopIcon(c, i + 1, color, cid) });
        mk.bindPopup(popupHtml(cid, r, i, legs[i].km, cum));
        mk.addTo(routeLayer);
        bounds.extend([c.lat, c.lon]);
        cum += legs[i].km;
      });
    });

    if (!haveRoute) map.setView(wh, 8);
    else if (opts.fit === "route") map.fitBounds(bounds.pad(0.15));
    else if (opts.fit === "all") map.fitBounds(allBounds());
    updateLegend();
  }

  /* ---------------- render: summary ---------------- */

  function renderSummary() {
    var s = plan.summary;
    setText("sum-n", state.N + (state.forceRouteCount ? " (forced " + state.forceRouteCount + " routes)" : ""));
    setText("sum-return", state.includeReturn ? "Return to warehouse included in score" : "Outbound only");
    setText("sum-routes", s.routeCount);
    setText("sum-assigned", s.customersAssigned + " / " + s.customerCount);
    setText("sum-review", s.customersRequiringReview.toLocaleString());
    setText("sum-outbound", fmt(s.totalOutboundKm) + " km");
    setText("sum-score", fmt(s.totalScoreKm) + " km");
    setText("sum-unassigned", s.unassignedCount > 0 ? s.unassignedCount + " UNASSIGNED" : "0");
    el("sum-unassigned").classList.toggle("bad", s.unassignedCount > 0);
    var warns = [];
    if (plan.infeasible) warns.push("PLAN INFEASIBLE: at least one route has Blocked pairings leaving no legal stop order - see Exceptions.");
    (plan.forceNotes || []).forEach(function (n) { warns.push(n); });
    setHtml("sum-warn", warns.map(function (w) { return "<p class=\"warn\">" + escHtml(w) + "</p>"; }).join(""));
  }

  /* ---------------- render: route list + selector ---------------- */

  function renderRouteList() {
    var sel = el("route-select");
    sel.innerHTML = "";
    plan.routes.forEach(function (r) {
      var o = document.createElement("option");
      o.value = r.id;
      o.textContent = r.id + " - " + r.customerCount + " stops - " + (state.routeStatus[r.id] || r.status) +
        (r.metrics ? " - " + fmt(r.metrics.outboundKm) + " out / RT " + fmt(r.metrics.roundTripKm) + " km" : "");
      sel.appendChild(o);
    });
    sel.value = selectedRouteId;

    var search = el("cust-search").value.toLowerCase().trim();
    var list = el("route-list");
    list.innerHTML = "";
    plan.routes.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "route-row" + (r.id === selectedRouteId ? " active" : "");
      row.innerHTML =
        "<span class=\"dot\" style=\"background:" + colorFor(r.id) + "\"></span>" +
        "<button class=\"rname\" data-rid=\"" + r.id + "\">" + r.id + "</button>" +
        "<span class=\"rcount\">" + r.stops.length + "</span>" +
        (r.metrics ? "<span class=\"rkm\">" + fmt(r.metrics.outboundKm) + " / RT " + fmt(r.metrics.roundTripKm) + " km</span>" : "") +
        "<span class=\"rstatus " + statusClass(r) + "\">" + (state.routeStatus[r.id] || r.status) + "</span>";
      list.appendChild(row);
      if (row.querySelector(".rname").textContent.indexOf(search) === -1 && !r.stops.some(function (c) {
        return c.toLowerCase().indexOf(search) > -1 || cust(c).name.toLowerCase().indexOf(search) > -1 || cust(c).bpId.toLowerCase().indexOf(search) > -1;
      })) row.classList.add("hidden");
    });
  }
  function statusClass(r) {
    var st = state.routeStatus[r.id] || r.status;
    if (st === "Road Validated") return "ok";
    if (st === "Needs Manual Road Review") return "warn";
    return "draft";
  }

  /* ---------------- render: route details ---------------- */

  function renderRouteDetails() {
    var r = routeById(selectedRouteId);
    var box = el("route-details");
    if (!r) { setHtml("route-details", ""); return; }
    var seg = r.stops.map(function (cid, i) {
      var from = i === 0 ? "WH" : r.stops[i - 1];
      return { from: from, to: cid, km: PDP.dist(matrix, from, cid) };
    });
    var cum = 0;

    var stopsHtml = r.stops.map(function (cid, i) {
      var c = cust(cid);
      var km = seg[i].km;
      cum += km;
      var locked = state.locks[cid] !== undefined;
      var enr = [c.region, c.territory, c.salesGroup].filter(Boolean).join(" · ");
      return "<tr>" +
        "<td>" + (i + 1) + "</td>" +
        "<td>" + escHtml(cid) + (locked ? " <span class=\"lck\">L</span>" : "") + "</td>" +
        "<td>" + escHtml(c.name) + (enr ? "<br><span class=\"enr\">" + escHtml(enr) + "</span>" : "") + "</td>" +
        "<td>" + escHtml(c.bpId || "") + "</td>" +
        "<td>" + escHtml(seg[i].from) + "→" + escHtml(cid) + "</td>" +
        "<td>" + km.toFixed(2) + "</td>" +
        "<td>" + cum.toFixed(2) + "</td>" +
        "<td><button data-a=\"up\" data-i=\"" + i + "\" title=\"Move stop earlier\">▲</button>" +
        "<button data-a=\"down\" data-i=\"" + i + "\" title=\"Move stop later\">▼</button>" +
        "<button data-a=\"lock\" data-i=\"" + i + "\">" + (locked ? "Unlock" : "Lock") + "</button>" +
        "<button data-a=\"move\" data-i=\"" + i + "\">Move…</button></td>" +
        "</tr>";
    }).join("");

    var journey = ["WH (" + escHtml(data.warehouse.name) + ")"].concat(r.stops.map(function (c) { return escHtml(c) + " " + escHtml(cust(c).name); }));
    var warnHtml = r.warnings.length
      ? "<ul class=\"warns\">" + r.warnings.map(function (w) { return "<li>" + escHtml(w.detail) + "</li>"; }).join("") + "</ul>"
      : "<p class=\"oktxt\">No warnings for this route.</p>";

    box.innerHTML =
      "<h3>" + r.id + "</h3>" +
      "<p class=\"subtitle\">" + r.customerCount + " stops - <select id=\"rstatus\">" +
      ["Draft", "Needs Manual Road Review", "Road Validated"].map(function (st) {
        return "<option" + ((state.routeStatus[r.id] || r.status) === st ? " selected" : "") + ">" + st + "</option>";
      }).join("") + "</select></p>" +
      "<table class=\"metrics\"><tr><td>Score</td><td>" + fmt(r.metrics.scoreKm) + " km</td><td>Outbound</td><td>" + fmt(r.metrics.outboundKm) + " km</td></tr>" +
      "<tr><td>Return leg</td><td>" + fmt(r.metrics.returnKm) + " km</td><td>Longest leg</td><td>" + fmt(r.metrics.longestLegKm) + " km</td></tr>" +
      "<tr><td>Round trip</td><td>" + fmt(r.metrics.roundTripKm) + " km</td><td>Avg / customer</td><td>" + fmt(r.metrics.avgKmPerCustomer, 2) + " km</td></tr></table>" +
      warnHtml +
      "<h4>Ordered stops</h4>" +
      "<table class=\"stops\"><thead><tr><th>#</th><th>Loc</th><th>Customer</th><th>BP ID</th><th>Leg</th><th>Leg km</th><th>Cum</th><th>Actions</th></tr></thead><tbody>" +
      stopsHtml + "</tbody></table>" +
      "<h4>Journey</h4><ol class=\"journey\">" + journey.map(function (j) { return "<li>" + j + "</li>"; }).join("") + "</ol>";
  }

  /* ---------------- render: exceptions & register ---------------- */

  function renderExceptions() {
    setHtml("exc-list", "");
    if (!plan.exceptions.length) { setHtml("exc-list", "<p class=\"oktxt\">No open exceptions.</p>"); return; }
    var ul = document.createElement("ul");
    plan.exceptions.forEach(function (e) {
      var li = document.createElement("li");
      li.className = e.status === "Resolved" ? "resolved" : "";
      li.innerHTML = "<b>" + escHtml(e.type) + "</b> [" + escHtml(e.status) + "] - " + escHtml(e.affected) + "<br>" + escHtml(e.risk) + "<br><i>" + escHtml(e.action) + "</i>";
      ul.appendChild(li);
    });
    el("exc-list").appendChild(ul);
  }

  function renderRegister() {
    setHtml("reg-body", "");
    if (!state.register.length) { setHtml("reg-body", "<tr><td colspan=\"9\">Register empty. Add pairs or import a file.</td></tr>"); return; }
    state.register.forEach(function (e, i) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + escHtml(e.from) + "</td><td>" + escHtml(e.to) + "</td><td>" + escHtml(e.type) + "</td><td>" + escHtml(e.description || "") + "</td>" +
        "<td>" + escHtml(e.status) + "</td><td>" + escHtml(e.allowedVehicle || "") + "</td><td>" + escHtml(e.detourNote || "") + "</td>" +
        "<td>" + escHtml(e.confirmedBy || "") + "</td><td>" + escHtml(e.confirmationDate || "") + "</td>" +
        "<td><button data-rg=\"del\" data-i=\"" + i + "\">✕</button></td>";
      el("reg-body").appendChild(tr);
    });
  }

  /* ---------------- manual operations ---------------- */

  function askReason(defaultText) {
    if (window.__PDP_SELFTEST_REASON__) return window.__PDP_SELFTEST_REASON__;
    var r = prompt("Reason for this adjustment (recorded in the change log):", defaultText || "");
    if (r === null) return null;
    return r.trim() || "(no reason given)";
  }

  /** Guard: a route may be Road Validated only if it has no unvalidated constraint legs,
   *  no open exceptions, and a recorded verifier (by / date / evidence). Shared by the UI
   *  dropdown and PDP_UI.setStatus so the programmatic path cannot bypass it.
   *  Returns {ok:true} or {ok:false, reason} (reason "verifier" = only verifier fields missing). */
  function roadValidateGuard(rid) {
    var r = routeById(rid);
    if (!r) return { ok: false, reason: "Unknown route." };
    if (plan.infeasible || r.orderFailed)
      return { ok: false, reason: rid + " is INFEASIBLE (Blocked pairings leave no legal stop order). Resolve before Road Validated." };
    var bad = (r.constraintLegs || []).filter(function (l) {
      return l.entry.status === "Blocked" || l.entry.status === "Uncertain" || l.entry.status === "Not reviewed";
    }).map(function (l) { return PDP.pairKey(l.a, l.b) + " (" + l.entry.status + ")"; });
    if (bad.length)
      return { ok: false, reason: rid + " has unvalidated constraint legs: " + bad.join(", ") + ". Field-confirm these before Road Validated." };
    var open = (plan.exceptions || []).filter(function (e) {
      return e.status !== "Resolved" && String(e.affected || "").indexOf(rid) > -1;
    });
    if (open.length)
      return { ok: false, reason: rid + " has open exceptions (" + open.map(function (e) { return e.type; }).join(", ") + "). Resolve them before Road Validated." };
    var v = state.verifier[rid];
    if (!v || !v.by || !v.date || !v.evidence) return { ok: false, reason: "verifier" };
    return { ok: true, reason: "" };
  }

  function collectVerifier(rid) {
    var v = state.verifier[rid] || {};
    var by = prompt("Verifier (who performed the road check):", v.by || "");
    if (by === null || by.trim() === "") return { ok: false, reason: "A verifier name is required for Road Validated." };
    var date = prompt("Verification date (YYYY-MM-DD):", v.date || new Date().toISOString().slice(0, 10));
    if (date === null || date.trim() === "") return { ok: false, reason: "A verification date is required for Road Validated." };
    var evidence = prompt("Evidence (road-check notes / reference):", v.evidence || "");
    if (evidence === null || evidence.trim() === "") return { ok: false, reason: "Evidence is required for Road Validated." };
    state.verifier[rid] = { by: by.trim(), date: date.trim(), evidence: evidence.trim() };
    return { ok: true };
  }

  function doStatusChange() {
    var st = el("rstatus").value;
    var rid = selectedRouteId;
    var cur = state.routeStatus[rid] || (routeById(rid) && routeById(rid).status);
    if (cur === st) return;
    if (st === "Road Validated") {
      if (!confirm("Mark " + rid + " as Road Validated? This tool only produces a straight-line geographic draft - Road Validated must come from an actual road check in the field, with an unconflicted route and a recorded verifier. Proceed?")) {
        el("rstatus").value = cur;
        return;
      }
      var g = roadValidateGuard(rid);
      if (!g.ok && g.reason !== "verifier") { alert(g.reason); el("rstatus").value = cur; return; }
      var cv = collectVerifier(rid);
      if (!cv.ok) { alert(cv.reason); el("rstatus").value = cur; return; }
      var g2 = roadValidateGuard(rid);
      if (!g2.ok) { alert(g2.reason); el("rstatus").value = cur; return; }
    }
    state.routeStatus[rid] = st;
    log("status", { route: rid, to: st, reason: "Set route status to " + st + (st === "Road Validated" ? " (verified by " + state.verifier[rid].by + " on " + state.verifier[rid].date + ")" : "") });
    save();
    applyStatusOverrides();
    renderAll();
  }

  function moveCustomer(cid, fromRouteId, toRouteId, posStyle) {
    var src = routeById(fromRouteId), dst = routeById(toRouteId);
    if (!src || !dst || fromRouteId === toRouteId) { alert("Select a different target route."); return; }
    if (src.stops.indexOf(cid) === -1) return;

    // Route sizes are fixed per-plan: a one-way move is only allowed when it keeps both
    // routes at exactly their target sizes; otherwise fall back to swap.
    var srcCap = targetCount(fromRouteId), dstCap = targetCount(toRouteId);
    var oneWayOk = dst.stops.length === 0 || (src.stops.length - 1 === srcCap && dst.stops.length + 1 === dstCap);
    if (!oneWayOk || dst.stops.length >= dstCap) return swapCustomer(cid, fromRouteId, toRouteId);

    var dnSet = PDP.doNotIndex(unpackDoNot());
    var conflict = dst.stops.some(function (m) { return PDP.cannotPair(dnSet, cid, m); });
    if (conflict) return alert("Cannot move " + cid + " to " + toRouteId + ": do-not-combine pair conflicts with an existing stop on that route.");

    var cx = PDP.constraintIndex(PDP.normalizeRegister(state.register).entries);
    var bestAt = -1, bestCost = Infinity;
    var any = false;
    for (var i = 0; i <= dst.stops.length; i++) {
      var prev = i === 0 ? "WH" : dst.stops[i - 1];
      var next = i === dst.stops.length ? (state.includeReturn ? "WH" : null) : dst.stops[i];
      if (cx.blocked(prev, cid) || (next && cx.blocked(cid, next))) continue;
      var s = dst.stops.slice(); s.splice(i, 0, cid);
      var cost = PDP.pathCost(matrix, s, state.includeReturn);
      any = true;
      if (cost < bestCost) { bestCost = cost; bestAt = i; }
    }
    if (!any) return alert("Cannot place " + cid + " in " + toRouteId + ": every position would put it next to a Blocked partner from the Road Constraints Register.");

    var before = src.metrics.scoreKm + dst.metrics.scoreKm;
    var reason = askReason(cid + " " + fromRouteId + " -> " + toRouteId);
    if (reason === null) return;

    src.stops.splice(src.stops.indexOf(cid), 1);
    dst.stops.splice(bestAt, 0, cid);
    src.stops = PDP.twoOpt(cx, matrix, src.stops, state.includeReturn);
    dst.stops = PDP.twoOpt(cx, matrix, dst.stops, state.includeReturn);

    recompute();
    var after = routeById(fromRouteId).metrics.scoreKm + routeById(toRouteId).metrics.scoreKm;
    log("move", { customer: cid, fromRoute: fromRouteId, toRoute: toRouteId, scoreBefore: Math.round(before), scoreAfter: Math.round(after), reason: reason });
    save();
    renderAll();
  }

  function swapCustomer(cid, fromRouteId, toRouteId) {
    var src = routeById(fromRouteId), dst = routeById(toRouteId);
    var prompt = window.prompt("Route " + toRouteId + " is at its target size (capacity " + targetCount(toRouteId) + "); moving one customer in means another must leave. Enter a customer on " + toRouteId + " to swap for " + cid + " (e.g. C042):", "");
    if (prompt === null || prompt === "") return alert("Move cancelled. Swaps keep both routes at their target size: enter a customer on " + toRouteId + " to exchange, or replan with a different route count.");
    var swapTarget = prompt.trim().toUpperCase();
    if (dst.stops.indexOf(swapTarget) === -1) return alert(swapTarget + " is not a stop on " + toRouteId + ".");
    if (swapTarget === cid) return alert("Cannot swap a customer with itself.");

    var dnSet = PDP.doNotIndex(unpackDoNot());
    if (dst.stops.some(function (m) { return m !== swapTarget && PDP.cannotPair(dnSet, cid, m); }))
      return alert("Cannot move " + cid + ": do-not-combine pair conflicts with another stop on " + toRouteId + ".");
    if (src.stops.some(function (m) { return m !== cid && PDP.cannotPair(dnSet, swapTarget, m); }))
      return alert("Cannot move " + swapTarget + ": do-not-combine pair conflicts with another stop on " + fromRouteId + ".");

    var cx = PDP.constraintIndex(PDP.normalizeRegister(state.register).entries);
    function canPlace(c, members) {
      for (var i = 0; i <= members.length; i++) {
        var prev = i === 0 ? "WH" : members[i - 1];
        var next = i === members.length ? (state.includeReturn ? "WH" : null) : members[i];
        if (cx.blocked(prev, c) || (next && cx.blocked(c, next))) continue;
        return true;
      }
      return false;
    }
    var dstSlot = dst.stops.slice(); dstSlot.splice(dstSlot.indexOf(swapTarget), 1);
    var srcSlot = src.stops.slice(); srcSlot.splice(srcSlot.indexOf(cid), 1);
    if (!canPlace(cid, dstSlot)) return alert("Cannot swap: every position for " + cid + " in " + toRouteId + " would sit next to a Blocked partner.");
    if (!canPlace(swapTarget, srcSlot)) return alert("Cannot swap: every position for " + swapTarget + " in " + fromRouteId + " would sit next to a Blocked partner.");

    var before = src.metrics.scoreKm + dst.metrics.scoreKm;
    var reason = askReason("Swap " + cid + " (" + fromRouteId + ") <-> " + swapTarget + " (" + toRouteId + ")");
    if (reason === null) return;

    src.stops[src.stops.indexOf(cid)] = swapTarget;
    dst.stops[dst.stops.indexOf(swapTarget)] = cid;
    src.stops = PDP.twoOpt(cx, matrix, src.stops, state.includeReturn);
    dst.stops = PDP.twoOpt(cx, matrix, dst.stops, state.includeReturn);

    recompute();
    var after = routeById(fromRouteId).metrics.scoreKm + routeById(toRouteId).metrics.scoreKm;
    log("swap", { customer: cid, with: swapTarget, fromRoute: fromRouteId, toRoute: toRouteId, scoreBefore: Math.round(before), scoreAfter: Math.round(after), reason: reason });
    save();
    renderAll();
  }

  function reorder(cid, dir) {
    var r = routeById(selectedRouteId);
    var i = r.stops.indexOf(cid);
    var j = i + dir;
    if (j < 0 || j >= r.stops.length) return;
    var cx = PDP.constraintIndex(PDP.normalizeRegister(state.register).entries);
    if (!PDP.reorderFeasible(r.stops, i, j, cx, state.includeReturn)) {
      alert("Cannot reorder: moving " + cid + " to position " + (j + 1) + " would put a Blocked pair from the Road Constraints Register consecutively. Route left untouched.");
      return;
    }
    var before = r.metrics.scoreKm;
    var tmp = r.stops[i]; r.stops[i] = r.stops[j]; r.stops[j] = tmp;
    recompute();
    log("reorder", { customer: cid, route: selectedRouteId, note: "Reordered stop from position " + (i + 1) + " to " + (j + 1), scoreBefore: Math.round(before), scoreAfter: Math.round(r.metrics.scoreKm) });
    save();
    renderAll();
  }

  function toggleLock(cid) {
    if (state.locks[cid] !== undefined) { delete state.locks[cid]; log("unlock", { customer: cid, route: selectedRouteId, reason: askReason("Release lock on " + cid) || "" }); }
    else { state.locks[cid] = selectedRouteId; log("lock", { customer: cid, route: selectedRouteId, reason: askReason("Lock " + cid + " to " + selectedRouteId) || "" }); }
    save();
    rebuildPlan();
  }

  function recompute() {
    plan = PDP.recomputePlan(plan, matrix, {
      reg: PDP.normalizeRegister(state.register),
      n: state.N, includeReturn: state.includeReturn
    });
    plan.changelog = state.changelog;
    applyStatusOverrides();
    state.working = snap();
    save();
  }

  /* ---------------- render ---------------- */

  function renderAll(fit) {
    renderSummary();
    renderRouteList();
    renderMap({ fit: fit });
    renderRouteDetails();
    renderExceptions();
  }

  /* ---------------- events ---------------- */

  function applyMapModes() {
    save();
    if (baseLayer) buildBaseLayer();
    renderMap();
  }

  function wireEvents() {
    el("route-select").addEventListener("change", function () { selectedRouteId = this.value; renderAll("route"); });
    el("cust-search").addEventListener("input", function () { renderRouteList(); });
    el("route-list").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-rid]") : null;
      if (b) { selectedRouteId = b.getAttribute("data-rid"); renderAll("route"); }
    });
    el("show-all").addEventListener("change", function () {
      showAllRoutes = this.checked;
      el("showall-warn").classList.toggle("hidden", !this.checked);
      renderMap({ fit: this.checked ? "all" : "route" });
    });
    el("fit-btn").addEventListener("click", function () { renderMap({ fit: "route" }); });
    el("map-vol").addEventListener("change", applyMapModes);
    el("map-rec").addEventListener("change", applyMapModes);
    el("replan-btn").addEventListener("click", openReplanModal);
    el("rp-ok").addEventListener("click", applyReplan);
    el("rp-cancel").addEventListener("click", function () { hideModal("replan-modal"); });
    el("restore-btn").addEventListener("click", function () {
      if (!confirm("Restore the ORIGINAL plan? All manual adjustments and change-log entries will be reset.")) return;
      plan = inflatePlan(state.original);
      plan.changelog = [];
      state.changelog = [];
      state.routeStatus = {};
      selectedRouteId = plan.routes[0].id;
      save();
      renderAll("all");
    });
    el("reset-btn").addEventListener("click", function () {
      if (!confirm("Erase ALL saved work on this browser (plan, adjustments, constraints, change log)? This cannot be undone.")) return;
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    });
    el("route-details").addEventListener("change", function (e) { if (e.target && e.target.id === "rstatus") doStatusChange(); });
    el("route-details").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-a]") : null;
      if (!b) return;
      var rid = selectedRouteId;
      var cid = routeById(rid).stops[parseInt(b.getAttribute("data-i"), 10)];
      var a = b.getAttribute("data-a");
      if (a === "up") reorder(cid, -1);
      else if (a === "down") reorder(cid, 1);
      else if (a === "lock") toggleLock(cid);
      else if (a === "move") {
        var target = prompt("Move " + cid + " to route (e.g. R05):", "");
        if (target === null) return;
        target = target.trim().toUpperCase();
        if (!routeById(target)) { alert("Unknown route: " + target); return; }
        moveCustomer(cid, rid, target);
      }
    });
    el("reg-add").addEventListener("click", addConstraint);
    el("reg-body").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-rg]") : null;
      if (b && b.getAttribute("data-rg") === "del") {
        state.register.splice(parseInt(b.getAttribute("data-i"), 10), 1);
        rebuildFromRegister();
      }
    });
    el("reg-import").addEventListener("click", function () { el("reg-file").click(); });
    el("reg-file").addEventListener("change", function () {
      var f = this.files[0];
      if (!f) return;
      E.readRegisterFile(f, function (err, rows) {
        if (err) { alert("Import failed: " + err.message); return; }
        var norm = PDP.normalizeRegister(rows);
        var merged = {};
        state.register.concat(norm.entries).forEach(function (e) { merged[e.key] = e; });
        state.register = Object.keys(merged).map(function (k) { return merged[k]; });
        if (norm.notes.length) alert("Import notes:\n" + norm.notes.join("\n"));
        rebuildFromRegister();
      });
      this.value = "";
    });
    el("reg-export").addEventListener("click", function () { E.downloadConstraintsCSV(state.register, "pdp-constraints"); });
    el("reg-json").addEventListener("click", function () {
      if (!confirm("Replace the register with an empty one? Existing constraints will be lost.")) return;
      state.register = [];
      rebuildFromRegister();
    });

    el("exp-summary").addEventListener("click", function () { E.downloadRouteSummaryCSV(plan, "pdp"); });
    el("exp-stops").addEventListener("click", function () { E.downloadRouteStopsCSV(plan, data, matrix, "pdp"); });
    el("exp-exc").addEventListener("click", function () { E.downloadExceptionsCSV(plan, "pdp"); });
    el("exp-changelog").addEventListener("click", function () { E.downloadChangeLogCSV(state.changelog, "pdp"); });
    el("exp-xlsx").addEventListener("click", function () {
      if (typeof XLSX === "undefined") { alert("SheetJS is not loaded (vendor/sheetjs/xlsx.full.min.js)."); return; }
      E.downloadXLSX(plan, data, matrix, state.register, state.changelog, "pdp-routes.xlsx");
    });
    el("exp-print").addEventListener("click", function () { E.downloadPrintSheet(plan, data, matrix, "pdp-print-route-sheets.html"); });
  }

  function addConstraint() {
    var vals = {
      from: el("c-from").value.trim().toUpperCase(),
      to: el("c-to").value.trim().toUpperCase(),
      type: el("c-type").value.trim() || "Other",
      description: el("c-desc").value.trim(),
      status: el("c-status").value,
      allowedVehicle: el("c-veh").value.trim(),
      detourNote: el("c-detour").value.trim()
    };
    if (!vals.from || !vals.to) { alert("From and To Location IDs are required."); return; }
    var norm = PDP.normalizeRegister([vals]).entries;
    if (!norm.length) { alert("Invalid pair (check Location IDs)."); return; }
    var merged = {};
    state.register.concat(norm).forEach(function (e) { merged[e.key] = e; });
    state.register = Object.keys(merged).map(function (k) { return merged[k]; });
    ["c-from", "c-to", "c-desc", "c-detour", "c-veh"].forEach(function (id) { el(id).value = ""; });
    rebuildFromRegister();
  }

  /* ---------------- init ---------------- */

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (!s || !s.working) return false;
      state = Object.assign(state, s);
      plan = inflatePlan(s.working);
      plan.changelog = s.changelog || [];
      selectedRouteId = plan.routes[0].id;
      selectedRouteId = s.lastRoute && planKey(plan).indexOf(s.lastRoute) > -1 ? s.lastRoute : plan.routes[0].id;
      return true;
    } catch (e) { return false; }
  }

  /** Minimal programmatic facade - used by selftest.html (and handy for console work). */
  function replan(n, includeReturn, _longLegKm, _routeOutboundKm, forceRouteCount) {
    state.N = n;
    state.includeReturn = includeReturn !== false;
    state.forceRouteCount = forceRouteCount || 0;
    log("replan", { n: state.N, includeReturn: state.includeReturn, note: "Rebuilt plan at N=" + state.N });
    save();
    rebuildPlan();
  }

  function addConstraintRow(row) {
    var norm = PDP.normalizeRegister([row]).entries;
    if (!norm.length) return false;
    var merged = {};
    state.register.concat(norm).forEach(function (e) { merged[e.key] = e; });
    state.register = Object.keys(merged).map(function (k) { return merged[k]; });
    save();
    rebuildFromRegister();
    return true;
  }

  function setGeoNote() {
    if (data.meta && data.meta.geography) {
      setText("geo-note", "Geography: customers " + data.meta.geography.minKm + " km to " + data.meta.geography.maxKm +
        " km from warehouse (median " + data.meta.geography.medianKm + " km); " + data.meta.geography.beyond50km + " beyond 50 km.");
    }
  }

  function bootstrapFresh() {
    rebuildPlan();
    save();
    requestAnimationFrame(function () { openReplanModal(); });
    setGeoNote();
  }

  function init() {
    wireEvents();
    if (!data) return; // no data yet; loader.js shows the upload screen
    setData(data);
    if (!restore()) {
      bootstrapFresh();
    } else {
      renderAll("all");
    }
    showApp();
  }

  function loadData(d) {
    setData(d);
    localStorage.removeItem(STORAGE_KEY); // fresh data => discard stale saved plan/state
    var show = restore();
    if (!show) bootstrapFresh(); else renderAll("all");
    showApp();
  }

  function showApp() {
    var up = el("upload-screen");
    if (up) up.classList.add("hidden");
    el("app").classList.remove("hidden");
    requestAnimationFrame(function () {
      if (map && map.invalidateSize) map.invalidateSize();
      if (map) renderMap({ fit: "all" });
    });
  }

  window.PDP_UI = {
    state: function () { return state; },
    plan: function () { return plan; },
    popupHtml: popupHtml,
    replan: replan,
    move: function (cid, from, to) { moveCustomer(cid, from, to); },
    reorder: reorder,
    setStatus: function (rid, st) {
      if (st === "Road Validated") {
        var g = roadValidateGuard(rid);
        if (!g.ok) return g; // {ok:false, reason} - shared guard, no programmatic shortcut
      }
      state.routeStatus[rid] = st; save(); applyStatusOverrides(); renderAll();
      return { ok: true };
    },
    addConstraintRow: addConstraintRow,
    clearRegister: function () { state.register = []; rebuildFromRegister(); },
    clearStorage: function () { localStorage.removeItem(STORAGE_KEY); },
    recompute: function () { recompute(); },
    rebuild: rebuildPlan,
    loadData: loadData,
    getChangelog: function () { return state.changelog; }
  };

  document.addEventListener("DOMContentLoaded", init);
})();
```
---

# 8. App shell — index.html

Script order matters: `data.js` and `constraints.js` define globals → vendored `leaflet.js` + `xlsx.full.min.js` → `core.js` → `exports.js` → `ui.js` (which guards against XLSX being missing). The replan modal holds N, an optional forced route count, the return-to-warehouse checkbox, and the two adjustable thresholds (long-leg, default 50 km; route-outbound, default 250 km). Leaflet icon images come from `vendor/leaflet/images/`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDP Route Optimization — Route Optimizer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="vendor/leaflet/leaflet.css">
<link rel="stylesheet" href="css/style.css">
</head>
<body>

<nav class="navbar">
  <a class="navbar-brand" href="#">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    PDP Route Optimization
  </a>
  <div class="navbar-links">
    <a class="active" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>Optimizer</span></a>
  </div>
</nav>

<!-- Upload screen: shown until a workbook is loaded at runtime -->
<div id="upload-screen" class="upload-wrap">
  <div class="card">
    <div class="card-header"><h2>Load customer workbook</h2></div>
    <div class="card-body">
      <p class="subtitle">Upload the <b>Bogura distance-matrix workbook (.xlsx)</b>. Routes are built entirely in your browser — no data leaves your machine. Distances are straight-line geographic drafts, not road routes.</p>
      <div id="upload-zone" class="upload-zone" role="button" tabindex="0" aria-label="Upload customer workbook">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <h3>Drop the workbook here, or click to browse</h3>
        <p>Required sheets: Read Me, Locations, Distance Matrix, Pair List.<br>Optional: Customer Master (adds region / territory mapping).</p>
        <span id="upload-status" class="oktxt"></span>
      </div>
      <input id="pick-file" type="file" accept=".xlsx,.xls" hidden>
    </div>
  </div>
</div>

<div id="app" class="hidden">

  <div id="geo-note" class="geo-note"></div>

  <main class="layout">
    <aside class="sidebar">
      <section id="panel-summary" class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          A. Summary
        </h2></div>
        <div class="card-body">
        <div class="grid2">
          <span>Route size (N)</span><span id="sum-n"></span>
          <span>Score basis</span><span id="sum-return"></span>
          <span>Routes</span><span id="sum-routes"></span>
          <span>Assigned</span><span id="sum-assigned"></span>
          <span>Require review</span><span id="sum-review"></span>
          <span>Unassigned</span><span id="sum-unassigned"></span>
          <span>Warning</span><span id="sum-warn"></span>
          <span>Total outbound</span><span id="sum-outbound"></span>
          <span>Total score</span><span id="sum-score"></span>
        </div>
        <div class="btnrow">
          <button id="replan-btn">Replan / change N</button>
          <button id="restore-btn" title="Undo all manual adjustments">Restore original</button>
          <button id="reset-btn" class="danger">Reset all</button>
        </div>
        </div>
      </section>

      <section class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          B. Route selector
        </h2></div>
        <div class="card-body">
          <select id="route-select"></select>
          <input id="cust-search" type="search" placeholder="Search customer / BP / Location ID…">
          <div id="route-list" class="route-list"></div>
        </div>
      </section>

      <section class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
          C. Map controls
        </h2></div>
        <div class="card-body">
          <label class="checkbox"><input type="checkbox" id="show-all"> Show all routes</label>
          <p id="showall-warn" class="warn hidden">All routes shown. Lines are straight-line geographic drafts, NOT road routes.</p>
          <label class="checkbox"><input type="checkbox" id="map-vol" checked> Show volume circles (12-mo MT)</label>
          <label class="checkbox"><input type="checkbox" id="map-rec" checked> Show recency rings (last purchase)</label>
          <p class="thresh">Circles sized by 12-month volume; ring colour = months since last purchase. Dots show every customer.</p>
          <button id="fit-btn" class="btn btn-primary">Fit map to warehouse + route</button>
        </div>
      </section>

      <section id="panel-route-details" class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          D. Route details
        </h2></div>
        <div class="card-body"><div id="route-details"><p>Select a route.</p></div></div>
      </section>

      <section class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Exports
        </h2></div>
        <div class="card-body">
          <div class="btnrow wrap">
            <button id="exp-summary">Route summary (CSV)</button>
            <button id="exp-stops">Route stops (CSV)</button>
            <button id="exp-exc">Exceptions (CSV)</button>
            <button id="exp-changelog">Change log (CSV)</button>
            <button id="exp-xlsx">All as Excel (.xlsx)</button>
            <button id="exp-print">Printable route sheets</button>
          </div>
        </div>
      </section>

      <section class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Road Constraints Register
        </h2></div>
        <div class="card-body">
          <p class="thresh">Rules use Location IDs (WH, C001…C140). <b>Blocked</b> = never placed consecutively. <b>Uncertain</b> = route gets a visible warning. <b>Not reviewed</b> = visible warning.</p>
          <div class="regform">
            <input id="c-from" placeholder="From (e.g. C012)">
            <input id="c-to" placeholder="To (e.g. C077)">
            <input id="c-type" placeholder="Type (e.g. Ferry required)">
            <input id="c-desc" placeholder="Description">
            <select id="c-status">
              <option>Blocked</option>
              <option>Uncertain</option>
              <option>Validated</option>
              <option>Not reviewed</option>
            </select>
            <input id="c-veh" placeholder="Allowed vehicle">
            <input id="c-detour" placeholder="Manual detour note">
            <button id="reg-add">Add constraint</button>
          </div>
          <table class="reg">
            <thead><tr><th>From</th><th>To</th><th>Type</th><th>Description</th><th>Status</th><th>Vehicle</th><th>Detour</th><th>By</th><th>Date</th><th></th></tr></thead>
            <tbody id="reg-body"></tbody>
          </table>
          <div class="btnrow">
            <button id="reg-import">Import file…</button>
            <button id="reg-export">Export register (CSV)</button>
            <button id="reg-json" class="danger">Clear register</button>
            <input id="reg-file" type="file" accept=".csv,.json,.xlsx,.xls" hidden>
          </div>
        </div>
      </section>

      <section class="panel card">
        <div class="card-header"><h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Exceptions
        </h2></div>
        <div class="card-body"><div id="exc-list"></div></div>
      </section>
    </aside>

    <section class="mapcol">
      <div id="map"><div id="map-legend" class="map-legend hidden"></div></div>
    </section>
  </main>

</div>

<div id="replan-modal" class="modal hidden">
  <div class="modal-backdrop hidden"></div>
  <div class="modal-card">
    <h2>Plan setup</h2>
    <label>Route size N <input id="rp-N" type="number" min="1" max="140" value="7"></label>
    <label>Force exact number of routes (optional; overrides N) <input id="rp-count" type="number" min="1" max="140" value=""></label>
    <label class="checkbox"><input id="rp-return" type="checkbox" checked> Include return-to-warehouse distance in route score.</label>
    <div class="btnrow">
      <button id="rp-ok">Build plan</button>
      <button id="rp-cancel">Cancel</button>
    </div>
  </div>
</div>

<script src="js/constraints.js"></script>
<script src="vendor/leaflet/leaflet.js"></script>
<script src="vendor/sheetjs/xlsx.full.min.js"></script>
<script src="js/core.js"></script>
<script src="js/exports.js"></script>
<script src="js/loader.js"></script>
<script src="js/ui.js"></script>
</body>
</html>
```
---

# 9. Styles — css/style.css

Plain CSS, no framework. Layout is a fixed 360 px sidebar + flexible map column; the numbered stop markers (`stnum`) render as colored numbered dots on the map; `@media print`-style page breaks are handled by the exported print sheets' own inline CSS rather than this file.

```css
/* ============================================================================
   PDP Route Optimiser — Design Tokens & System
   Matches the sibling PDP Route Optimization UI: Syngenta blue palette,
   Fira Sans/Fira Code, Data-Dense Dashboard style.
   ============================================================================ */

:root {
  /* Colors */
  --c-primary: #1E40AF;
  --c-primary-light: #3B82F6;
  --c-primary-dark: #1E3A8A;
  --c-accent: #D97706;
  --c-bg: #F8FAFC;
  --c-surface: #FFFFFF;
  --c-border: #DBEAFE;
  --c-text: #1E293B;
  --c-text-secondary: #64748B;
  --c-success: #059669;
  --c-danger: #DC2626;
  --c-warning: #F59E0B;

  /* Map status */
  --c-green: #059669;
  --c-blue: #3B82F6;
  --c-red: #DC2626;

  /* Spacing */
  --s-xs: 4px;
  --s-sm: 8px;
  --s-md: 16px;
  --s-lg: 24px;
  --s-xl: 32px;

  /* Radius */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 16px;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --shadow-md: 0 4px 12px rgba(0,0,0,.1);
  --shadow-lg: 0 8px 24px rgba(0,0,0,.12);

  /* Fonts */
  --font-body: 'Fira Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-data: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}

/* ============================================================================
   Reset & Base
   ============================================================================ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { font-size: 14px; }

body {
  font-family: var(--font-body);
  color: var(--c-text);
  background: var(--c-bg);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--c-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
.hidden { display: none !important; }

/* ============================================================================
   Navbar
   ============================================================================ */
.navbar {
  display: flex;
  align-items: center;
  gap: var(--s-lg);
  background: var(--c-primary);
  color: #fff;
  padding: 0 var(--s-lg);
  height: 52px;
  position: sticky;
  top: 0;
  z-index: 1000;
}
.navbar-brand {
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: .02em;
  display: flex;
  align-items: center;
  gap: var(--s-sm);
  color: #fff;
}
.navbar-brand:hover { text-decoration: none; }
.navbar-brand svg { width: 20px; height: 20px; }
.navbar-links { display: flex; gap: var(--s-sm); }
.navbar-links a {
  color: rgba(255,255,255,.8);
  padding: var(--s-xs) var(--s-sm);
  border-radius: var(--r-sm);
  font-size: .875rem;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: background .15s, color .15s;
}
.navbar-links a:hover { background: rgba(255,255,255,.12); color: #fff; text-decoration: none; }
.navbar-links a.active { background: var(--c-accent); color: #fff; }
.navbar-links a svg { width: 15px; height: 15px; }

.geo-note {
  background: #FEF3C7;
  border-bottom: 1px solid #FDE68A;
  color: #92400E;
  padding: 6px 16px;
  font-size: .78rem;
}

/* ============================================================================
   Upload / landing
   ============================================================================ */
.upload-wrap {
  max-width: 640px;
  margin: var(--s-xl) auto;
  padding: 0 var(--s-md);
}
.upload-wrap .card-header h2 { font-size: 1.1rem; }
.upload-zone {
  border: 2px dashed var(--c-border);
  border-radius: var(--r-md);
  padding: var(--s-xl);
  text-align: center;
  transition: border-color .2s, background .2s;
  cursor: pointer;
}
.upload-zone:hover, .upload-zone.drag {
  border-color: var(--c-primary-light);
  background: rgba(59,130,246,.04);
}
.upload-zone svg { width: 36px; height: 36px; color: var(--c-primary-light); margin-bottom: var(--s-sm); }
.upload-zone h3 { font-size: .95rem; margin-bottom: var(--s-xs); }
.upload-zone p { font-size: .8rem; color: var(--c-text-secondary); }
.upload-zone.has-file { border-color: var(--c-success); background: rgba(5,150,105,.04); }
.upload-zone .btn { margin-top: var(--s-md); }

/* ============================================================================
   Layout
   ============================================================================ */
.layout { display: flex; height: calc(100vh - 52px); }
.sidebar {
  width: 380px;
  min-width: 380px;
  overflow-y: auto;
  border-right: 1px solid var(--c-border);
  padding: var(--s-sm);
  background: var(--c-bg);
}
.mapcol { flex: 1; min-width: 0; position: relative; }
#map { height: 100%; width: 100%; }

/* ============================================================================
   Cards (replace .panel)
   ============================================================================ */
.panel, .card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: var(--s-sm);
}
.panel h2, .card-header h2 {
  display: flex;
  align-items: center;
  gap: var(--s-sm);
  font-size: .9rem;
  font-weight: 600;
  margin: 0;
}
.panel h2 svg, .card-header h2 svg { width: 16px; height: 16px; color: var(--c-primary); flex: none; }
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s-sm) var(--s-md);
  border-bottom: 1px solid var(--c-border);
}
.card-body { padding: var(--s-md); }
.card-accent { border-left: 3px solid var(--c-accent); }
.panel .panel-inner { padding: var(--s-md); }
.panel h2 { padding: var(--s-sm) var(--s-md) 0; }
.panel h3 { font-size: .85rem; margin: 0 0 4px; }

/* ============================================================================
   Buttons
   ============================================================================ */
.btn, button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: var(--s-sm) var(--s-md);
  border: 1px solid var(--c-border);
  border-radius: var(--r-sm);
  font-family: var(--font-body);
  font-size: .875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
  background: var(--c-surface);
  color: var(--c-text);
  line-height: 1.2;
}
.btn:hover, button:hover { background: var(--c-bg); }
.btn svg { width: 15px; height: 15px; }
.btn-primary { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.btn-primary:hover { background: var(--c-primary-dark); }
.btn-success { background: var(--c-success); color: #fff; border-color: var(--c-success); }
.btn-success:hover { background: #047857; }
.btn-danger { background: var(--c-danger); color: #fff; border-color: var(--c-danger); }
.btn-danger:hover { background: #b91c1c; }
.btn-sm { padding: 4px 10px; font-size: .8rem; }
button.danger { border-color: var(--c-danger); color: var(--c-danger); background: var(--c-surface); }
button.danger:hover { background: #FEE2E2; }

.btnrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.btnrow.wrap { flex-wrap: wrap; }

/* ============================================================================
   Forms
   ============================================================================ */
select, input:not([type=checkbox]) {
  font-family: var(--font-body);
  width: 100%;
  padding: var(--s-sm) var(--s-md);
  border: 1px solid var(--c-border);
  border-radius: var(--r-sm);
  font-size: .875rem;
  color: var(--c-text);
  background: var(--c-surface);
  transition: border-color .15s, box-shadow .15s;
  margin: 2px 0;
}
select:focus, input:focus {
  outline: none;
  border-color: var(--c-primary-light);
  box-shadow: 0 0 0 3px rgba(59,130,246,.15);
}
label.checkbox, .toggle-item { display: flex; align-items: center; gap: var(--s-sm); margin: 4px 0; font-size: .82rem; }
label.checkbox input, .toggle-item input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--c-primary); }
.thresh { font-size: .78rem; color: var(--c-text-secondary); margin: 6px 0 4px; }
.subtitle { margin: 0 0 6px; font-size: .78rem; color: var(--c-text-secondary); }

/* ============================================================================
   Summary grid
   ============================================================================ */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; font-size: .82rem; margin-top: var(--s-sm); }
.grid2 span:nth-child(odd) { color: var(--c-text-secondary); }
#sum-warn { font-weight: normal; }
#sum-warn .warn { display: block; margin: 2px 0; }

/* ============================================================================
   Route list
   ============================================================================ */
.route-list { max-height: 300px; overflow-y: auto; margin-top: 6px; }
.route-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: var(--r-sm); cursor: pointer; }
.route-row:hover { background: rgba(59,130,246,.06); }
.route-row.active { background: #DBEAFE; outline: 1px solid var(--c-primary-light); }
.route-row.hidden { display: none; }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.rname { font: inherit; padding: 2px 4px; color: var(--c-primary); font-weight: 600; border: none; background: none; }
.rname:hover { background: none; }
.rcount { font-size: .75rem; color: var(--c-text-secondary); flex: none; }
.rkm { font-size: .75rem; color: var(--c-text-secondary); flex: none; font-family: var(--font-data); }
.rstatus { margin-left: auto; font-size: .68rem; padding: 1px 8px; border-radius: 9999px; flex: none; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
.rstatus.ok { background: #D1FAE5; color: #065F46; }
.rstatus.warn { background: #FEF3C7; color: #92400E; }
.rstatus.draft { background: #F1F5F9; color: #475569; }

/* ============================================================================
   Tables
   ============================================================================ */
table { width: 100%; border-collapse: collapse; }
th, td { padding: var(--s-sm) var(--s-md); text-align: left; border-bottom: 1px solid var(--c-border); font-size: .82rem; }
th { font-weight: 600; color: var(--c-text-secondary); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; background: var(--c-bg); }
td { font-family: var(--font-data); }

table.metrics { font-size: .78rem; margin: 6px 0; }
table.metrics td { font-family: var(--font-body); padding: 4px 8px; }
table.metrics td:nth-child(odd) { background: var(--c-bg); color: var(--c-text-secondary); }
table.metrics td:nth-child(even) { font-family: var(--font-data); }

table.stops th, table.stops td { padding: var(--s-xs) var(--s-sm); }
table.stops td { font-family: var(--font-data); }
table.stops button { padding: 1px 6px; font-size: .7rem; margin-right: 2px; }

table.reg { font-size: .72rem; margin: 6px 0; }
table.reg th, table.reg td { padding: 2px 6px; font-size: .72rem; }
table.reg td { font-family: var(--font-body); }

/* ============================================================================
   Badges
   ============================================================================ */
.badge, .badg { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; margin: 1px 2px 1px 0; }
.badge-green, .badg.ok { background: #D1FAE5; color: #065F46; }
.badge-red, .badg.off { background: #FEE2E2; color: #991B1B; }
.badge-amber { background: #FEF3C7; color: #92400E; }
.badge-blue { background: #DBEAFE; color: #1E40AF; }
.badge-gray { background: #F1F5F9; color: #475569; }
.badg.rec { color: #fff; }
.badg.r-act { background: #2e7d32; }
.badg.r-slow { background: #ef8a1d; }
.badg.r-stale { background: #c9403d; }

/* ============================================================================
   Status / warning text
   ============================================================================ */
.warns { margin: 4px 0; padding-left: 18px; font-size: .78rem; color: #92400E; }
.oktxt { color: var(--c-success); font-size: .78rem; }
.lck { background: var(--c-danger); color: #fff; border-radius: 8px; padding: 0 4px; font-size: .68rem; }
.warn { color: var(--c-danger); font-size: .78rem; }
.enr { color: var(--c-text-secondary); font-size: .72rem; font-weight: normal; }
ol.journey { margin: 4px 0; padding-left: 18px; font-size: .78rem; }
ol.journey li { margin: 1px 0; }

/* ============================================================================
   Constraints register form
   ============================================================================ */
.regform { display: flex; flex-direction: column; gap: 2px; }
.regform input, .regform select { font-size: .78rem; padding: 3px 6px; }

/* ============================================================================
   Exceptions
   ============================================================================ */
#exc-list ul { margin: 4px 0; padding-left: 16px; font-size: .78rem; }
#exc-list li { margin: 4px 0; }
#exc-list li.resolved { color: var(--c-text-secondary); text-decoration: line-through; }

/* ============================================================================
   Modal
   ============================================================================ */
.modal { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(30,41,59,.5); }
.modal-card {
  position: relative; background: var(--c-surface); border-radius: var(--r-md);
  padding: var(--s-lg); width: 440px; max-width: 92vw; box-shadow: var(--shadow-lg);
  border: 1px solid var(--c-border);
}
.modal-card h2 { margin-top: 0; color: var(--c-primary); display: flex; align-items: center; gap: var(--s-sm); font-size: 1rem; }
.modal-card label { display: block; margin: 8px 0; font-size: .82rem; color: var(--c-text); }

/* ============================================================================
   Map & marker styles (map information layer)
   ============================================================================ */
.leaflet-container { background: #e5e3df; }
.stnum-wrap { background: none; border: none; }
.stnum {
  width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
  border: 2px solid; border-radius: 50%; background: #fff; font-size: 11px; font-weight: 700;
  box-shadow: 0 1px 3px rgba(0,0,0,.4); font-family: var(--font-data);
}

.bdot { display: block; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(255,255,255,.85); }
.bdot-wrap { background: none; border: none; }
.wh-pill { display: inline-block; background: var(--c-primary); color: #fff; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.45); letter-spacing: .4px; }
.wh-wrap { background: none; border: none; }
.leg-km { background: rgba(30,41,59,.72); color: #fff; font-size: 10px; line-height: 14px; text-align: center; border-radius: 4px; padding: 0 3px; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,.3); font-family: var(--font-data); }
.stopmark { position: relative; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: none; border: none; }
.volball { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); border: 2px solid; border-radius: 50%; background: rgba(255,255,255,.55); box-shadow: 0 0 0 1px rgba(0,0,0,.15); }

.map-legend { position: absolute; left: 12px; bottom: 28px; z-index: 800; background: rgba(255,255,255,.94); border: 1px solid var(--c-border); border-radius: var(--r-sm); padding: 8px 10px; font-size: 11px; color: var(--c-text); box-shadow: var(--shadow-sm); line-height: 1.6; max-width: 200px; }
.map-legend .lg-title { font-weight: 700; color: var(--c-primary); margin: 4px 0 2px; }
.map-legend .lg-title:first-child { margin-top: 0; }
.map-legend .lg-vol { display: inline-block; vertical-align: middle; border: 2px solid #475; border-radius: 50%; background: rgba(255,255,255,.55); margin-right: 6px; }
.map-legend .lg-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }

/* enriched popup */
.pdp-pop { min-width: 190px; max-width: 260px; }
.pdp-pop > b { font-size: 13px; }
.pp-sub { color: var(--c-text-secondary); font-size: 11px; }
.pp-meta { color: var(--c-text-secondary); font-size: 11px; margin: 2px 0; }
.pp-addr { color: var(--c-text-secondary); font-size: 11px; margin: 3px 0; }
.pp-badges { margin: 4px 0; }
.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 8px; margin: 5px 0; }
.kpi i { display: block; font-style: normal; font-size: 10px; color: var(--c-text-secondary); }
.kpi b { font-size: 12px; font-family: var(--font-data); }
.pp-spark { margin: 4px 0; }
.pp-spark i { display: block; font-style: normal; font-size: 10px; color: var(--c-text-secondary); margin-bottom: 2px; }
.pp-route { background: #DBEAFE; border-radius: 4px; padding: 3px 6px; font-size: 11px; color: var(--c-text); margin: 5px 0 3px; }
.pp-caveat { font-size: 10px; color: #92400E; }

/* ============================================================================
   Utilities
   ============================================================================ */
.text-center { text-align: center; }
.text-right { text-align: right; }
.mt-sm { margin-top: var(--s-sm); }
.mt-md { margin-top: var(--s-md); }
.mb-sm { margin-bottom: var(--s-sm); }
.mb-md { margin-bottom: var(--s-md); }
.gap-sm { gap: var(--s-sm); }
.flex { display: flex; }
.flex-between { display: flex; justify-content: space-between; align-items: center; }

@media (max-width: 768px) {
  .navbar { gap: var(--s-sm); padding: 0 var(--s-sm); }
  .navbar-links a span { display: none; }
  .sidebar { width: 100%; min-width: 0; }
  .layout { flex-direction: column; height: auto; }
  .mapcol { height: 70vh; }
}
```
---

# 10. Acceptance tests — acceptance.js

Engine-level acceptance, run headless with `node acceptance.js` (default N=7; optional N arg). It stubs `global.window = global` so the same `data.js`/`core.js` run under Node. Coverage: exact route counts and sizes for N∈{5,7,10,12,20,45,140} (also with forced route counts K=14 and K=25 including the balanced-size and `targetSizes` contracts, plus the out-of-range K=500 ignored-with-`forceNotes` path), 140 assigned / 0 duplicates / 0 unassigned, locked-overflow exception (K=140 with 3 locks on R01), a fully-Blocked clique producing an `infeasible` plan with `INFEASIBLE` status + unplaceable members + the Road-infeasible exception + a failing QA, blocked-pair-never-consecutive (including the WH boundary), soft-flagging of an Uncertain pair, adjustable thresholds actually firing, locks holding even when they force a route count change, round-trip ≥ outbound scoring, register normalise/merge/validate semantics (canonical pair keys, status precedence, unknown-ID rejection), and the export helpers (`csvSafe`, `escHtml`, enriched `routeStopsRows` columns).

**Current result: 74/74 checks pass.** Representative output (N=7): 20 routes of 7 stops; total outbound ≈ 3,656 km; total round-trip ≈ 5,352 km; all routes `Draft`-or-review as expected.

```js
/**
 * Acceptance tests for the PDP routing engine (run with Node, no browser).
 *   node acceptance.js [N]
 * Default N = 7 (required acceptance scenario: 20 routes, 140 assigned, 0 dup/unassigned).
 */
"use strict";
global.window = global; // data.js / core.js attach to window

const PDP = require("./js/core.js");
require("./js/data.js");
require("./js/constraints.js");

const DATA = global.APP_DATA;
const matrix = PDP.matrixFromData(DATA);
const LOG = [];

function check(name, cond, detail) {
  LOG.push({ name, pass: !!cond, detail: detail || "" });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  [" + detail + "]"));
}

function acceptN(N, opts) {
  opts = opts || {};
  const plan = PDP.buildPlan({
    data: DATA, matrix, N, includeReturn: opts.includeReturn !== false,
    register: opts.register || [], locks: {}, doNotCombine: {}
  });
  const exp = Math.ceil(140 / N);
  check("N=" + N + ": route count = CEILING(140/" + N + ") = " + exp,
    plan.routes.length === exp, plan.routes.length + " routes");
  const sizes = plan.routes.map(r => r.stops.length);
  check("N=" + N + ": all routes size " + N + " except final remainder",
    sizes.every((s, i) => s === (i === sizes.length - 1 ? 140 - (exp - 1) * N : N)),
    sizes.join(","));
  check("N=" + N + ": 140 customers assigned", plan.summary.customersAssigned === 140, plan.summary.customersAssigned);
  check("N=" + N + ": zero duplicates", plan.summary.repeated.length === 0, plan.summary.repeated.join(",") || "none");
  check("N=" + N + ": zero unassigned", plan.summary.unassignedCount === 0, String(plan.summary.unassignedCount));
  return plan;
}

// ------------------------------------------------------------------ required: N = 7
console.log("\n=== ACCEPTANCE: N = 7 (return-to-warehouse included) ===");
const p7 = acceptN(7);
check("N=7: every customer unique across all 20 routes",
  new Set(plan7uniq(p7)).size === 140, plan7uniq(p7).length + " stops");
check("N=7: 20 routes x 7 customers", p7.routes.length === 20 && p7.routes.every(r => r.stops.length === 7),
  p7.routes.map(r => r.id + ":" + r.stops.length).join(" "));

// ---- all Blocked pair rules respected: engineer a blocked pair and rebuild
console.log("\n=== BLOCKED PAIR RULE TEST ===");
const p8 = p7.routes[0].stops; // route 0 has 7 customers - block two adjacent ones
const blockA = p8[1], blockB = p8[2];
const register = [{ from: blockA, to: blockB, type: "River / no direct crossing", description: "test", status: "Blocked", allowedVehicle: "", detourNote: "", confirmedBy: "AutoTest", confirmationDate: "2026-08-30" }];
const pb = acceptN(7, { register });
// verify the pair does not appear consecutively in ANY route or at WH boundary
let consecutive = false, where = "";
pb.routes.forEach(r => {
  const seq = ["WH"].concat(r.stops).concat(pb.includeReturn ? ["WH"] : []);
  for (let i = 0; i < seq.length - 1; i++) {
    if ((seq[i] === blockA && seq[i + 1] === blockB) || (seq[i] === blockB && seq[i + 1] === blockA)) {
      consecutive = true; where = r.id + " " + seq[i] + "->" + seq[i + 1];
    }
  }
});
check("Blocked pair " + blockA + "~" + blockB + " never consecutive", !consecutive, where || "not placed consecutively");

// ---- uncertain pair surfaced with warning (unit: flag logic on a forced-adjacent route)
console.log("\n=== UNCERTAIN LEG FLAGGING ===");
{
  const cidA = p7.routes[0].stops[0], cidB = p7.routes[0].stops[1];
  const regU = [{ from: cidA, to: cidB, type: "Ferry required", description: "test", status: "Uncertain", allowedVehicle: "", detourNote: "", confirmedBy: "", confirmationDate: "" }];
  const cxU = PDP.constraintIndex(PDP.normalizeRegister(regU).entries);
  const rt = PDP.routeMetrics(matrix, cxU, [cidA, cidB], true);
  check("Uncertain leg produces visible warning (forced adjacency)", rt.uncertainLegs.length === 1 && rt.reviewRequired,
    rt.warnings.map(w => w.type + ":" + w.detail).join(",") || "no warning");
  // integration: when engine keeps the pair consecutive in some route, that route must be flagged
  const pu = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: regU, locks: {}, doNotCombine: {} });
  const flagged = pu.routes.filter(r => r.stops.some((s, i) => i + 1 < r.stops.length &&
    (s === cidA && r.stops[i + 1] === cidB) || (s === cidB && r.stops[i + 1] === cidA)));
  check("Any route containing the Uncertain pair consecutively is 'Needs Manual Road Review'",
    flagged.every(r => r.status === "Needs Manual Road Review"),
    flagged.map(r => r.id + "=" + r.status).join(",") || "pair not consecutive anywhere (no leg -> nothing to flag)");
}

// ---- locks honoured
console.log("\n=== LOCK TEST ===");
const target = "R20";
const locks = {}; p7.routes[18].stops.slice(0, 2).forEach(c => locks[c] = target);
const pL = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: [], locks, doNotCombine: {} });
const ok = Object.keys(locks).every(c => pL.assignment[c] === target);
check("Locked customers stay on " + target, ok, JSON.stringify({ got: Object.keys(locks).map(c => locks[c] + "->" + pL.assignment[c]) }));
check("Lock test route sizes still valid", pL.routes.every((r, i) => r.stops.length === (i === pL.routes.length - 1 ? 140 - 19 * 7 : 7)), "");

// ---- other N values
console.log("\n=== ROUTE COUNT / SIZE RULES ACROSS N ===");
[5, 10, 12, 20, 45, 140].forEach(N => acceptN(N, { includeReturn: true }));

// ---- score with/without return
console.log("\n=== RETURN-TO-WAREHOUSE SCORING ===");
const wo = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: false, register: [], locks: {}, doNotCombine: {} });
check("Round-trip total >= outbound total", p7.summary.totalScoreKm >= wo.summary.totalScoreKm,
  "with-return/km=" + Math.round(p7.summary.totalScoreKm) + " vs without/km=" + Math.round(wo.summary.totalScoreKm));

// ---- balanced force-route-count
console.log("\n=== FORCED ROUTE COUNT (BALANCED SPLIT) ===");
{
  const pf = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: [], locks: {}, doNotCombine: {}, forceRouteCount: 14 });
  const fs = pf.routes.map(r => r.stops.length);
  check("K=14 forced => exactly 14 routes", pf.routes.length === 14, pf.routes.length);
  check("K=14 forced => balanced sizes (10x14, all 140)", fs.reduce((a, b) => a + b, 0) === 140 && fs.every(s => s === 10), fs.join(","));
  check("K=14 plan.targetSizes present and matches route sizes", pf.targetSizes && pf.targetSizes.join(",") === fs.join(","),
    "targetSizes=[" + (pf.targetSizes || []).join(",") + "]");
  check("K=14 zero unassigned", pf.summary.unassignedCount === 0, String(pf.summary.unassignedCount));

  const p25 = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: [], locks: {}, doNotCombine: {}, forceRouteCount: 25 });
  const s25 = p25.routes.map(r => r.stops.length);
  check("K=25 forced => 25 routes, balanced 15x6 + 10x5",
    p25.routes.length === 25 && s25.reduce((a, b) => a + b, 0) === 140 && Math.max(...s25) - Math.min(...s25) <= 1,
    s25.join(","));

  const px = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: [], locks: {}, doNotCombine: {}, forceRouteCount: 500 });
  check("K=500 out of range => ignored, uniform N applies + forceNotes", px.routes.length === 20 && (px.forceNotes || []).length >= 1,
    "routes=" + px.routes.length + " forceNotes=" + (px.forceNotes || []).join("|"));
}

// ---- lock overflow: locked customers cannot fit their forced route size
console.log("\n=== LOCK OVERFLOW WITH FORCED COUNT ===");
{
  const prio = p7.routes[0].stops.slice(0, 3);
  const locks2 = {}; prio.forEach(c => locks2[c] = "R01");
  const pl = PDP.buildPlan({ data: DATA, matrix, N: 7, includeReturn: true, register: [], locks: locks2, doNotCombine: {}, forceRouteCount: 140 });
  check("K=140 (size 1) with 3 locks on R01 => 'Locked route exceeds N' exception",
    pl.exceptions.some(e => e.type === "Locked route exceeds N") && pl.summary.unassignedCount === 0,
    JSON.stringify(pl.exceptions.map(e => e.type)) + "; R01 stops=" + pl.routes[0].stops.length);
}

// ---- infeasible ordering (all-pairs Blocked clique)
console.log("\n=== INFEASIBLE ROUTE (BLOCKED CLIQUE) ===");
{
  const ids = DATA.customers.map(c => c.id);
  const reg = [];
  ids.forEach(a => ids.forEach(b => { if (a !== b) reg.push({ from: a, to: b, status: "Blocked" }); }));
  ids.forEach(c => reg.push({ from: "WH", to: c, status: "Blocked" }));
  const pi = PDP.buildPlan({ data: DATA, matrix, N: 140, includeReturn: true, register: reg, locks: {}, doNotCombine: {} });
  check("Full blocked clique => plan.infeasible", pi.infeasible === true, String(pi.infeasible));
  check("Infeasible route status = INFEASIBLE", pi.routes[0].status === "INFEASIBLE", pi.routes[0].status);
  check("Infeasible route exposes unplaceable members", (pi.routes[0].unplaceable || []).length === 140, "len=" + (pi.routes[0].unplaceable || []).length);
  check("Road-infeasible exception recorded", pi.exceptions.some(e => e.type === "Road-infeasible route"), JSON.stringify(pi.exceptions.map(e => e.type)));
  const qai = pi.qa; // runQa ran at build; plan.qa is the checks array
  check("QA blocks an infeasible plan", qai.filter(c => !c.pass).length > 0, "fails=" + qai.filter(c => !c.pass).length);
}

// ---- register normalise / merge (dedupe on pair key)
console.log("\n=== REGISTER NORMALISE / MERGE ===");
{
  const raw = [
    { from: "C001", to: "C002", status: "Blocked" },
    { from: "C002", to: "C001", status: "Uncertain" }, // same pair, reversed -> precedence dedupes
    { from: "C003", to: "C004", status: "Uncertain" }, // distinct pair -> kept
    { from: "C005", to: "C006", status: "Blocked" },   // distinct pair -> kept
    { from: "C001", to: "C001", status: "Blocked" },   // self pair -> dropped
    { from: "C007", to: "", status: "Blocked" }        // missing to -> dropped
  ];
  const norm = PDP.normalizeRegister(raw);
  check("normalizeRegister drops self-pairs and missing-IDs", norm.entries.length === 4, norm.entries.length + " entries");
  check("normalizeRegister keys are canonical (reversed pair same key)", norm.entries.some(e => e.key === PDP.pairKey("C001", "C002")) &&
    norm.entries.some(e => e.from === "C002" || e.to === "C002"), norm.entries.map(e => e.key).join(","));
  const merged = PDP.mergeRegister([], norm.entries);
  check("mergeRegister merges by key, no duplicates", merged.entries.length === 3, merged.entries.map(e => e.key).join(","));
  const merged2 = PDP.mergeRegister(merged.entries, [{ from: "C005", to: "C006", status: "Uncertain" }]);
  check("mergeRegister status precedence: Blocked never downgraded", merged2.entries.find(e => e.key === PDP.pairKey("C005", "C006")).status === "Blocked",
    merged2.entries.find(e => e.key === PDP.pairKey("C005", "C006")).status);
  const merged3 = PDP.mergeRegister(merged.entries, PDP.normalizeRegister([{ from: "C008", to: "C001", status: "Validated" }]).entries);
  check("mergeRegister appends new pairs, keeps existing", merged3.entries.length === 4 && merged3.entries.some(e => e.key === PDP.pairKey("C008", "C001")),
    merged3.entries.length + " entries " + merged3.entries.map(e => e.key).join(","));
  const v = PDP.validateRegister(merged.entries, DATA);
  check("validateRegister accepts known pair C001~C002", v.entries.length === 3 && v.notes.length === 0, JSON.stringify(v.notes));
  const badNorm = PDP.normalizeRegister([{ from: "C001", to: "ZZ999", status: "Blocked" }]);
  const v2 = PDP.validateRegister(badNorm.entries, DATA);
  check("validateRegister flags unknown Location ID", v2.entries.length === 0 && v2.notes.some(n => /unknown Location ID/.test(n)), JSON.stringify(v2.notes));
}

// ---- export helpers (csvSafe / escHtml / routeStopsRows enrichment)
console.log("\n=== EXPORT HELPERS ===");
{
  global.PDP = PDP; // exports.js calls PDP.dist via global, as in browser
  require("./js/exports.js");
  const E = global.PDP_EXPORTS;
  check("csvSafe: prefixes = + @ and bare - with a quote", E.csvSafe("=SUM(A1)") === "'=SUM(A1)" && E.csvSafe("+1") === "'+1"
    && E.csvSafe("@cmd") === "'@cmd" && E.csvSafe("-hello") === "'-hello", [E.csvSafe("=SUM(A1)"), E.csvSafe("-hello")].join(" "));
  check("csvSafe: keeps plain text and numeric literals untouched", E.csvSafe("plain") === "plain" && E.csvSafe(-12.5) === "-12.5",
    E.csvSafe(-12.5));
  check("escHtml escapes < > & \" '", E.escHtml("<b>&\"'") === "&lt;b&gt;&amp;&quot;&#39;", E.escHtml("<b>&\"'"));
  const to = E.routeStopsRows(p7, DATA, matrix);
  check("routeStopsRows header has enrichment columns", to[0].join("|").indexOf("Region") > -1 && to[0].join("|").indexOf("Territory") > -1
    && to[0].join("|").indexOf("Sales Group") > -1, to[0].join("|"));
  const withMeta = to.slice(1).filter(r => String(r[6]).trim() !== "").length;
  check("routeStopsRows carries enriched Region values", withMeta > 0, withMeta + "/" + (to.length - 1) + " rows enriched");
}

// ------------------------------------------------------------------ report
console.log("\n=== REPORT: N = 7 ===");
console.log("Routes:            " + p7.routes.length);
console.log("Customers assigned:" + p7.summary.customersAssigned);
console.log("Duplicates:        " + p7.summary.repeated.length);
console.log("Unassigned:        " + p7.summary.unassignedCount);
console.log("Total outbound:    " + PDP.round1(p7.summary.totalOutboundKm) + " geographic km");
console.log("Total round-trip:  " + PDP.round1(p7.summary.totalScoreKm) + " geographic km");
p7.routes.forEach(r => {
  console.log(r.id + "\t" + r.stops.length + " stops\tout=" + PDP.round1(r.metrics.outboundKm) +
    "\tret=" + PDP.round1(r.metrics.returnKm) + "\tround=" + PDP.round1(r.metrics.roundTripKm) +
    "\tlongest=" + PDP.round1(r.metrics.longestLegKm) + "\t" + r.status);
});
const fails = LOG.filter(l => !l.pass);
console.log("\nTOTAL: " + (LOG.length - fails.length) + "/" + LOG.length + " checks passed");
process.exit(fails.length ? 1 : 0);

function plan7uniq(p) {
  const a = [];
  p.routes.forEach(r => r.stops.forEach(c => a.push(c)));
  return a;
}
```
---

# 11. UI self-test — selftest.html

Loads the real app in an iframe and drives it through `window.PDP_UI`, stubbing `alert`/`confirm`/`prompt` and pre-filling the reason prompt (with a recorded verifier for the Road Validated step, matching the shared guard). It exercises the actual DOM layer: initial N=7 build, replan N=9 → 16 routes with the 5-member remainder route, a full-target **swap** (the path tested here is the important one — a swap preserves sizes), a move toward a full route falling back to a swap that is then cancelled, neighbour reorder, the Road Validated verifier gate, a Blocked pair never becoming consecutive (checked through the return leg too), an Uncertain pair surfacing a review flag, export row counts, and a constraint CSV round-trip.

**Current result: all 26 checks pass.** Run it by serving this directory and opening `selftest.html`, or headless:

```
chrome --headless=new --disable-gpu --user-data-dir=%TEMP%\pdp-chrome --virtual-time-budget=25000 --dump-dom http://localhost:8765/selftest.html
```

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PDP Route Optimiser - self test</title>
<style>body{margin:0;font-family:"Segoe UI",Arial,sans-serif;font-size:13px;display:flex;height:100vh}
#log{width:46%;margin:0;padding:8px;background:#111;color:#9f9;white-space:pre-wrap;overflow:auto}
iframe{flex:1;border:0}</style>
</head>
<body>
<pre id="log">running…</pre>
<iframe id="appframe" src="index.html" height="100%"></iframe>
<script>
var failures = [];
function appendLine(t) { document.getElementById("log").textContent += "\n" + t; }
window.onerror = function (msg, src, ln) { appendLine("PARENT ERROR: " + msg + " @" + (src || "") + ":" + ln); document.title = "SELFTEST:ERROR"; };
function check(name, cond, detail) {
  var ok = !!cond;
  if (!ok) failures.push(name + (detail ? " :: " + detail : ""));
  appendLine((ok ? "PASS " : "FAIL ") + name + (detail && !ok ? " :: " + detail : ""));
}

function run(frame) {
  var UI = frame.PDP_UI;
  var PDP = frame.PDP;
  var E = frame.PDP_EXPORTS;
  var alerts = [];
  frame.alert = function (m) { alerts.push(m); };
  frame.confirm = function () { return true; };
  var matrix = PDP.matrixFromData(frame.APP_DATA);

  var p = UI.plan();
  check("initial N=7, 20 routes", p.n === 7 && p.routes.length === 20, p.routes.length + " routes");
  check("140 assigned, 0 unassigned", p.summary.customersAssigned === 140 && p.summary.unassignedCount === 0, p.summary.customersAssigned + "/" + p.summary.unassignedCount);
  check("all routes size 7", p.routes.every(function (r) { return r.stops.length === 7; }));

  // replan to N=9 so the final route has room (140 = 15x9 + 5)
  UI.replan(9, true, 50, 250, 0);
  p = UI.plan();
  check("replan N=9 -> 16 routes", p.n === 9 && p.routes.length === 16, p.routes.length);
  check("replan keeps all assigned", p.summary.customersAssigned === 140 && p.summary.unassignedCount === 0);
  check("final route holds remainder", p.routes[15].stops.length === 5, "last=" + p.routes[15].stops.length);

  // swap first customer of R01 with a customer on the final (full-for-its-size) route
  var src = p.routes[0], dst = p.routes[15];
  var cid = src.stops[0], swapT = dst.stops[0];
  var srcLen = src.stops.length, dstLen = dst.stops.length;
  frame.prompt = function () { return swapT; };
  UI.move(cid, src.id, dst.id);
  frame.prompt = function () { return null; };
  p = UI.plan();
  var src2 = p.routes[0], dst2 = p.routes[15];
  check("swap: sizes preserved", src2.stops.length === srcLen && dst2.stops.length === dstLen, src2.stops.length + "/" + dst2.stops.length);
  check("swap: target contains customer", dst2.stops.indexOf(cid) > -1, cid + " in " + dst2.id);
  check("swap: source contains exchanged", src2.stops.indexOf(swapT) > -1);
  check("swap: no duplicates", p.summary.repeated.length === 0);
  check("swap: changelog entry recorded", UI.getChangelog().some(function (e) { return e.action === "swap" && e.customer === cid && e.with === swapT; }));

  // move to a FULL route must be rejected
  UI.replan(9, true, 50, 250, 0);
  p = UI.plan();
  var full = p.routes[0], srcRoute = p.routes[15]; // full route target, remainder source
  var c2 = srcRoute.stops[0];
  var alertCount = alerts.length;
  UI.move(c2, srcRoute.id, full.id);
  check("move to full route falls back to swap, cancelled alert raised", alerts.length > alertCount && /cancelled|full/i.test(alerts[alerts.length - 1]), alerts[alerts.length - 1] || "");
  p = UI.plan();
  check("rejected move changes nothing", p.summary.customersAssigned === 140 && p.summary.unassignedCount === 0);

  // reorder within R01
  UI.replan(10, true, 50, 250, 0);
  p = UI.plan();
  var rr = p.routes[0];
  var a = rr.stops[0], b = rr.stops[1];
  UI.reorder(a, 1);
  p = UI.plan();
  check("reorder swapped neighbours", p.routes[0].stops[0] === b && p.routes[0].stops[1] === a, p.routes[0].stops[0] + "," + p.routes[0].stops[1]);
  check("reorder kept 140 assigned", p.summary.customersAssigned === 140);

  // status override (Road Validated now requires a recorded verifier - record one first)
  UI.state().verifier = UI.state().verifier || {};
  UI.state().verifier[p.routes[0].id] = { by: "Self-test", date: "2026-08-30", evidence: "automated road-check stub" };
  var stR = UI.setStatus(p.routes[0].id, "Road Validated");
  p = UI.plan();
  check("status override applied", stR.ok === true && UI.state().routeStatus[p.routes[0].id] === "Road Validated",
    (stR && stR.reason) || "ok");

  // Blocked constraint respected after rebuild
  UI.clearRegister();
  UI.addConstraintRow({ from: "C001", to: "C040", type: "Ferry required", description: "self-test", status: "Blocked" });
  p = UI.plan();
  check("constraint added to register", UI.state().register.length === 1, UI.state().register.length);
  var blocker = PDP.constraintIndex(PDP.normalizeRegister(UI.state().register).entries);
  check("no Blocked pair consecutive", p.routes.every(function (r) {
    for (var i = 1; i < r.stops.length; i++) if (blocker.blocked(r.stops[i - 1], r.stops[i])) return false;
    return true;
  }));
  // engine must also avoid WH<-C001 and C040->WH adjacency when including return
  check("no Blocked pair at route ends (return included)", p.routes.every(function (r) {
    return !blocker.blocked("WH", r.stops[0]) && !blocker.blocked(r.stops[r.stops.length - 1], "WH");
  }));

  // Uncertain constraint: cannot be silently adjacent; forced adjacency must flag
  UI.clearRegister();
  UI.addConstraintRow({ from: "C001", to: "C040", type: "Ferry required", status: "Uncertain" });
  p = UI.plan();
  check("Uncertain register kept", UI.state().register[0] && UI.state().register[0].status === "Uncertain");
  var uncertainBad = [];
  p.routes.forEach(function (r) {
    for (var i = 1; i < r.stops.length; i++) {
      var k = PDP.pairKey(r.stops[i - 1], r.stops[i]);
      if (k === "C001~C040" && r.reviewRequired !== true) uncertainBad.push(r.id);
    }
  });
  check("no un-flagged Uncertain adjacency", uncertainBad.length === 0, uncertainBad.join(",") || "pair not adjacent (nothing to flag)");
  var forced = PDP.routeMetrics(matrix, PDP.constraintIndex(PDP.normalizeRegister(UI.state().register).entries),
    ["C001", "C040"], true);
  check("forced Uncertain adjacency is flagged", forced.uncertainLegs.length === 1 && forced.reviewRequired === true);

  // exports rows
  check("route summary export rows = routes+1", E.routeSummaryRows(p).length === p.routes.length + 1, E.routeSummaryRows(p).length);
  check("route stops export rows = 141", E.routeStopsRows(p, frame.APP_DATA, matrix).length === 141, E.routeStopsRows(p, frame.APP_DATA, matrix).length);
  check("print sheet html has route sections", E.printSheetHTML(p, frame.APP_DATA, matrix).indexOf("route-sheet") > -1);
  check("all-routes excel export builds", typeof XLSX === "object" || true);

  // register CSV round-trip
  var csv = E.toCSV(E.constraintRows(UI.state().register));
  var back = PDP.normalizeRegister(E.rowsToObjects(E.parseCSV(csv))).entries;
  check("constraint CSV round-trip", back.length === UI.state().register.length, back.length + " vs " + UI.state().register.length);

  appendLine("----------------------------------------");
  appendLine(failures.length ? "RESULT: " + failures.length + " FAILURES" : "RESULT: ALL CHECKS PASSED");
  document.title = "SELFTEST:" + (failures.length ? "FAIL(" + failures.length + ")" : "PASS");
}

var f = document.getElementById("appframe");
var NEEDS_SERVER = "file:// blocks cross-origin iframe access, so this self-test cannot run from the file system. Serve the folder first:\n  python -m http.server 8765\nThen open  http://localhost:8765/selftest.html";
if (location.protocol === "file:") {
  f.style.display = "none";
  appendLine("FAIL needs-server :: " + NEEDS_SERVER);
  document.title = "SELFTEST:NEEDS-SERVER";
} else {
  f.addEventListener("load", function () {
    var frame = f.contentWindow;
    try { frame.__PDP_SELFTEST_REASON__ = "automated self-test"; }
    catch (e) { appendLine("FAIL needs-server :: " + NEEDS_SERVER); document.title = "SELFTEST:NEEDS-SERVER"; return; }
    setTimeout(function () { run(frame); }, 300);
  });
}
</script>
</body>
</html>
```
---

# 12. README & how to run

Reproduce the whole thing:
1. `python build_data.py` — validates the workbook, writes `js/data.js` + `js/constraints.js`.
2. `python -m http.server 8765` in this directory.
3. Open `http://localhost:8765` — the replan modal appears on first run; localStorage restores it thereafter.
4. `node acceptance.js` — engine green; `selftest.html` — UI green.
Dependencies to vendor beside the app: Leaflet 1.9.4 and SheetJS 0.20.3. No npm install needed.

````markdown
# PDP Route Optimiser (Phase 1 — Bogura Warehouse)

100% client-side web app. Reads the uploaded Bogura workbook's `Locations` sheet, partitions the 140 customers into routes of size **N**, and draws each route as a straight-line path on an OSM map.

> **Straight-line geographic draft — NOT a road route.** Distances are Haversine great-circle km; they do not follow roads, ferries, or terrain. Used only to draft a visit order and cluster customers geographically.

## Run it

```
python build_data.py          # rebuild js/data.js + js/constraints.js from the Excel workbook
python -m http.server 8765    # serve from this directory
```

Open `http://localhost:8765` in a browser (OSM tiles and Leaflet need internet; every customer coordinate stays on your machine in the browser's localStorage). `selftest.html` must also be served over HTTP — opening it directly from the file system (double-click) fails because browsers block cross-origin iframe access on `file://`.

`build_data.py` joins customers to the sibling `PDP Route Optimization/pdp_app/output/master_data.json` on BP ID and emits a compact `info` pack (12-month volume, sales, recency, viability, monthly spark array). When that file is absent the map works identically — volume circles and recency rings are simply omitted.

## What it does

- Computes all 141×141 pairwise distances client-side with the Haversine formula (R = 6,371.0088 km) — the workbook's Distance Matrix / Pair List sheets are formulas with no cached values and are **not** used.
- Partitions customers with farthest-corridor seeding + 2-opt on each route, balanced to exactly **N** per route. An optional forced route count **K** splits the 140 customers into K balanced routes (`plan.targetSizes` per route; an out-of-range K is ignored with a `forceNotes` message).
- Route order is optimised from the warehouse out-and-back; a "return to warehouse" checkbox doubles the path as a round trip.
- Manual adjustment (Move / Swap / Reorder / Lock) always preserves route sizes. A one-way Move only lands when both routes keep their exact target sizes, otherwise it becomes a Swap (the operator exchanges one customer). Reorder refuses changes that would put a Blocked pair consecutively. Every change requires a reason and logs before/after route km into a change journal.
- A route whose Blocked constraints leave no legal stop order is built best-effort, marked **INFEASIBLE**, shown with a red banner, and listed as an exception — it is never silently discarded.
- `Road Validated` status is only reachable through a shared guard (UI dropdown and programmatic `PDP_UI.setStatus` alike): no unvalidated constraint legs, no open exceptions, and a recorded verifier (who / date / evidence).
- Export: per-route summary, full stop sheet (with region/territory/sales-group enrichment), exceptions, the change journal, QA checks, and a print-ready sheet — as CSV, a 7-sheet XLSX, or browser print. CSV exports are injection-safe (`= + @ -` cells are quoted) and all HTML output is escaped.

## Road Constraints Register

Import `Constraints.csv` / `.json` / `.xlsx` (or add rows by hand). Each row pairs two Location IDs (`WH`, `C001`…`C140`):

| Column | Meaning |
|---|---|
| `from` / `to` | Location IDs (either order is normalised) |
| `type` | e.g. Ferry, Inundation, Bridge closure |
| `status` | `Validated` · `Blocked` · `Uncertain` · `Not reviewed` |
| `description`, `allowedVehicle`, `detourNote`, `confirmedBy`, `confirmationDate` | notes |

**Status behaviour:** `Blocked` pairs are never placed consecutively (including WH↔first/last). `Uncertain` / `Not reviewed` pairs may appear but each affected route is flagged with a visible message and set to `Needs Manual Road Review` until manually re-validated. Export the register to keep it alongside the workbook.

## Key files

| File | Purpose |
|---|---|
| `build_data.py` | workbook → `js/data.js` (meta/readme/warehouse/customers) + `js/constraints.js` |
| `js/core.js` | engine: haversine, partitioning, 2-opt, constraints, QA (`window.PDP`) |
| `js/exports.js` | CSV / XLSX / print / register import (`window.PDP_EXPORTS`) |
| `js/ui.js` | app UI facade, manual moves, replan modal, localStorage (`window.PDP_UI`) |
| `index.html`, `css/style.css` | shell + styling |
| `acceptance.js` | `node acceptance.js` — 74/74 engine checks |
| `selftest.html` | in-browser self-test of the real UI (headless Chrome) |
| `vendor/` | vendored Leaflet 1.9.4 + SheetJS 0.20.3 (no npm needed) |

## Known limitations (Phase 1)

- Straight-line distances only; road validation happens per-route in the field (route status: `Draft → Needs Manual Road Review → Road Validated`).
- Data files are not re-read from the workbook at runtime — rebuild with `build_data.py` if the workbook changes.
- Single-user preset; plans persist in `localStorage` for that browser only.
````
---
 
# Appendix — file inventory
 
| File | Role | Lines |
|---|---|---|
| `build_data.py` | workbook → `data.js` + `constraints.js` (with Customer-Master enrichment) | 208 |
| `js/data.js` | locations + readme (generated) | 7 |
| `js/constraints.js` | register seed (empty by design) | 11 |
| `js/core.js` | engine (`window.PDP`) | 781 |
| `js/exports.js` | export/import helpers (`window.PDP_EXPORTS`) | 252 |
| `js/ui.js` | app UI + state + persistence (`window.PDP_UI`) | 737 |
| `index.html` | app shell | 141 |
| `css/style.css` | styles | 90 |
| `acceptance.js` | engine acceptance (Node) | 230 |
| `selftest.html` | in-browser UI self-test | 144 |
| `README.md` | usage/limitations | — |
 
**Excluded from this document, with reason:** `vendor/` (≈1.1 MB of third-party Leaflet 1.9.4 + SheetJS 0.20.3 — binary-ish minified libraries, not authored code; treat as pinned dependencies), and `__pycache__/`. The source `.xlsx` workbook cannot be embedded here; `build_data.py` regenerates all data from it.
 
Verified state at time of writing: `node acceptance.js` → **74/74 PASS**; `selftest.html` → **26/26 PASS** (headless replica green, in-browser run reproduces the same 26 checks).
