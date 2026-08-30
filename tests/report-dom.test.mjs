// report-dom — V5 report page (public/report.html) DOM-level smoke tests
// Real page source, real render path (jsdom), mocked fetch/network boundary.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public/report.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const REPORT = {
  domain: "example.com", score: 37, scoreMax: 100, grade: "D",
  verdict: "Partially readable. Agents guess some of the time, fail the rest.",
  scannedAt: "2026-08-30T07:00:00.000Z", cached: false,
  checks: [
    { id: "webmcp", label: "WebMCP tools", max: 20, status: "partial", points: 12, detail: "partial tools" },
    { id: "tool-security", label: "Tool surface security", max: 10, status: "pass", points: 10, detail: "clean" },
    { id: "structured-data", label: "Structured data", max: 20, status: "partial", points: 9, detail: "fragments" },
    { id: "llms-txt", label: "llms.txt", max: 15, status: "fail", points: 0, detail: "missing" },
    { id: "robots-policy", label: "AI crawler policy", max: 10, status: "partial", points: 6, detail: "unstated" },
    { id: "machine-surfaces", label: "Machine-readable surfaces", max: 25, status: "fail", points: 0, detail: "no map" },
  ],
};
const BLOCKED = {
  domain: "blocked.example", blocked: true, grade: null, score: null, scoreMax: 0,
  checks: REPORT.checks.map(c => ({ ...c, status: "na", points: null })),
  unavailable: ["llms-txt", "robots-policy", "machine-surfaces"],
  scannedAt: "2026-08-30T07:00:00.000Z",
};

function loadPage(url, fetchMock) {
  const dom = new JSDOM(HTML, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fetchMock || (async () => ({ ok: true, json: async () => REPORT }));
    },
  });
  return dom;
}

function textOf(sel, dom) { const e = dom.window.document.querySelector(sel); return e ? e.textContent.trim() : null; }

/* A. happy path */
console.log("\n[A] happy path (37/D report)");
{
  const dom = loadPage("https://toolfront.dev/report?domain=example.com&lang=en");
  await new Promise(r => setTimeout(r, 50));
  const doc = dom.window.document;
  const grade = textOf(".grade", dom);
  ok("等级字母渲染 D", grade === "D", `got ${grade}`);
  ok("分数 37/100", textOf(".nums .score", dom).includes("37"));
  ok("游标标签含 you · 37", doc.querySelector(".track .cursor").getAttribute("data-label") === "You · 37");
  ok("六枚状态胶囊", doc.querySelectorAll(".pills .pill").length === 6);
  ok("SVG 图标注入胶囊", doc.querySelectorAll(".pills .pill svg").length === 6);
  ok("业务影响卡渲染 ≥3 项", doc.querySelectorAll(".biz-item").length >= 3);
  ok("修复清单 5 项", doc.querySelectorAll(".fix input[type=checkbox]").length === 5);
  ok("预估条存在", doc.querySelector(".potential .est") !== null);
  ok("CTA 表单存在", doc.querySelector(".cta input[type=email]") !== null);
  ok("域名进标题头", textOf(".rhead .dom", dom) === "example.com");
  ok("地址栏 replaceState 为分享链接", dom.window.location.search.includes("domain=example.com"));
  ok("基线已写入 localStorage", (() => { try { return !!dom.window.localStorage.getItem("tf-last:example.com"); } catch (_) { return false; } })());
}

/* B. language switch re-render */
console.log("\n[B] 中文切换重渲染");
{
  const dom = loadPage("https://toolfront.dev/report?domain=example.com&lang=zh");
  await new Promise(r => setTimeout(r, 30));
  const doc = dom.window.document;
  ok("zh 模式判定文案为中文", (textOf(".verdict", dom) || "").includes("猜") || doc.documentElement.lang === "zh-CN", textOf(".verdict", dom));
  doc.getElementById("lang-en").click();
  await new Promise(r => setTimeout(r, 30));
  ok("切回 EN 重渲染不崩", doc.querySelectorAll(".pills .pill").length === 6);
  ok("EN 模式判定为英文", (textOf(".verdict", dom) || "").length > 10);
}

