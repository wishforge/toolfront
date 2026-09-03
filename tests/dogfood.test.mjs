// dogfood — our own site must score A with our own scanner.
//
// Hermetic: reads the files in public/ straight from disk and runs the
// PRODUCTION check functions imported from worker.js (no copy, no server).
// If a redesign ever drops a JSON-LD block, deletes llms.txt, or breaks the
// robots policy, this fails — the same way we would report it to a customer.
import { readFileSync, existsSync } from "node:fs";
import worker from "../worker.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  extractWebMcpSurface, checkWebMCP, checkToolSecurity, checkStructuredData,
  checkLlmsTxt, checkRobotsAI, checkMachineSurfaces, checkFreshness,
  checkLinkHeaders, CHECK_POLICY, TIER_BUDGET,
} from "../worker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const read = (p) => existsSync(join(ROOT, "public", p))
  ? { status: 200, text: readFileSync(join(ROOT, "public", p), "utf8"), cfMitigated: false }
  : { status: 404, text: "", cfMitigated: false };

const home = read("index.html");
const llms = read("llms.txt");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");
const openapi = read("openapi.json");

// Workers Assets applies public/_headers at the asset layer; the on-disk
// stand-in must do the same or the link-headers check would read the wrong
// layer (the header lives in _headers, not in index.html).
const headersRules = (() => {
  if (!existsSync(join(ROOT, "public", "_headers"))) return [];
  const rules = []; let cur = null;
  for (const line of readFileSync(join(ROOT, "public", "_headers"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { path: t, headers: [] }; rules.push(cur); }
    else if (cur) { const i = line.indexOf(":"); cur.headers.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]); }
  }
  return rules;
})();
const headersFor = (p) => {
  const h = {};
  for (const r of headersRules) {
    const match = r.path.endsWith("*") ? p.startsWith(r.path.slice(0, -1)) : p === r.path;
    if (match) for (const [k, v] of r.headers) h[k] = v;
  }
  return h;
};
home.link = headersFor("/").link || null;
home.lmod = headersFor("/").lmod || null;

const surface = extractWebMcpSurface(home.text);
// Max values come from the SAME scoring policy the scanner uses (worker.js)
// — no second hardcoded copy of the weights here.
const maxOf = (id) => Math.round(TIER_BUDGET[CHECK_POLICY[id].tier] * CHECK_POLICY[id].share);
const checks = [
  ["webmcp", checkWebMCP(surface)],
  ["tool-security", checkToolSecurity(surface)],
  ["structured-data", checkStructuredData(home.text)],
  ["llms-txt", checkLlmsTxt(llms)],
  ["robots-policy", checkRobotsAI(robots)],
  ["machine-surfaces", checkMachineSurfaces(sitemap, openapi)],
  // api-errors is na for self-scans by design (spec 2026-09-03): the asset
  // server cannot exercise the worker's route fallback, so there is nothing
  // to score here — it is excluded from this run entirely.
  ["freshness", checkFreshness(home)],
  ["link-headers", checkLinkHeaders(home)],
];

console.log("\n[A] 自家站点跑分（生产检查函数 × public/ 实际文件）");
let total = 0, maxSum = 0;
for (const [id, r] of checks) {
  const max = maxOf(id);
  const pts = Math.round((r.ratio ?? 0) * max);
  total += pts;
  maxSum += max;
  console.log(`     ${id.padEnd(18)} ${String(pts).padStart(3)}/${String(max).padEnd(3)}  ${r.status}`);
}
const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 50 ? "C" : total >= 30 ? "D" : "F";
console.log(`\n  总分 ${total}/${maxSum} · 等级 ${grade}\n`);

ok("自家站点达到 A 级", grade === "A", `实际 ${total}/${maxSum}`);
ok("总分 ≥ 95%（打样标准，api-errors 自扫 na 不计分）", total >= Math.round(0.95 * maxSum), `实际 ${total}/${maxSum}`);
for (const [id, r] of checks) {
  ok(`${id} 检查通过（非 partial/fail）`, r.status === "pass", r.status + " — " + r.detail);
}

console.log("\n[B] 打样文件必须真实存在");
for (const f of ["llms.txt", "robots.txt", "sitemap.xml", "openapi.json"]) {
  ok(`public/${f} 存在`, existsSync(join(ROOT, "public", f)));
}
ok("主页含 ≥3 个 JSON-LD 块", (home.text.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["']/gi) || []).length >= 3);
ok("主页含 og:title + og:description",
  /<meta[^>]*property\s*=\s*["']og:title["']/i.test(home.text) &&
  /<meta[^>]*property\s*=\s*["']og:description["']/i.test(home.text));
ok("robots.txt 明确欢迎 AI 爬虫", /user-agent\s*:\s*GPTBot/i.test(robots.text));
ok("sitemap.xml 声明了真实页面", /<loc>https:\/\/toolfront\.dev\/<\/loc>/.test(sitemap.text));
ok("openapi.json 描述真实接口", /"\/api\/scan"/.test(openapi.text));

/* C. Self-scan: our own domain is read from the published assets (a Worker
   cannot fetch its own zone) and the result must be LABELLED (self: true) so
   nobody mistakes it for a live network scan. The ASSETS stand-in below does
   exactly what Workers Assets does: serve the files that live in public/. */
console.log("\n[C] 自扫路径必须走资源读取并标注 self");
{
  const assetsFetch = async (req) => {
    const p = new URL(req.url).pathname;
    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    const full = join(ROOT, "public", file);
    if (!existsSync(full)) return new Response("not found", { status: 404 });
    // Faithful emulation: Workers Assets merges public/_headers into asset
    // responses (that is where our Link header lives — see headersFor above).
    return new Response(readFileSync(full, "utf8"), { status: 200, headers: { "Content-Type": "text/plain", ...headersFor(p) } });
  };
  const env = { ASSETS: { fetch: assetsFetch } };
  const res = await worker.fetch(new Request("https://toolfront.dev/api/scan?domain=toolfront.dev"), env, {});
  const body = await res.json();
  ok("自扫返回 200（不再 502 unreachable）", res.status === 200, `status=${res.status}`);
  ok("自扫带 self:true 标记来源", body.self === true, JSON.stringify({ self: body.self }));
  ok("自扫仍是满分 A（api-errors 自扫 na 不计分）", body.score === body.scoreMax && body.grade === "A", `${body.score}/${body.scoreMax} ${body.grade}`);
  ok("自扫九项：八项 pass + api-errors na", (body.checks || []).every(c => c.status === "pass" || (c.id === "api-errors" && c.status === "na")),
    JSON.stringify((body.checks || []).filter(c => c.status !== "pass" && c.id !== "api-errors").map(c => c.id + ":" + c.status)));
  ok("自扫 api-errors 不进 unavailable 警告（非 bot 拦截原因）", !(body.unavailable || []).includes("api-errors"),
    JSON.stringify(body.unavailable));

  // A third-party domain must NOT be labelled: the special case is ours only.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><h1>x</h1></html>", { status: 200 });
  const other = await worker.fetch(new Request("https://toolfront.dev/api/scan?domain=third-party-example.org"), {}, {});
  const otherBody = await other.json().catch(() => ({}));
  ok("第三方域名不带 self 标记", !("self" in otherBody) || otherBody.self !== true,
    JSON.stringify({ self: otherBody.self, err: otherBody.error }));
  globalThis.fetch = realFetch;
}

console.log(`\ndogfood 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
