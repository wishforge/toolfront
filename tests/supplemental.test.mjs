// supplemental — spec 2026-09-03 F6: training-crawler parser, supplemental
// report shape, and the "not scored" guarantee. Repo convention: self-executing.
import {
  parseTrainingCrawlerBlocks, CHECK_POLICY, POOL_BUDGET,
} from "../worker.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

console.log("\n[A] parseTrainingCrawlerBlocks — group-scoped blanket blocks");
ok("GPTBot blocked", parseTrainingCrawlerBlocks(`User-agent: GPTBot\nDisallow: /`).includes("GPTBot"));
ok("CCBot not in GPTBot-only policy", !parseTrainingCrawlerBlocks(`User-agent: GPTBot\nDisallow: /`).includes("CCBot"));
ok("consecutive UA lines share one group", (() => {
  const r = parseTrainingCrawlerBlocks(`User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /`);
  return r.includes("GPTBot") && r.includes("CCBot");
})());
ok("partial disallow is NOT a blanket block", parseTrainingCrawlerBlocks(`User-agent: GPTBot\nDisallow: /private/`).length === 0);
ok("non-training bot ignored", parseTrainingCrawlerBlocks(`User-agent: SomeBot\nDisallow: /`).length === 0);
ok("empty robots → empty list", parseTrainingCrawlerBlocks("").length === 0);
ok("missing robots → empty list (not a crash)", parseTrainingCrawlerBlocks(null).length === 0);
ok("full-site opt-out also counts as training block", (() => {
  const r = parseTrainingCrawlerBlocks(`User-agent: ToolFront-Scanner\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /`);
  return r.includes("CCBot");
})());
ok("case-insensitive directives", parseTrainingCrawlerBlocks(`user-agent: gptbot\ndisallow: /`).includes("GPTBot"));

console.log("\n[B] scoring untouched — supplemental must not affect the score");
ok("still 9 checks in CHECK_POLICY", Object.keys(CHECK_POLICY).length === 9);
ok("no supplemental check leaked into policy", !("supplemental" in CHECK_POLICY) && !Object.keys(CHECK_POLICY).some(k => k.includes("training") || k.includes("auth")));
ok("supplemental adds no score weight — version comes from the engine, not from this test", /const SCORING_VERSION = "3\.0\.0";/.test((await import("node:fs")).readFileSync(new URL("../worker.js", import.meta.url), "utf8")));
console.log("\n[C] self-scan carries supplemental (dogfood-style, mocked network)");
{
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const worker = (await import("../worker.js")).default;
  const assetsFetch = async (req) => {
    const p = new URL(req.url).pathname;
    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    const full = join(ROOT, "public", file);
    if (!existsSync(full)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(full, "utf8"), { status: 200, headers: { "Content-Type": "text/plain" } });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network disabled in test"); };
  try {
    const res = await worker.fetch(new Request("https://toolfront.dev/api/scan?domain=toolfront.dev"), { ASSETS: { fetch: assetsFetch } }, {});
    const body = await res.json();
    ok("self-scan has supplemental", !!body.supplemental);
    ok("training group has 5 signals", Object.keys(body.supplemental.training).length === 5);
    ok("agent_auth group has 2 signals", Object.keys(body.supplemental.agent_auth).length === 2);
    ok("our own robots does not blanket-block training bots (open)", body.supplemental.training.crawler_blocking.status === "open", JSON.stringify(body.supplemental.training.crawler_blocking));
    ok("ai.txt not present on our site (honest notfound)", body.supplemental.training.ai_txt.status === "notfound");
    ok("score integrity: equals the sum of scored checks (supplemental adds nothing)", (() => {
      let s = 0, m = 0;
      for (const c of body.checks || []) { if (c.points === null) continue; s += c.points; m += c.max; }
      return body.score === s && body.scoreMax === m;
    })(), `score=${body.score} scoreMax=${body.scoreMax}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\nsupplemental 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
