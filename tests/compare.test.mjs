// compare — /api/compare contract + /compare page render (spec 2026-09-03 F4).
// API tests mock the network (dogfood [C] pattern); the DOM test follows
// report-dom.test.mjs (jsdom, mocked fetch). Repo convention: self-executing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import worker from "../worker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const REP = (domain, score) => ({
  domain, score, scoreMax: 91, grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "F",
  verdict: "x", checks: [
    { id: "webmcp", label: "WebMCP tools", pool: "emerging", evidence: "A", max: 19, status: score > 50 ? "pass" : "fail", points: score > 50 ? 19 : 0, detail: "d" },
    { id: "llms-txt", label: "llms.txt", pool: "essential", evidence: "C", max: 6, status: "pass", points: 6, detail: "d" },
  ],
  scannedAt: new Date().toISOString(), cached: false, scoring_version: "2.1.0", rules_version: "1.0.0",
});

/* A. API contract */
console.log("\n[A] /api/compare contract");
{
  // Two healthy fake sites (the mock also answers the SSRF gate's DoH
  // queries so every tested domain resolves to a public IP).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (rawUrl) => {
    const u = new URL(String(rawUrl));
    if (u.pathname.includes("dns-query") || u.pathname === "/resolve") {
      return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { status: 200, headers: { "Content-Type": "application/dns-json" } });
    }
    const site = u.hostname;
    if (site === "down.example") throw new Error("getaddrinfo ENOTFOUND down.example");
    if (site === "good.example" || site === "better.example") {
      return new Response("<html><h1>" + site + "</h1></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const env = {}; // no KV, no ASSETS — pure scan path
    const res = await worker.fetch(new Request("https://toolfront.dev/api/compare?a=good.example&b=better.example"), env, {});
    const body = await res.json();
    ok("200 on two scannable domains", res.status === 200, `status=${res.status}`);
    ok("两侧都带自己的报告", body.a && body.b && body.a.domain === "good.example" && body.b.domain === "better.example", JSON.stringify(body).slice(0, 120));
    ok("每侧带自己的 HTTP 状态", body.a_status === 200 && body.b_status === 200);
    ok("报告字段走公共投影（无 report_json）", !("report_json" in body.a) && !("tool_surface_hash" in body.a));

    const miss = await worker.fetch(new Request("https://toolfront.dev/api/compare?a=good.example"), env, {});
    ok("缺参数 → 400", miss.status === 400);

    const same = await worker.fetch(new Request("https://toolfront.dev/api/compare?a=good.example&b=good.example"), env, {});
    ok("同域 → 400", same.status === 400);

    // One side unreachable must not sink the other: statuses carried per side.
    const half = await worker.fetch(new Request("https://toolfront.dev/api/compare?a=good.example&b=down.example"), env, {});
    const halfBody = await half.json();
    ok("一侧失败不拖垮另一侧", half.status === 200 && halfBody.a_status === 200 && halfBody.b_status !== 200,
      JSON.stringify({ s: half.status, a: halfBody.a_status, b: halfBody.b_status }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* B. Page render */
console.log("\n[B] /compare page render (jsdom)");
const HTML = readFileSync(join(ROOT, "public/compare.html"), "utf8");
/* JSDOM does not fetch external <script src>; inline the shared i18n files so
   the page runs against the real runtime (detect + toggle ownership), not a
   stub. Without this the page falls back to its default language. */
const I18N_COMMON = readFileSync(join(ROOT, "public/i18n/common.js"), "utf8");
const I18N_RUNTIME = readFileSync(join(ROOT, "public/i18n/runtime.js"), "utf8");
const HTML_WIRED = HTML
  .replace('<script src="/i18n/common.js"></script>', "<script>" + I18N_COMMON + "</script>")
  .replace('<script src="/i18n/runtime.js"></script>', "<script>" + I18N_RUNTIME + "</script>");
{
  const dom = new JSDOM(HTML_WIRED, {
    url: "https://toolfront.dev/compare?a=good.example&b=better.example&lang=en",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // The page now runs one /api/scan per side (first-finished-first-
      // rendered) — mock routes each domain to its single-side report.
      window.fetch = async (url) => {
        const m = String(url).match(/domain=([^&]+)/);
        const dom = m ? decodeURIComponent(m[1]) : "";
        const body = dom === "good.example" ? REP("good.example", 71) : REP("better.example", 88);
        return { ok: true, json: async () => body };
      };
    },
  });
  await new Promise(r => setTimeout(r, 80));
  const doc = dom.window.document;
  ok("双卡渲染", doc.querySelectorAll(".pcard").length === 2);
  ok("VS 徽章存在", doc.querySelector(".vs-badge") !== null);
  ok("标题带两个域名", (doc.querySelector("#h1") || {}).textContent === "good.example vs better.example", (doc.querySelector("#h1") || {}).textContent);
  ok("delta pill 指向胜者 +N 分", /better\.example leads by 17 pts/.test((doc.querySelector(".delta-pill") || {}).textContent || ""), (doc.querySelector(".delta-pill") || {}).textContent);
  ok("逐项对比表有行", doc.querySelectorAll(".dtable tbody tr").length === 2);
  ok("胜方卡片有高亮边框", doc.querySelectorAll(".scard.win").length === 1);
}

/* C. zh re-render */
console.log("\n[C] zh locale");
{
  const dom = new JSDOM(HTML_WIRED, {
    url: "https://toolfront.dev/compare?a=good.example&b=better.example&lang=zh",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        const body = REP("good.example", 71);
        return { ok: true, json: async () => body };
      };
    },
  });
  await new Promise(r => setTimeout(r, 80));
  const doc = dom.window.document;
  ok("zh delta pill 为平手文案", /平手/.test((doc.querySelector(".delta-pill") || {}).textContent || ""), (doc.querySelector(".delta-pill") || {}).textContent);
  ok("zh 页面 lang 属性", doc.documentElement.lang === "zh-CN");
}

console.log(`\ncompare 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