/* C. blocked report */
console.log("\n[C] blocked 报告（bot 防护拦截）");
{
  const dom = loadPage("https://toolfront.dev/report?domain=blocked.example", async () => ({ ok: true, json: async () => BLOCKED }));
  await new Promise(r => setTimeout(r, 50));
  const doc = dom.window.document;
  ok("blocked 徽章为 –", textOf(".grade", dom) === "–");
  ok("无修复清单（无分数可修）", doc.querySelectorAll(".fix input[type=checkbox]").length === 0);
  ok("无 CTA 留资（无分数不推upsell）", doc.querySelector(".cta input[type=email]") === null);
  ok("拦截说明渲染", (textOf(".warn-banner", dom) || "").length > 10);
}

/* D. error path */
console.log("\n[D] API 错误路径");
{
  const dom = loadPage("https://toolfront.dev/report?domain=down.example", async () => ({ ok: false, json: async () => ({ error: "unreachable", detail: "Could not scan this site." }) }));
  await new Promise(r => setTimeout(r, 50));
  ok("错误信息以 scan-error 呈现", dom.window.document.querySelector(".scan-error") !== null);
}

/* E. security invariants */
console.log("\n[E] 安全不变量");
{
  ok("无 insertAdjacentHTML", !HTML.includes("insertAdjacentHTML"));
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hits = (script.match(/\.innerHTML\s*=/g) || []).length;
  ok("innerHTML ≤ 3 处（静态词典/图标）", hits <= 3, `实际 ${hits}`);
  ok("esc() 保持契约形状", /function esc\(s\) \{[\s\S]*?\n  \}/.test(HTML));
  // XSS 载荷通过 report 字段流动：domain/details 均走 textContent
  const dom = loadPage("https://toolfront.dev/report?domain=%3Cimg%20src%3Dx%3E", async () => ({
    ok: true,
    json: async () => ({ ...REPORT, domain: "<img src=x onerror=alert(1)>", checks: REPORT.checks.map(c => ({ ...c, detail: "<svg onload=alert(1)>" })) }),
  }));
  await new Promise(r => setTimeout(r, 50));
  const injected = dom.window.document.querySelectorAll("img[src=x], svg[onload]");
  ok("XSS 载荷零元素注入", injected.length === 0);
  ok("恶意域名以纯文本呈现", (dom.window.document.querySelector(".rhead .dom") || {}).textContent === "<img src=x onerror=alert(1)>");
}

/* F. 留资失败必须诚实（不可一律报成功） */
console.log("\n[F] waitlist 失败反馈的诚实性");
{
  // The server rejects an undeliverable address with 400 and stores nothing.
  // The page must NOT claim success in that case.
  const dom = loadPage("https://toolfront.dev/report?domain=example.com", async (u) => {
    if (String(u).includes("/api/waitlist")) {
      return { ok: false, status: 400, json: async () => ({ ok: false, stored: false }) };
    }
    return { ok: true, json: async () => REPORT };
  });
  await new Promise(r => setTimeout(r, 60));
  const doc = dom.window.document;
  const em = doc.querySelector(".cta input[type=email]");
  const btn = doc.querySelector(".cta button");
  em.value = "nobody@example.com";
  btn.click();
  await new Promise(r => setTimeout(r, 80));
  const queued = doc.querySelector(".cta .queued");
  ok("失败时给出失败提示", !!queued && queued.textContent.includes("didn't go through"), queued && queued.textContent);
  // Only the rendered notice counts: the LANGS dictionary lives in the page's
  // <script>, so matching on body.textContent would hit the string there.
  ok("失败时不谎报成功", !!queued && !queued.textContent.includes("Check your inbox"), queued && queued.textContent);
  ok("失败后按钮可重试（未锁死）", btn.disabled === false);
}

console.log(`\nreport-dom 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
