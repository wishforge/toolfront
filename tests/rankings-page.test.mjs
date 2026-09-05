// rankings-page — public/rankings.html DOM-level smoke tests
// Real page source, real render path (jsdom), mocked fetch/network boundary.
// Mirrors report-dom.test.mjs: inline the two shared i18n files (the page has
// no other external scripts) and let the board run against the real runtime.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public/rankings.html"), "utf8");
const I18N_COMMON = readFileSync(join(ROOT, "public/i18n/common.js"), "utf8");
const I18N_RUNTIME = readFileSync(join(ROOT, "public/i18n/runtime.js"), "utf8");
const HTML_WIRED = HTML
  .replace('<script src="/i18n/common.js"></script>', "<script>" + I18N_COMMON + "</script>")
  .replace('<script src="/i18n/runtime.js"></script>', "<script>" + I18N_RUNTIME + "</script>");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

// Payload follows the monitor /api/rankings row contract (see
// toolfront-monitor src/routes/rankings.ts: RankRow = { domain, score,
// grade, scanned_at }); the page maps it into its internal {d,s,g,t} rows.
const BOARD = {
  ok: true, vertical: "all", count: 3,
  rows: [
    { domain: "a.example", score: 102, grade: "A", scanned_at: "2026-08-30T07:00:00.000Z" },
    { domain: "b.example", score: 80, grade: "B", scanned_at: "2026-08-30T07:01:00.000Z" },
    { domain: "c.example", score: 45, grade: "C", scanned_at: "2026-08-30T07:02:00.000Z" },
  ],
};

function loadPage(url) {
  const errors = [];
  const dom = new JSDOM(HTML_WIRED, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.onerror = function (msg) { errors.push(String(msg)); return true; };
      window.fetch = async (u) => {
        // Only the board endpoint is exercised at load; anything else means
        // the page changed its data path and the test should notice.
        if (String(u).includes("/api/rankings")) {
          return { ok: true, json: async () => BOARD };
        }
        return { ok: false, json: async () => ({ error: "unexpected fetch: " + u }) };
      };
    },
  });
  return { dom, errors };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function rows(doc) { return [...doc.querySelectorAll("#rows tr.rowt")]; }
function nTexts(doc) { return [...doc.querySelectorAll("#rows .score-cell .n")].map(e => e.textContent); }
function doms(doc) { return [...doc.querySelectorAll("#rows .rdom")].map(e => e.textContent); }
function clickGrade(doc, v) {
  const b = [...doc.querySelectorAll("#gradeSeg button")].find(x => x.getAttribute("data-v") === v);
  if (!b) throw new Error("grade filter button not found: " + v);
  b.click();
}

/* A. board renders capability /100 from raw rubric scores */
console.log("\n[A] 榜单渲染（cap100 百分制）");
{
  const { dom, errors } = loadPage("https://toolfront.dev/rankings?lang=en");
  await wait(80);
  const doc = dom.window.document;
  ok("加载后渲染 3 行", rows(doc).length === 3, "got " + rows(doc).length);
  ok("102 分行显示 94（cap100）", nTexts(doc)[0] === "94", JSON.stringify(nTexts(doc)));
  ok("首行为 a.example", doms(doc)[0] === "a.example", JSON.stringify(doms(doc)));
  ok("cap100 与降序排列（94/74/42）", JSON.stringify(nTexts(doc)) === JSON.stringify(["94", "74", "42"]), JSON.stringify(nTexts(doc)));
  ok("A 与 B 计入 ready 卡、C 计入 needs-work 卡",
    doc.getElementById("stReady").textContent === "2" &&
    doc.getElementById("stWork").textContent === "1" &&
    doc.getElementById("stAvg").textContent === "70/100",
    "stReady=" + doc.getElementById("stReady").textContent + " stWork=" + doc.getElementById("stWork").textContent + " stAvg=" + doc.getElementById("stAvg").textContent);
  ok("加载过程零报错", errors.length === 0, JSON.stringify(errors));
}

/* B. grade-letter filter: A-B keeps A and B rows, C keeps C row */
console.log("\n[B] 评级字母过滤");
{
  const { dom, errors } = loadPage("https://toolfront.dev/rankings?lang=en");
  await wait(80);
  const doc = dom.window.document;
  clickGrade(doc, "A-B");
  ok("A-B 过滤保留 2 行", rows(doc).length === 2, "got " + rows(doc).length);
  ok("A-B 过滤保留 a+b", JSON.stringify(doms(doc)) === JSON.stringify(["a.example", "b.example"]), JSON.stringify(doms(doc)));
  ok("A-B 过滤下 102 行仍为 94", nTexts(doc)[0] === "94", JSON.stringify(nTexts(doc)));
  clickGrade(doc, "C");
  ok("C 过滤保留 1 行", rows(doc).length === 1, "got " + rows(doc).length);
  ok("C 过滤保留 c.example", doms(doc)[0] === "c.example", JSON.stringify(doms(doc)));
  ok("C 行 cap100 = 42", nTexts(doc)[0] === "42", JSON.stringify(nTexts(doc)));
  ok("过滤交互零报错", errors.length === 0, JSON.stringify(errors));
}

console.log(`\nrankings-page 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
