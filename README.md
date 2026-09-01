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