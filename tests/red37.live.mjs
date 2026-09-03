// red37 — public scan history + homepage-entries round: new attack surfaces.
// Targets LOCAL dev servers (8788 toolfront / 8787 monitor) like red35/36.
// Coverage: /api/scan-history shape + PII whitelist, ledger integrity under
// throttle, unreachable/blocked scans never recorded, compare single-param
// prefill sanitising, rankings-strip resilience, privacy EN/ZH parity, and
// a static guard that the history endpoint has no outbound fetch (no SSRF).
import { readFileSync } from "node:fs";

const TF = "http://localhost:8788";
const MON = "http://localhost:8787";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c ? "" : "  " + e)); c ? pass++ : fail++; };

console.log("═══ A. /api/scan-history — shape & PII whitelist ═══");
{
  const bad = await fetch(TF + "/api/scan-history?domain=");
  ok("A1 missing domain -> 400", bad.status === 400, "HTTP " + bad.status);
  const bad2 = await fetch(TF + "/api/scan-history?domain=%3Cscript%3Ealert(1)%3C/script%3E");
  ok("A2 injected domain -> 400 (never a query)", bad2.status === 400, "HTTP " + bad2.status);
  const none = await fetch(TF + "/api/scan-history?domain=does-not-exist-xyz.example.org");
  const nj = await none.json();
  ok("A3 unknown domain -> ok, empty rows", none.status === 200 && Array.isArray(nj.rows) && nj.rows.length === 0);
  const r = await fetch(TF + "/api/scan-history?domain=example.net");
  const j = await r.json();
  ok("A4 rows sorted desc", j.rows.every((x, i) => i === 0 || j.rows[i - 1].scanned_at >= x.scanned_at));
  ok("A5 rows carry only the whitelist keys", j.rows.every(x => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(["domain", "grade", "scanned_at", "score", "scoring_version"])), j.rows[0] ? Object.keys(j.rows[0]).join(",") : "no rows");
  const leaky = JSON.stringify(j).replace(/example\.net/g, "");
  ok("A6 no IP/email/identity in payload", !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|@|Bearer|token|re_/i.test(leaky));
  ok("A7 no Set-Cookie", !r.headers.get("set-cookie"));
  ok("A8 public cache header", (r.headers.get("cache-control") || "").includes("public"));
}

console.log("═══ B. ledger integrity (throttle, no fake rows) ═══");
{
  // Time-robust: build our own state. First scan may or may not record (>1h
  // since the last row is legal); the SECOND scan, seconds later, must be
  // throttled either way.
  const count = async () => (await (await fetch(TF + "/api/scan-history?domain=example.net")).json()).rows.length;
  const before = await count();
  await fetch(TF + "/api/scan?domain=example.net&fresh=1");
  const mid = await count();
  await fetch(TF + "/api/scan?domain=example.net&fresh=1");
  const after = await count();
  ok("B1 first scan adds at most one row", mid - before <= 1, before + " -> " + mid);
  ok("B2 throttle: immediate rescan adds no row", after === mid, mid + " -> " + after);
  // ledger row matches the actual current score (never invented)
  const cur = await (await fetch(TF + "/api/scan?domain=example.net")).json();
  const last = (await (await fetch(TF + "/api/scan-history?domain=example.net")).json()).rows[0];
  ok("B3 history row == real scan score", last && cur.score === last.score && last.scoring_version === "3.0.0", JSON.stringify({ cur: cur.score, row: last && last.score }));
  // unreachable domain must NOT be recorded (502 is an answer, not a ledger event)
  const dead = "red37-unreachable-" + Date.now() + ".example.org";
  const dr = await fetch(TF + "/api/scan?domain=" + dead);
  const dh = await (await fetch(TF + "/api/scan-history?domain=" + dead)).json();
  ok("B4 unreachable scan not recorded", dr.status === 502 && dh.rows.length === 0, "scan=" + dr.status + " rows=" + dh.rows.length);
}

console.log("═══ C. compare single-param prefill sanitising ═══");
{
  const j = await (await fetch(TF + "/compare?a=example.net")).text();
  ok("C1 compare page serves with one param", j.includes("competitor.com"));
  const html = readFileSync(new URL("../public/compare.html", import.meta.url), "utf8");
  ok("C2 prefill only for sanitised domain (server + page agree)", html.includes("encodeURIComponent(a)") || html.includes("normalize(a)"), "check page normalize path");
  // junk param must not reach the DOM as a value
  const junk = await (await fetch(TF + "/compare?a=%3Cimg%20src=x%3E")).text();
  ok("C3 injected ?a= does not appear in markup", !junk.includes("<img src=x"));
}

console.log("═══ D. static guards (structural immunity) ═══");
{
  const w = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const mf = w.match(/async function handleScanHistory[\s\S]*?\n}\n/);
  ok("D1 handler fn extracted", !!mf);
  const histFn = (mf && mf[0]) || "";
  ok("D1 history handler performs no outbound fetch (no SSRF surface)", !!mf && !/fetch\(|connect\(/.test(histFn));
  ok("D2 record skips non-scored reports", w.includes("publicReport.score == null"));
  const m = readFileSync(new URL("../migrations/0001_scan_history.sql", import.meta.url), "utf8");
  const cols = m.slice(m.indexOf("("), m.indexOf(");")).split("\n").map(l => l.trim()).filter(l => /^[a-z_]+ /.test(l)).map(l => l.split(" ")[0]);
  ok("D3 schema has no identity column", !["ip", "email", "account", "user"].some(c => cols.includes(c)));
  const page = readFileSync(new URL("../public/report.html", import.meta.url), "utf8");
  ok("D4 history rows render via textContent only", !/\.innerHTML\s*=/.test(page.slice(page.indexOf("renderHistory"), page.indexOf("function buildVs"))));
}

console.log("═══ E. privacy EN/ZH parity (compliance) ═══");
{
  const raw = await (await fetch(TF + "/privacy")).text();
  const txt = raw.replace(/<[^>]+>/g, "");   // strip markup: phrases are split by <strong> tags
  ok("E1 EN clause present", txt.includes("Public scan history") && txt.includes("within 7 days"));
  ok("E2 ZH clause present in source", txt.includes("公开扫描历史") && txt.includes("7 天内删除") && txt.includes("域名所有者"));
  ok("E3 retention stated in both", txt.includes("most recent 50 records or 12 months") && txt.includes("最近 50 条或 12 个月"));
  ok("E4 robots opt-out + IP-only disclosed", txt.includes("never scanned") && txt.includes("rate limiting") && txt.includes("仅用于限流"));
}

console.log(`\n════════ red37: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
