// product-checks — unit tests for the three checks added 2026-09-03
// (api-errors / freshness / link-headers) plus scoring-policy invariants.
// Pure functions only: no network, no DOM, no fixtures. Repo convention:
// self-executing, console.log progress, process.exit(fail ? 1 : 0).
import {
  checkApiErrors, checkFreshness, checkLinkHeaders,
  CHECK_POLICY, TIER_BUDGET,
} from "../worker.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// SCORING_VERSION cannot be a named export (workerd only accepts function
// exports alongside the default handler), so verify it from source instead.
const WORKER_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

console.log("\n[A] checkApiErrors — unknown API path must fail machine-readable");
ok("404 + JSON → pass", checkApiErrors({ status: 404, ctype: "application/json" }).status === "pass");
ok("404 + problem+json → pass", checkApiErrors({ status: 404, ctype: "application/problem+json; charset=utf-8" }).status === "pass");
ok("404 + HTML → fail", checkApiErrors({ status: 404, ctype: "text/html; charset=utf-8" }).status === "fail");
ok("404 + no content-type → fail", checkApiErrors({ status: 404, ctype: null }).status === "fail");
ok("200 on unknown path → partial", checkApiErrors({ status: 200, ctype: "text/html" }).status === "partial");
ok("unreachable → na", checkApiErrors({ status: 0 }).status === "na");
ok("missing probe → na", checkApiErrors(null).status === "na");
ok("bot-challenge (cf-mitigated) → na", checkApiErrors({ status: 403, ctype: "text/html", cfMitigated: "challenge" }).status === "na");
ok("fail detail names the content-type", /text\/html/.test(checkApiErrors({ status: 404, ctype: "text/html" }).detail));

console.log("\n[B] checkFreshness — agents must tell how recent content is");
ok("dateModified → pass", checkFreshness({ text: '{"dateModified":"2026-09-01"}' }).status === "pass");
ok("article:modified_time → pass", checkFreshness({ text: '<meta property="article:modified_time" content="2026-09-01">' }).status === "pass");
ok("Last-Modified header → pass", checkFreshness({ text: "<html></html>", lmod: "Wed, 02 Sep 2026 00:00:00 GMT" }).status === "pass");
ok("published_time only → partial", checkFreshness({ text: '<meta property="article:published_time" content="2026-01-01">' }).status === "partial");
ok("<time datetime> only → partial", checkFreshness({ text: '<time datetime="2026-01-01">Jan 1</time>' }).status === "partial");
ok("no signals → fail", checkFreshness({ text: "<html><body>plain</body></html>" }).status === "fail");
ok("empty text → fail (no crash)", checkFreshness({ text: "" }).status === "fail");

console.log("\n[C] checkLinkHeaders — RFC 8288 Link as request-time discovery");
ok("service-desc rel → pass", checkLinkHeaders({ link: '</openapi.json>; rel="service-desc"' }).status === "pass");
ok("sitemap rel → pass", checkLinkHeaders({ link: '</sitemap.xml>; rel="sitemap"' }).status === "pass");
ok("api-catalog rel → pass", checkLinkHeaders({ link: '</.well-known/api-catalog>; rel="api-catalog"' }).status === "pass");
ok("Link without agent rels → partial", checkLinkHeaders({ link: '</next>; rel="next"' }).status === "partial");
ok("no Link header → fail", checkLinkHeaders({ link: null }).status === "fail");
ok("missing home → fail (no crash)", checkLinkHeaders(undefined).status === "fail");

console.log("\n[D] scoring policy invariants (spec §F3 resplit)");
const ids = Object.keys(CHECK_POLICY);
ok("9 checks defined", ids.length === 9, `got ${ids.length}`);
for (const tier of Object.keys(TIER_BUDGET)) {
  const shareSum = ids.filter(id => CHECK_POLICY[id].tier === tier).reduce((s, id) => s + CHECK_POLICY[id].share, 0);
  ok(`${tier} shares sum to 1.0`, Math.abs(shareSum - 1) < 1e-9, `sum=${shareSum}`);
}
for (const id of ids) {
  const p = CHECK_POLICY[id];
  const max = Math.round(TIER_BUDGET[p.tier] * p.share);
  ok(`${id} max positive (${max})`, max > 0);
}
ok("SCORING_VERSION bumped to 2.1.0", /const SCORING_VERSION = "2\.1\.0";/.test(WORKER_SRC));

console.log(`\nproduct-checks 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
