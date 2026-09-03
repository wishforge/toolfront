// methodology — the published rules must match the engine that enforces them.
// Repo convention: self-executing, console.log progress, exit 1 on failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? "  " + e : ""}`); } };

// The worker owns the constants; read them the same way the scanner does, so a
// drift between the page and the engine fails here instead of in production.
const src = readFileSync(ROOT + "worker.js", "utf8");
const tierBudget = JSON.parse(src.match(/const TIER_BUDGET = (\{[^}]*\});/)[1].replace(/(\w+):/g, '"$1":'));
const policyIds = [...src.matchAll(/^\s{2}"?([\w-]+)"?: \{ label:/gm)].map(m => m[1]);
const scoringVersion = src.match(/const SCORING_VERSION = "([\d.]+)";/)[1];

// Recreate methodologyData()'s arithmetic from the source constants.
const shares = {};
for (const m of src.matchAll(/^\s{2}"?([\w-]+)"?: \{ label: "[^"]+", tier: "(\w+)", evidence: "(\w+)", share: ([\d.]+) \}/gm)) {
  shares[m[1]] = { tier: m[2], evidence: m[3], share: Number(m[4]) };
}

const API = process.env.TF_API || "http://localhost:8788";

console.log("\n[A] /api/methodology — shape");
let data = null;
try {
  const res = await fetch(`${API}/api/methodology`);
  data = await res.json();
  ok("200 OK", res.status === 200, `status=${res.status}`);
} catch (e) {
  ok("200 OK", false, e.message.slice(0, 60));
}
if (data) {
  ok("has rules_version + scoring_version", !!data.rules_version && !!data.scoring_version);
  ok("has tiers, checks, grade_bands", Array.isArray(data.tiers) && Array.isArray(data.checks) && Array.isArray(data.grade_bands));
}

console.log("\n[B] no drift — the published table equals the engine constants");
if (data) {
  ok("check count matches CHECK_POLICY", data.checks.length === policyIds.length, `${data.checks.length} vs ${policyIds.length}`);
  ok("scoring_version matches worker", data.scoring_version === scoringVersion, `${data.scoring_version} vs ${scoringVersion}`);
  let drift = [];
  for (const c of data.checks) {
    const expected = Math.round(tierBudget[shares[c.id].tier] * shares[c.id].share);
    if (c.max !== expected) drift.push(`${c.id}: ${c.max}!=${expected}`);
    if (c.tier !== shares[c.id].tier) drift.push(`${c.id}: tier ${c.tier}!=${shares[c.id].tier}`);
  }
  ok("every max + tier matches CHECK_POLICY arithmetic", drift.length === 0, drift.slice(0, 3).join(" | "));
  const tierBudgetMatches = data.tiers.every(t => tierBudget[t.tier] === t.budget);
  ok("tier budgets match TIER_BUDGET", tierBudgetMatches);
  ok("grade bands are the documented six-step scale", data.grade_bands.map(b => b.grade).join("") === "ABCDF");
}

console.log("\n[C] /methodology — HTML page + markdown variant");
{
  const htmlRes = await fetch(`${API}/methodology`);
  const html = await htmlRes.text();
  ok("HTML page 200", htmlRes.status === 200, `status=${htmlRes.status}`);
  ok("served as HTML", (htmlRes.headers.get("content-type") || "").includes("text/html"));
  ok("CSP present", !!htmlRes.headers.get("content-security-policy"));
  ok("nosniff present", htmlRes.headers.get("x-content-type-options") === "nosniff");
  ok("fetches its content from /api/methodology (single source of truth)", html.includes("/api/methodology"));
  ok("advertises the markdown variant", html.includes('rel="alternate"') && html.includes("text/markdown"));
  ok("has a link back to the scanner", /href="\/"/.test(html));

  /* The markdown variant is driven by Accept content negotiation. `wrangler dev`
     sits behind this machine's HTTP proxy, which rewrites Accept before the
     worker sees it — so over HTTP the negotiation is untestable locally. Call
     the worker directly instead: same code path, no proxy in the way. */
  const worker = (await import("../worker.js")).default;
  const mdRes = await worker.fetch(new Request("http://x/methodology", { headers: { accept: "text/markdown" } }), {}, {});
  const md = await mdRes.text();
  ok("markdown variant returns text/markdown", (mdRes.headers.get("content-type") || "").includes("text/markdown"), mdRes.headers.get("content-type"));
  ok("markdown carries Vary: Accept", (mdRes.headers.get("vary") || "").includes("Accept"));
  ok("markdown lists the checks", md.includes("| check | label | evidence | max |"));
  if (data) ok("markdown states the same scoring version", md.includes(data.scoring_version));
  const htmlRes2 = await worker.fetch(new Request("http://x/methodology"), {}, {});
  ok("default Accept falls through to JSON when no ASSETS binding", (htmlRes2.headers.get("content-type") || "").includes("application/json"));
}

console.log("\n[D] pages link to the methodology");
{
  const report = readFileSync(ROOT + "public/report.html", "utf8");
  ok("report page links /methodology", /href="\/methodology"/.test(report));
  ok("report version stamp links to it", /id="ver-link"[^>]*href="\/methodology"/.test(report));
  const compare = readFileSync(ROOT + "public/compare.html", "utf8");
  ok("compare page links /methodology", /href="\/methodology"/.test(compare));
}

console.log(`\nmethodology 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
