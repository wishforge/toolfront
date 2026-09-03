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
const tierBudget = JSON.parse(src.match(/const POOL_BUDGET = (\{[^}]*\});/)[1].replace(/(\w+):/g, '"$1":'));
const policyIds = [...src.matchAll(/^\s{2}"?([\w-]+)"?: \{ label:/gm)].map(m => m[1]);
const scoringVersion = src.match(/const SCORING_VERSION = "([\d.]+)";/)[1];

// Recreate methodologyData()'s arithmetic from the source constants.
const shares = {};
// Shares are written as readable expressions (20 / 86), so parse them without
// eval — the SAST gate bans eval/new Function anywhere in the repo.
const parseShare = (raw) => {
  const t = raw.trim();
  if (t.includes("/")) {
    const [a, b] = t.split("/").map(x => Number(x.trim()));
    return a / b;
  }
  return Number(t);
};
// (?:…)? keeps group indices stable whether or not label_zh is present
for (const m of src.matchAll(/^\s{2}"?([\w-]+)"?: \{ label: "[^"]+",(?: label_zh: "[^"]+",)? pool: "(\w+)", evidence: "(\w+)", share: ([\d.\s/]+) \}/gm)) {
  shares[m[1]] = { pool: m[2], evidence: m[3], share: parseShare(m[4]) };
}

/* Repo convention: fully offline. Every suite here imports the worker directly
   — no dev server required (CI has none, and one depending on a running
   wrangler dev passed locally only because the machine happened to have one).
   The ASSETS stub below serves the real public/ files from disk, so the
   worker's route + harden() path is exercised end to end. */
const worker = (await import("../worker.js")).default;
const assetsStub = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    return new Response(readFileSync(ROOT + "public" + p), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

console.log("\n[A] /api/methodology — shape");
let data = null;
{
  const res = await worker.fetch(new Request("http://x/api/methodology"), {}, {});
  data = await res.json();
  ok("200 OK", res.status === 200, `status=${res.status}`);
}
if (data) {
  ok("has rules_version + scoring_version", !!data.rules_version && !!data.scoring_version);
  ok("has pools, checks, grade_bands", Array.isArray(data.pools) && Array.isArray(data.checks) && Array.isArray(data.grade_bands));
}

console.log("\n[B] no drift — the published table equals the engine constants");
if (data) {
  ok("check count matches CHECK_POLICY", data.checks.length === policyIds.length, `${data.checks.length} vs ${policyIds.length}`);
  ok("scoring_version matches worker", data.scoring_version === scoringVersion, `${data.scoring_version} vs ${scoringVersion}`);
  let drift = [];
  for (const c of data.checks) {
    const expected = Math.round(tierBudget[shares[c.id].pool] * shares[c.id].share);
    if (c.max !== expected) drift.push(`${c.id}: ${c.max}!=${expected}`);
    if (c.pool !== shares[c.id].pool) drift.push(`${c.id}: pool ${c.pool}!=${shares[c.id].pool}`);
  }
  ok("every max + pool matches CHECK_POLICY arithmetic", drift.length === 0, drift.slice(0, 3).join(" | "));
  const poolBudgetMatches = data.pools.every(t => tierBudget[t.pool] === t.budget);
  ok("pool budgets match POOL_BUDGET", poolBudgetMatches);
  ok("grade bands are the documented six-step scale", data.grade_bands.map(b => b.grade).join("") === "ABCDF");
}

console.log("\n[C] /methodology — HTML page + markdown variant");
{
  const htmlRes = await worker.fetch(new Request("http://x/methodology"), { ASSETS: assetsStub }, {});
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
