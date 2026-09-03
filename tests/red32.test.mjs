// red32 — 挑战页检测 + 诚实计分 + 扫描器身份（spec 2026-08-30，techval 23/23 移植）
// 纪律：challengeProbe / computeScore 从生产 worker.js 原样提取执行，零复制品。
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../worker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SRC = readFileSync(join(ROOT, "worker.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public/index.html"), "utf8");
// report rendering (na / blocked / scoreMax) moved to its own shell in the V5 split
const RHTML = readFileSync(join(ROOT, "public/report.html"), "utf8");

/* ————— A. challengeProbe 从生产 worker.js 提取，原样执行 ————— */
console.log("\n[A] challengeProbe 判定矩阵（生产源码）");
const probeSrc = WORKER_SRC.match(/function challengeProbe\(status, text, cfMitigated\) \{[\s\S]*?\n\}/)[0];
const challengeProbe = new Function("return (" + probeSrc.replace(/^function challengeProbe/, "function") + ")")();

const CH_SAMPLE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head>
<body><div class="main-wrapper">Checking if the site connection is secure</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/managed/v1?ray=abc"></script>
<script>window._cf_chl_opt={cvId:'3',cZone:'example.com',cType:'managed'}</script>
<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b/managed?__cf_chl_rt_tk=x"></form>
</body></html>`;

ok("403 + 完整挑战页 → true", challengeProbe(403, CH_SAMPLE) === true);
ok("503 + 挑战页 → true", challengeProbe(503, CH_SAMPLE) === true);
ok("429 + 挑战页 → true", challengeProbe(429, CH_SAMPLE) === true);
ok("cf-mitigated 头优先（body 无关）→ true", challengeProbe(403, "", "challenge") === true);
ok("403 + 仅 _cf_chl_opt → true", challengeProbe(403, "window._cf_chl_opt={};") === true);
ok("403 + 仅 challenge-form → true", challengeProbe(403, '<form id="challenge-form">') === true);
ok("403 + Attention Required → true", challengeProbe(403, "<h1>Attention Required</h1>") === true);
// 误伤防线
ok("200 + 博客讨论 CF 挑战 → false", challengeProbe(200, CH_SAMPLE) === false);
ok("200 + 'Just a moment' 文案 → false", challengeProbe(200, "<h1>Just a moment</h1>") === false);
ok("403 + 普通权限页 → false", challengeProbe(403, "<html>403 Forbidden nginx</html>") === false);
ok("404 + 挑战串 → false", challengeProbe(404, CH_SAMPLE) === false);
ok("403 + 空 body → false", challengeProbe(403, "") === false);
ok("503 + maintenance 页 → false", challengeProbe(503, "<html>back soon</html>") === false);
ok("200 + cf-mitigated 异常值 → false", challengeProbe(200, "<p>ok</p>", "simulate") === false);

/* ————— B. 计分语义（生产源码结构断言）————— */
console.log("\n[B] na 计分 / blocked 报告语义");
ok("na 项 points=null 计入 unavailable", /points === null[\s\S]{0,80}unavailable\.push/.test(WORKER_SRC));
ok("scoreMax 分母可被 na 缩小", /scoreMax \+= c\.max/.test(WORKER_SRC) && /pct = scoreMax > 0 \? Math\.round\(\(score \/ scoreMax\) \* 100\)/.test(WORKER_SRC));
ok("report.unavailable 仅在非空时输出", /if \(unavailable\.length\) report\.unavailable = unavailable;/.test(WORKER_SRC));
ok("主页被挑战 → blocked 报告（grade:null）", /challengeProbe\(home\.status, home\.text, home\.cfMitigated\)/.test(WORKER_SRC) && /blocked: true, grade: null, score: null/.test(WORKER_SRC));
ok("blocked verdict 为固定文案（不回显目标内容）", /Scan blocked by bot protection\. AI agents likely hit the same wall/.test(WORKER_SRC));
ok("blocked HTTP 200 + 30min 短缓存", /if \(report\.blocked\) \{[\s\S]{0,400}expirationTtl: 1800/.test(WORKER_SRC));
ok("blocked publicReport 剔除内部字段", /const \{ report_json, tool_surface_hash, \.\.\.publicBlocked \} = report;/.test(WORKER_SRC));
ok("非挑战 5xx/403/429 仍退避（不缓存不评分）", /home\.status === 403 \|\| home\.status === 429 \|\| home\.status >= 500/.test(WORKER_SRC));

/* ————— C. fetchCapped 透传 cf-mitigated + HEAD 降级 ————— */
console.log("\n[C] fetchCapped 增强与 HEAD 假阴性降级");
ok("fetchCapped 透传 cfMitigated", /const cfMitigated = res\.headers\.get\("cf-mitigated"\) \|\| null;/.test(WORKER_SRC));
ok("HEAD 返回携带 cfMitigated + 新头部字段（ctype/link/lmod, spec 2026-09-03）", /method === "HEAD"\) return \{ status: res\.status, text: "", cfMitigated, ctype:/.test(WORKER_SRC));
ok("HEAD 405/501 → GET 降级重试（sitemap）", /sitemapRes\.status === 405 \|\| sitemapRes\.status === 501[\s\S]{0,80}(fetchCapped\("https:\/\/" \+ domain \+ "\/sitemap\.xml"\)|probePath\(env, domain, "\/sitemap\.xml"\))/.test(WORKER_SRC));
ok("HEAD 405/501 → GET 降级重试（openapi）", /openapiRes\.status === 405 \|\| openapiRes\.status === 501[\s\S]{0,80}(fetchCapped\("https:\/\/" \+ domain \+ "\/openapi\.json"\)|probePath\(env, domain, "\/openapi\.json"\))/.test(WORKER_SRC));
ok("重定向 SSRF 门仍在（3 跳上限）", /MAX_REDIRECTS = 3;/.test(WORKER_SRC));

/* ————— D. 扫描器身份 ————— */
console.log("\n[D] 扫描器身份规范");
ok("SCAN_UA 升级 0.3 + /bot 说明页", WORKER_SRC.includes('const SCAN_UA = "ToolFront-Scanner/0.3 (+https://toolfront.dev/bot)";'));
ok("public/bot.html 存在", existsSync(join(ROOT, "public/bot.html")));
const BOT = existsSync(join(ROOT, "public/bot.html")) ? readFileSync(join(ROOT, "public/bot.html"), "utf8") : "";
ok("bot.html 含 opt-out 指引", BOT.includes("User-agent: ToolFront-Scanner") && BOT.includes("Disallow: /"));
ok("bot.html 双语", BOT.includes('lang-switch') && BOT.includes('简体中文'));
ok("bot.html 声明 5 个探测路径", ["/robots.txt", "/llms.txt", "/sitemap.xml", "/openapi.json"].every(p => BOT.includes(`<code>${p}</code>`)) && BOT.includes("<code>/</code>"));
ok("bot.html 不执行 JS 声明", BOT.includes("do not execute JavaScript") || BOT.includes("不执行 JavaScript"));
ok("robotsOptedOut 兼容 toolfront-scanner（生产源码）", /a\.toLowerCase\(\)\.includes\("toolfront-scanner"\)/.test(WORKER_SRC));

/* ————— E. UI 诚实化 ————— */
console.log("\n[E] 报告 UI（na 徽章 / warning 横幅 / blocked 版式）");
ok("na 徽章样式存在", /\.pill\.x \{/.test(RHTML) && /\.grade\.na \{/.test(RHTML));
ok("warning 横幅渲染（unavailable 非空时）", /Array\.isArray\(r\.unavailable\) && r\.unavailable\.length/.test(RHTML));
ok("blocked 专用渲染函数", /function renderBlocked\(r\)/.test(RHTML) && /if \(r\.blocked\) \{ renderBlocked\(r\); return; \}/.test(RHTML));
ok("blocked 基线不写入 localStorage（防毒化对比）", /if \(r\.blocked\) \{ renderBlocked\(r\); return; \}/.test(RHTML));
ok("分母显示适配 scoreMax", /typeof r\.scoreMax === 'number' && r\.scoreMax > 0/.test(RHTML));
ok("hasBaseline 增加 r.score 数字守卫", /typeof r\.score === 'number' && prev\.ts != null/.test(RHTML));
ok("i18n: blocked 标题/说明 + warning（双语）", RHTML.includes("'report.blocked.title'") && RHTML.includes("'report.unavailable.warn'") && RHTML.includes("'report.blocked.title': '扫描被 bot 防护拦截'"));
ok("i18n: 三项 na 详情（zh）", RHTML.includes("'llms-txt.na'") && RHTML.includes("'robots-policy.na'") && RHTML.includes("'machine-surfaces.na'"));
ok("biz/fix 列表跳过 na 项", /c\.status === 'pass' \|\| c\.status === 'na'/.test(RHTML) && /c\.status === 'fail' \|\| c\.status === 'partial'/.test(RHTML));
ok("na 不参与对比升降判定", /statusRank\(s\) \{ return s === 'pass' \? 3 : s === 'partial' \? 2 : s === 'fail' \? 1 : -1; \}/.test(RHTML));

/* ————— F. Worker 模块完整性 ————— */
console.log("\n[F] Worker 完整性");
ok("worker.js 默认导出可用", typeof worker === "object" || typeof worker === "function");
ok("challengeProbe 不在 200 上误报（回归锁）", challengeProbe(200, "x".repeat(5000) + CH_SAMPLE) === false);

console.log(`\nred32 结果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
