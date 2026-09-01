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