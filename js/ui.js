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

  /* ---------------- OR-Tools solver integration ---------------- */

  var solverAvailable = false;

  function detectSolver() {
    if (!window.PDP_SOLVER) return;
    PDP_SOLVER.check(function (ok) {
      solverAvailable = ok;
      var wrap = document.getElementById("solver-toggle-wrap");
      if (wrap) wrap.style.display = ok ? "" : "none";
      var st = document.getElementById("solver-status");
      if (st) st.textContent = ok ? "Server connected" : "";
    });
  }

  function buildSolverParams() {
    var blocked = [];
    state.register.forEach(function (e) {
      if (e.status === "Blocked") blocked.push([e.from, e.to]);
    });
    var dnc = [];
    Object.keys(state.doNot).forEach(function (k) {
      var parts = k.split("~");
      if (parts.length === 2 && parts[0] < parts[1]) dnc.push(parts);
    });
    return {
      warehouse: { id: "WH", lat: data.warehouse.lat, lon: data.warehouse.lon, name: data.warehouse.name },
      customers: data.customers.map(function (c) { return { id: c.id, lat: c.lat, lon: c.lon }; }),
      num_vehicles: state.forceRouteCount || Math.ceil(data.customers.length / state.N),
      route_capacity: state.N,
      include_return: state.includeReturn,
      blocked_pairs: blocked,
      do_not_combine: dnc,
      locked_customers: state.locks,
      time_limit_seconds: 30,
    };
  }

  function convertSolverResult(result) {
    var cx = PDP.constraintIndex(PDP.normalizeRegister(state.register).entries);
    var routes = result.routes.map(function (r) {
      var stops = r.stops;
      var m = PDP.routeMetrics(matrix, cx, stops, state.includeReturn);
      return {
        id: r.id,
        stops: stops,
        metrics: m.metrics,
        warnings: m.warnings,
        constraintLegs: m.constraintLegs,
        uncertainLegs: m.uncertainLegs,
        blockedPairsInRoute: m.blockedPairsInRoute,
        blockedAvoided: m.blockedAvoided,
        reviewRequired: m.reviewRequired,
        status: m.reviewRequired ? "Needs Manual Road Review" : "Draft",
        customerCount: stops.length,
      };
    });
    var assigned = {};
    routes.forEach(function (r) { r.stops.forEach(function (cid) { assigned[cid] = r.id; }); });
    var exceptions = [];
    routes.forEach(function (r) {
      (r.warnings || []).forEach(function (w) {
        exceptions.push({ type: w.type || "Warning", status: "Open", affected: r.id + " " + (w.customer || ""), risk: w.detail || "", action: "Review" });
      });
    });
    var totalOut = 0, totalScore = 0, reviewCount = 0, warnCount = 0;
    routes.forEach(function (r) {
      totalOut += r.metrics.outboundKm;
      totalScore += r.metrics.scoreKm;
      if (r.reviewRequired) reviewCount++;
      warnCount += r.warnings.length;
    });
    return {
      routes: routes,
      _customers: data.customers,
      assignment: assigned,
      exceptions: exceptions,
      infeasible: false,
      summary: {
        routeCount: routes.length,
        customerCount: data.customers.length,
        customersAssigned: data.customers.length,
        unassignedCount: 0,
        totalOutboundKm: totalOut,
        totalScoreKm: totalScore,
        customersRequiringReview: reviewCount,
        warningCount: warnCount,
      },
      targetSizes: (function () {
        var counts = routes.map(function (r) { return r.stops.length; });
        return counts;
      })(),
      _solverResult: result,
    };
  }

  function rebuildPlanClientSide() {
    plan = PDP.buildPlan(buildCfg());
    plan.changelog = state.changelog;
    applyStatusOverrides();
    state.original = snap();
    state.working = snap();
    selectedRouteId = selectedRouteId && planKey(plan).indexOf(selectedRouteId) > -1 ? selectedRouteId : plan.routes[0].id;
    renderAll("all");
  }

  function rebuildPlan() {
    var useSolver = document.getElementById("rp-use-solver") &&
                    document.getElementById("rp-use-solver").checked &&
                    solverAvailable;

    if (useSolver && window.PDP_SOLVER) {
      var params = buildSolverParams();
      PDP_SOLVER.solve(params, function (err, result) {
        if (err || !result || !result.ok) {
          alert("OR-Tools solver failed: " + (err ? err.message : (result ? result.status : "unreachable")) +
                "\nFalling back to client-side heuristic.");
          rebuildPlanClientSide();
          return;
        }
        plan = convertSolverResult(result);
        plan.changelog = state.changelog;
        applyStatusOverrides();
        state.original = snap();
        state.working = snap();
        selectedRouteId = selectedRouteId && planKey(plan).indexOf(selectedRouteId) > -1 ? selectedRouteId : plan.routes[0].id;
        renderAll("all");
      });
    } else {
      rebuildPlanClientSide();
    }
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
    if (rec === undefined || rec === null) return "#3B82F6";
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
      var col = c.info && state.mapRecency ? recColor(c.info.r) : "#3B82F6";
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
  function replan(n, includeReturn, forceRouteCount) {
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
    detectSolver();
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