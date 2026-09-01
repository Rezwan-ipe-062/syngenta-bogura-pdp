/**
 * PDP Route Optimiser - runtime workbook loader.
 * Replaces the build-time js/data.js in production: the user uploads the customer
 * Excel workbook at runtime; we parse it with SheetJS into the same window.APP_DATA
 * shape that build_data.py emits, then hand it to PDP_UI.loadData().
 *
 * This file MUST be loaded BEFORE js/ui.js so that a cached parse (localStorage)
 * is surfaced as window.APP_DATA before the UI IIFE captures it.
 */
(function () {
  "use strict";

  var CACHE_KEY = "pdp-bogura-v1-data";
  var R = 6371.0088;
  var BOUNDS = { lat: [20, 27], lon: [88, 93] };

  function hav(a, b) {
    function rad(d) { return d * Math.PI / 180; }
    var p1 = rad(a[0]), p2 = rad(b[0]);
    var dp = rad(b[0] - a[0]), dl = rad(b[1] - a[1]);
    var x = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function cacheGet() {
    try {
      var s = localStorage.getItem(CACHE_KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function cacheSet(d) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
  }
  function cacheClear() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  // Preload any cached parse before the UI reads window.APP_DATA at load time.
  var pre = cacheGet();
  if (pre) window.APP_DATA = pre;

  /* ---------------- workbook -> APP_DATA ---------------- */

  function num(v) { return typeof v === "number" && isFinite(v); }

  function sheet(wb, name) { return wb && wb.Sheets && wb.Sheets[name]; }
  function rows(ws) { return ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" })) : []; }

  /**
   * Parse an uploaded workbook into the APP_DATA shape (mirrors build_data.py).
   * Returns { ok:true, data } or { ok:false, errors:[...] }.
   */
  function parse(arrayBuffer) {
    var wb, errors = [];
    try { wb = XLSX.read(arrayBuffer, { type: "array" }); }
    catch (e) { return { ok: false, errors: ["Not a valid Excel workbook: " + e.message] }; }

    var names = wb.SheetNames || [];
    var need = ["Read Me", "Locations", "Distance Matrix", "Pair List"];
    var miss = need.filter(function (n) { return names.indexOf(n) < 0; });
    if (miss.length) return { ok: false, errors: ["Workbook missing required sheets: " + miss.join(", ")] };

    var locRows = rows(sheet(wb, "Locations"));
    if (!locRows.length) return { ok: false, errors: ["Locations sheet is empty"] };
    var hdr = locRows[0].map(function (v) { return String(v); });
    var want = ["Location ID", "Location Name", "BP ID", "Address", "Latitude", "Longitude"];
    if (hdr.slice(0, 6).join("|") !== want.join("|")) {
      return { ok: false, errors: ["Unexpected Locations header: " + hdr.slice(0, 6).join(", ")] };
    }

    var locs = locRows.slice(1).filter(function (r) { return r[0] !== "" && r[0] != null; });
    if (locs.length !== 141) {
      return { ok: false, errors: ["Expected 141 location rows, got " + locs.length] };
    }

    var warehouse = null, customers = [], seenIds = {}, seenBp = {}, bad = [];
    for (var i = 0; i < locs.length; i++) {
      var r = locs[i];
      var lid = String(r[0]).trim(), name = String(r[1] == null ? "" : r[1]);
      var bp = r[2] == null ? "" : String(r[2]).trim();
      var addr = String(r[3] == null ? "" : r[3]);
      var lat = r[4], lon = r[5];
      if (seenIds[lid]) { bad.push("duplicate Location ID " + lid); break; }
      seenIds[lid] = 1;
      if (!num(lat) || !num(lon)) { bad.push(lid + ": missing/invalid lat/lon"); continue; }
      if (lat < BOUNDS.lat[0] || lat > BOUNDS.lat[1] || lon < BOUNDS.lon[0] || lon > BOUNDS.lon[1]) {
        bad.push(lid + ": coordinates outside Bangladesh bounds"); continue;
      }
      if (lid === "WH") {
        warehouse = { id: "WH", name: name, bpId: "", address: addr, lat: lat, lon: lon };
      } else if (/^C\d{3}$/.test(lid)) {
        if (bp && seenBp[bp]) { bad.push(lid + ": duplicate BP ID " + bp); continue; }
        if (bp) seenBp[bp] = 1;
        customers.push({ id: lid, name: name, bpId: bp, address: addr, lat: lat, lon: lon });
      } else {
        bad.push("unexpected Location ID " + lid);
      }
    }
    if (!warehouse) bad.push("no WH row found");
    var idSet = {};
    customers.forEach(function (c) { idSet[c.id] = 1; });
    for (var n = 1; n <= 140; n++) {
      if (!idSet["C" + (n < 100 ? "0" : "") + (n < 10 ? "0" : "") + n]) {
        bad.push("customer ID C" + (n < 100 ? "0" : "") + (n < 10 ? "0" : "") + n + " missing (need continuous C001..C140)");
        break;
      }
    }
    if (bad.length) return { ok: false, errors: bad.slice(0, 8) };

    customers.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });

    // Optional Customer Master -> region/territory/salesGroup
    if (names.indexOf("Customer Master") >= 0) {
      var enrRows = rows(sheet(wb, "Customer Master")).filter(function (r) { return r[0] !== "" && r[0] != null; });
      if (enrRows.length) {
        var h = enrRows[0];
        function colIdx(name) { var k = h.indexOf(name); return k >= 0 ? k : -1; }
        var iL = colIdx("Location ID"), iB = colIdx("BP ID"), iZ = colIdx("Zone Name"),
            iU = colIdx("Unit Name"), iG = colIdx("Sales Group Code");
        if (iL >= 0 && iB >= 0 && iZ >= 0 && iU >= 0 && iG >= 0) {
          var byLid = {}, byBp = {};
          for (var e = 1; e < enrRows.length; e++) {
            var er = enrRows[e];
            var eb = String(er[iB]).trim(), el = String(er[iL]).trim();
            var rec = {
              region: String(er[iZ]).trim(), territory: String(er[iU]).trim(), salesGroup: String(er[iG]).trim()
            };
            if (el) byLid[el] = rec;
            if (eb) byBp[eb] = rec;
          }
          customers.forEach(function (c) {
            var rec = byLid[c.id] || byBp[c.bpId] || {};
            c.region = rec.region || "";
            c.territory = rec.territory || "";
            c.salesGroup = rec.salesGroup || "";
          });
        } else {
          customers.forEach(function (c) { c.region = ""; c.territory = ""; c.salesGroup = ""; });
        }
      } else {
        customers.forEach(function (c) { c.region = ""; c.territory = ""; c.salesGroup = ""; });
      }
    } else {
      customers.forEach(function (c) { c.region = ""; c.territory = ""; c.salesGroup = ""; });
    }

    // Geography summary (mirrors build_data.py hav())
    var whKm = customers.map(function (c) {
      return hav([warehouse.lat, warehouse.lon], [c.lat, c.lon]);
    }).sort(function (a, b) { return a - b; });
    var geo = {
      minKm: Math.round(whKm[0] * 10) / 10,
      medianKm: Math.round(whKm[70] * 10) / 10,
      maxKm: Math.round(whKm[whKm.length - 1] * 10) / 10,
      beyond50km: whKm.filter(function (d) { return d > 50; }).length,
      beyond100km: whKm.filter(function (d) { return d > 100; }).length,
      beyond150km: whKm.filter(function (d) { return d > 150; }).length
    };

    var readme = {};
    rows(sheet(wb, "Read Me")).forEach(function (r) {
      if (r[0] !== "" && r[1] !== "") readme[String(r[0]).trim()] = String(r[1]).trim();
    });

    var data = {
      meta: {
        source: "runtime-upload", generated: "runtime",
        totalCustomers: customers.length, routeName: "Bogura PDP", geography: geo
      },
      readme: {
        Purpose: readme.Purpose || "", Coverage: readme.Coverage || "",
        HowToUse: readme["How to use"] || "", CriticalLimitation: readme["Critical limitation"] || "",
        Formula: readme.Formula || ""
      },
      warehouse: warehouse,
      customers: customers
    };
    return { ok: true, data: data };
  }

  /* ---------------- upload UI ---------------- */

  function setupUploadUI() {
    var zone = document.getElementById("upload-zone");
    var pick = document.getElementById("pick-file");
    var status = document.getElementById("upload-status");
    if (!zone) return;

    function setStatus(msg, err) {
      if (!status) return;
      status.textContent = msg;
      status.className = err ? "oktxt warn" : "oktxt";
    }

    function handleFile(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onerror = function () { setStatus("Could not read file.", true); };
      reader.onload = function () {
        var res = parse(reader.result);
        if (!res.ok) { setStatus(res.errors[0], true); return; }
        window.APP_DATA = res.data;
        cacheSet(res.data);
        zone.classList.add("has-file");
        setStatus("Loaded " + res.data.customers.length +
          " customers. Building routes\u2026");
        var go = function () {
          if (window.PDP_UI && window.PDP_UI.loadData) { PDP_UI.loadData(res.data); return true; }
          return false;
        };
        if (!go()) setTimeout(go, 50);
      };
      reader.readAsArrayBuffer(file);
    }

    zone.addEventListener("click", function () { if (pick) pick.click(); });
    zone.addEventListener("dragover", function (e) {
      e.preventDefault(); e.stopPropagation(); zone.classList.add("drag");
    });
    zone.addEventListener("dragleave", function () { zone.classList.remove("drag"); });
    zone.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag");
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) handleFile(dt.files[0]);
    });
    if (pick) pick.addEventListener("change", function () {
      if (pick.files && pick.files.length) handleFile(pick.files[0]);
    });
  }

  if (pre) {
    // Data already cached: the UI shows immediately; nothing to wire.
  } else {
    document.addEventListener("DOMContentLoaded", setupUploadUI);
  }

  window.PDP_LOADER = {
    parse: function (arrayBuffer) { return parse(arrayBuffer); },
    load: function (data) { window.APP_DATA = data; cacheSet(data); },
    clear: function () { cacheClear(); delete window.APP_DATA; },
    hasCache: function () { return !!cacheGet(); }
  };
})();
