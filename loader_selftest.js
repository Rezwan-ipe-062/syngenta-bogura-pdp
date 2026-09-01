// Headless check for js/loader.js (runtime workbook -> APP_DATA parser).
// Builds a tiny synthetic workbook in memory and asserts the parse shape + a
// couple of rejection paths. Run: node loader_selftest.js
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const XLSX = require(path.join(__dirname, "vendor", "sheetjs", "xlsx.full.min.js"));

const win = {};
const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const ctx = {
  XLSX, window: win, localStorage, setTimeout, Math, JSON, console,
  document: { getElementById() { return null; }, addEventListener() {} }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "js", "loader.js"), "utf8"), ctx);
const parse = win.PDP_LOADER.parse;

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " :: " + detail : ""));
}

function aoa(rows) { return XLSX.utils.aoa_to_sheet(rows); }
function workbook(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

// --- valid workbook: WH + C001..C140 on Locations, optional Customer Master
function cid(n) { return "C" + (n < 100 ? "0" : "") + (n < 10 ? "0" : "") + n; }
const locRows = [["Location ID", "Location Name", "BP ID", "Address", "Latitude", "Longitude"]];
locRows.push(["WH", "Warehouse", "", "HQ", 24.8156, 89.3585]);
const cmRows = [["Location ID", "BP ID", "Zone Name", "Unit Name", "Sales Group Code"]];
for (let n = 1; n <= 140; n++) {
  const id = cid(n);
  locRows.push([id, "C" + n, "BP" + n, "addr" + n, 24.2 + (n % 10) * 0.1, 89.1 + (n % 10) * 0.1]);
  cmRows.push([id, "BP" + n, "Zone" + n, "Unit" + n, "G" + n]);
}
function pairList() {
  const rows = [["WH", "x", "x"]];
  const ids = ["WH"].concat(Array.from({ length: 140 }, (_, i) => cid(i + 1)));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) rows.push([ids[i], "x", ids[j]]);
  return aoa(rows);
}
const buf = workbook({
  "Read Me": aoa([["Purpose", "test"], ["Coverage", "x"], ["How to use", "y"], ["Critical limitation", "z"], ["Formula", "h"]]),
  "Locations": aoa(locRows),
  "Distance Matrix": aoa([["WH", "C001", 1], ["C001", "C002", 2]]),
  "Pair List": pairList(),
  "Customer Master": aoa(cmRows)
});

const res = parse(buf);
check("valid workbook ok", res.ok === true, JSON.stringify(res.errors));
if (res.ok) {
  const d = res.data;
  check("140 customers", d.customers.length === 140, String(d.customers.length));
  check("WH warehouse", d.warehouse.id === "WH",
    d.warehouse && d.warehouse.id);
  check("region enriched", d.customers[0].region === "Zone1", d.customers[0].region);
  check("geo median present", typeof d.meta.geography.medianKm === "number");
  check("sorted by id", d.customers[0].id === "C001" && d.customers[139].id === "C140");
}

// --- missing sheet rejected
const miss = XLSX.write({ SheetNames: ["x"], Sheets: { x: {} } }, { type: "array", bookType: "xlsx" });
check("missing sheets rejected", parse(miss).ok === false);

// --- wrong header rejected
const badHdr = workbook({ "Read Me": aoa([]), "Locations": aoa([["Nope", "1", "2", "3", "4", "5"]]),
  "Distance Matrix": aoa([]), "Pair List": aoa([]) });
check("bad header rejected", parse(badHdr).ok === false);

// --- duplicate BP rejected
const dupRows = [["Location ID", "Location Name", "BP ID", "Address", "Latitude", "Longitude"],
                 ["WH", "Warehouse", "", "HQ", 24.8156, 89.3585],
                 ["C001", "A", "BP9", "a", 24.2, 89.1],
                 ["C002", "B", "BP9", "b", 25.0, 89.6]];
const dup = workbook({ "Read Me": aoa([]), "Locations": aoa(dupRows), "Distance Matrix": aoa([]), "Pair List": aoa([]) });
check("duplicate BP rejected", parse(dup).ok === false);

console.log(failures ? `\n${failures} SELFTEST CHECK(S) FAILED` : "\nRESULT: ALL SELFTEST CHECKS PASSED");
process.exit(failures ? 1 : 0);
