// cache-tier — the D1 warm tier between the KV hot cache and live scans.
// Offline (repo convention): static source assertions on the worker wiring.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? "  " + e : ""}`); } };

const worker = readFileSync(ROOT + "worker.js", "utf8");

console.log("\n[A] warm tier wiring in scanPublicReport");
ok("D1 ledger query present", worker.includes("SELECT detail_json, scanned_at FROM scan_history WHERE domain = ? ORDER BY scanned_at DESC LIMIT 1"));
ok("gated on SCAN_DB binding", worker.includes("if (env.SCAN_DB && !forceFresh)"));
ok("24h freshness window", worker.includes("24 * 60 * 60 * 1000"));
ok("legacy summary-only rows skipped (full-report marker required)", worker.includes("parsed.verdict !== undefined"));
ok("warm hit backfills the hot KV cache", worker.includes('await env.KV.put("scan:" + domain'));
ok("warm hit returns cached + cached_at", worker.includes("cached: true, cached_at: row.scanned_at"));
ok("D1 hiccup falls through to a live scan", worker.includes("fall through to a live scan"));

console.log("\n[B] ledger stores the full public report (restore-ready)");
ok("recordScanHistory persists the whole public report", worker.includes("const detail = { ...publicReport };"));
ok("detail_json never leaves D1 (API whitelist unchanged)", worker.includes("ORDER BY scanned_at DESC LIMIT 50") && !worker.includes("detail_json AS detail"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
