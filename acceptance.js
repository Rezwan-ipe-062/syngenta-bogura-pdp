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