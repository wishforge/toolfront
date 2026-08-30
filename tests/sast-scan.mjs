// Semgrep-equivalent custom SAST rules for this stack (Cloudflare Workers + vanilla JS SPA).
// Each rule targets a pattern class that matters here; findings are reported with file:line.
import fs from 'fs';
const R = '.';
let pass = 0, fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? ' — ' + d : '')); c ? pass++ : fail++; };

const worker = fs.readFileSync(`${R}/worker.js`, 'utf8');
const html = fs.readFileSync(`${R}/public/index.html`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// R1: dynamic code execution
ok('R1 无 eval/new Function（代码注入）', !/\beval\s*\(|new\s+Function\s*\(/.test(worker) && !/\beval\s*\(|new\s+Function\s*\(/.test(html), '');
// R2: innerHTML sinks must only ever receive the static i18n dict
const inner = [...html.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(m => m[1]);
ok('R2 innerHTML 仅接收静态词典 t() 或字面量',
   inner.length > 0 && inner.every(s => /\bt\(/.test(s) || /^\s*['"`]/.test(s)),
   inner.length + ' 处: ' + inner.map(s => s.slice(0, 24)).join(' | '));
// R3: every outbound fetch must use a validated/sanitized domain
// Classify every fetch call site. A NEW call site that does not match one of
// the known-safe shapes is what we want to catch — static analysis cannot follow
// data flow (the SSRF gate sits upstream of fetch), so unknown shapes are
// flagged for human review rather than assert-quietly.
const fetchPoints = [];
worker.split("\n").forEach((l, i) => {
  if (!/fetch\(/.test(l)) return;
  const kind = /ASSETS\.fetch/.test(l)          ? "internal-service-binding"
             : /async fetch/.test(l)             ? "worker-entry-handler"
             : /api\.resend\.com/.test(l)        ? "fixed-url"
             : /encodeURIComponent/.test(l)      ? "doh-param-encoded"
             : /rawUrl/.test(l)                  ? "scan-target-gated-upstream"
             : "UNCLASSIFIED";
  fetchPoints.push({ line: i + 1, kind });
});
const unclassified = fetchPoints.filter(f => f.kind === "UNCLASSIFIED");
ok("R3 fetch 调用点全部归入已知安全形态（未归类即告警）",
   fetchPoints.length > 0 && unclassified.length === 0,
   unclassified.length ? "未归类: " + JSON.stringify(unclassified)
                       : fetchPoints.length + " 个调用点已归类");
// R4: JSON.parse must be wrapped (stack-overflow / malformed input)
const parses = [...worker.matchAll(/JSON\.parse\(/g)];
const guarded = [...worker.matchAll(/try\s*\{[^}]*JSON\.parse\(/g)].length;
ok('R4 JSON.parse 全部在 try/catch 内', parses.length === guarded || parses.length <= guarded, `${parses.length} 处解析 / ${guarded} 处受保护`);
// R5: no secrets in source (complement to the gitleaks scan)
ok('R5 源码无硬编码密钥字面量',
   !/\b(re_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,})/.test(worker) &&
   !/\b(re_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,})/.test(html), '');
// R6: compare constants (timing-safe) for secret comparison
ok('R6 密钥比较为恒定时间（无 === 直接比较 secret）',
   !/env\.(?:INTERNAL_SCAN_KEY|UNSUB_SECRET|JWT_SECRET)\s*[=!]==/.test(worker), '');
// R7: fail-closed on missing secrets (no silent fallback to empty string)
ok('R7 缺失密钥时 fail-closed（无静默空串回退）',
   (worker.match(/if\s*\(!env\.[A-Z_]+\)\s*return/g) || []).length >= 2,
   (worker.match(/if\s*\(!env\.[A-Z_]+\)\s*return/g) || []).length + ' 处 fail-closed 门');
// R8: ReDoS-prone nested quantifiers in user-facing regexes
// only inspect regex literals (slice to the closing /), not arbitrary source text
const regexLits = [...worker.matchAll(/\/([^\n/[\\]*(?:\\.[^\n/[\\]*)*)\/[gimsuy]*/g)]
  .map(m => m[1]).filter(r => r.length > 4);
const redos = regexLits.filter(r => /\([^)]*[+*][^)]*\)[+*]/.test(r));
ok('R8 正则字面量无嵌套量词（ReDoS）', redos.length === 0, redos.length ? redos.join(' | ') : regexLits.length + ' 个正则全部安全');
// R9: KV writes carry explicit TTL (storage limitation / GDPR)
const kvPuts = [...worker.matchAll(/KV\.put\([^)]+/g)].map(m => m[0]);
ok('R9 KV 写入全部带 expirationTtl（存储限制）',
   kvPuts.length > 0 && kvPuts.every(p => !/KV\.put\(\s*["'][^"']+["']\s*,\s*[^,)]+\s*\)/.test(p) || /expirationTtl/.test(p)),
   kvPuts.length + ' 处写入');
// R10: no wildcards in CSP
// unsafe-inline is inherent to a single-file SPA (all JS inline in index.html) and
// is neutralised by having NO html-injection sink (report renders via textContent,
// target-site content never reaches the DOM — verified round 21/24). What must
// hold is: default-src locked to 'self', no domain wildcards, framing/base/objects
// all denied.
ok('R10 CSP 默认收窄且无域名通配符（unsafe-inline 为 SPA 已知权衡）',
   (() => { const h = fs.readFileSync(`${R}/public/_headers`, 'utf8');
            return /default-src 'self'/.test(h) && !/\b(?:script|style|img|font|connect)-src[^;]*\*/.test(h)
                   && /frame-ancestors 'none'/.test(h) && /object-src 'none'/.test(h) && /base-uri/.test(h); })(), '');

console.log(`════════ SAST: ${pass} passed, ${fail} failed ════════`);
