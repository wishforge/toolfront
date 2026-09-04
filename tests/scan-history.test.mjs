// scan-history — the public ledger wiring, schema and rendering contract.
// Offline (repo convention): static source assertions + pure logic only;
// D1 behaviour is exercised in live runs (wrangler dev) and the live suites.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? "  " + e : ""}`); } };

const migration = readFileSync(ROOT + "migrations/0001_scan_history.sql", "utf8");
const worker = readFileSync(ROOT + "worker.js", "utf8");
const page = readFileSync(ROOT + "public/report.html", "utf8");

console.log("\n[A] schema — public ledger carries no identity");
const cols = ["domain", "scanned_at", "score", "grade", "scoring_version", "detail_json"];
ok("table + index defined", migration.includes("CREATE TABLE IF NOT EXISTS scan_history") && migration.includes("idx_scan_history_domain_time"));
ok("required columns present", cols.every(c => migration.includes(c)));
// Column definitions only (lines that start with a bare column name inside the
// CREATE TABLE body); comments legitimately name ip/email/account as excluded.
const body = migration.slice(migration.indexOf("("), migration.indexOf(");"));
const colLines = body.split("\n").map(l => l.trim()).filter(l => /^[a-z_]+ /.test(l));
const leaky = ["ip", "email", "account", "user_id", "ua", "cookie"].filter(t => colLines.some(l => l.startsWith(t)));
ok("no identity/PII column in the schema", leaky.length === 0, leaky.join(","));
ok("privacy contract documented in the migration", migration.includes("no scanner identity") && migration.includes("removal for domain owners"));

console.log("\n[B] worker wiring");
ok("route registered", worker.includes('/api/scan-history") return await handleScanHistory'));
ok("records only scored reports", worker.includes("publicReport.score == null") && worker.includes("return;"));
ok("throttle: 1 row per domain per hour", worker.includes("SCAN_HISTORY_TTL_MS = 60 * 60 * 1000"));
ok("retention: 50 rows + 12 months", worker.includes("SCAN_HISTORY_MAX_ROWS = 50") && worker.includes("SCAN_HISTORY_MAX_AGE_MS = 365"));
ok("history failure never 500s a scan", worker.includes("prune is best-effort") && worker.includes("must not 500 an"));
ok("endpoint caps rows and orders desc", worker.includes("ORDER BY scanned_at DESC LIMIT 50"));
ok("endpoint degrades to empty when ledger unavailable", worker.includes("ledger unavailable -> empty, never 500"));
ok("throttle stamp independent of prune outcome", worker.includes("The throttle stamp is independent of insert/prune"));

console.log("\n[C] page contract");
ok("renders history from the same-origin endpoint", page.includes("'/api/scan-history?domain='"));
ok("no fake history: empty ledger hides the card", page.includes("if (!rows.length) return; // no ledger rows -> no card"));
ok("row fields are textContent, never innerHTML", !/innerHTML[\s\S]{0,120}hist-row/.test(page) && page.includes("el('span', 'hist-score', String(row.score))"));
ok("scoring version shown per row (version-mixing honesty)", page.includes("row.scoring_version"));
ok("each row pre-fills Compare with this domain", page.includes("'/compare?a=' + encodeURIComponent(domain)"));
ok("duplicate card guarded across re-renders", page.includes("document.getElementById('hist-card')") && page.includes("removeChild"));
ok("bilingual keys present", page.includes("'report.hist.title': 'Previous scans'") && page.includes("'report.hist.title': '历史扫描'"));

ok("history endpoint is rate limited like /api/scan (read-amplification guard)", worker.includes("async function handleScanHistory") && /handleScanHistory[\s\S]{0,600}rateLimitAllow/.test(worker.slice(worker.indexOf("async function handleScanHistory"))));
ok("history 429 response is uniform with scan 429", worker.slice(worker.indexOf("async function handleScanHistory"), worker.indexOf("async function handleScanHistory") + 700).includes("rate_limited"));

console.log("\nscan-history 结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
