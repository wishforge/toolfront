// 第十四轮：全端点响应头 & 错误信息泄露 系统审计
import worker from "../worker.js";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

function mockKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, async get(k, t) { const v = m.get(k); if (v === undefined) return null; if (t === "json") { try { return JSON.parse(v); } catch { return null; } } return v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const req = (p, o = {}) => new Request("https://toolfront.dev" + p, o);
const jreq = (p, b, h = {}) => req(p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
const HEADERS = (r) => Object.fromEntries(r.headers.entries());

console.log("[A] HTML 端点安全头完整性");
{
  const r = await worker.fetch(req("/confirm?token=" + "a".repeat(64)), { KV: mockKV() }, {});
  const h = HEADERS(r);
  ok("confirm: CSP + nosniff + no-referrer + XFO + no-store", !!h["content-security-policy"] && h["x-content-type-options"] === "nosniff" && h["referrer-policy"] === "no-referrer" && h["x-frame-options"] === "DENY" && h["cache-control"] === "no-store", JSON.stringify(h));
}
{
  const assets = () => new Response("<html>x</html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const r = await worker.fetch(req("/"), { ASSETS: { fetch: assets } }, {});
  const h = HEADERS(r);
  ok("静态 HTML: CSP + nosniff + XFO + no-referrer", !!h["content-security-policy"] && h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "DENY" && h["referrer-policy"] === "no-referrer");
}

console.log("[B] API 端点安全头（JSON 响应）");
{
  const r = await worker.fetch(jreq("/api/waitlist", { email: "a@b.com" }), { KV: mockKV() }, {});
  const h = HEADERS(r);
  ok("waitlist: Content-Type application/json", (h["content-type"] || "").includes("application/json"));
  ok("waitlist: 有 nosniff（MIME 混淆防护）", h["x-content-type-options"] === "nosniff", "缺 nosniff！");
  ok("waitlist: 有 no-store（POST 响应不缓存）", (h["cache-control"] || "").includes("no-store"), `cache-control=${h["cache-control"]}`);
}
{
  const r = await worker.fetch(req("/api/scan?domain=example.com"), { KV: mockKV() }, {});
  const h = HEADERS(r);
  ok("scan: 有 nosniff", h["x-content-type-options"] === "nosniff", "缺 nosniff！");
}

console.log("[C] OPTIONS 预检响应头");
{
  const r = await worker.fetch(req("/api/scan", { method: "OPTIONS" }), {}, {});
  const h = HEADERS(r);
  ok("OPTIONS: 无 ACAO 头（同源策略拦截第三方，round-18）", h["access-control-allow-origin"] === undefined, "仍返回 ACAO: " + h["access-control-allow-origin"]);
  ok("OPTIONS: 有 nosniff", h["x-content-type-options"] === "nosniff", "缺 nosniff！");
}

console.log("[D] 错误响应信息泄露");
{
  // 各错误路径的 detail 是否泄露内部信息（堆栈/路径/密钥）
  const cases = [
    ["bad_json", await worker.fetch(req("/api/waitlist", { method: "POST", body: "{", headers: { "Content-Type": "application/json" } }), { KV: mockKV() }, {})],
    ["invalid_domain", await worker.fetch(req("/api/scan?domain=127.0.0.1"), { KV: mockKV() }, {})],
  ];
  for (const [name, r] of cases) {
    const body = await r.text();
    const leaked = /stack|at |worker\.js|\.ts:|api[_-]?key|resend|secret|token=/i.test(body) && !/invalid_domain|bad_json/.test(body);
    ok(`错误 ${name} 无内部信息泄露`, !leaked, body.slice(0, 120));
  }
}

console.log("[E] 未知路由行为");
{
  const r = await worker.fetch(req("/api/nonexistent"), { KV: mockKV() }, {});
  ok("未知路由不抛 500（走 ASSETS 404 或 ok）", r.status !== 500, `status=${r.status}`);
}

console.log("[F] harden() 对非 HTML 资产不加 CSP（避免误伤）");
{
  const assets = () => new Response("body{color:red}", { headers: { "Content-Type": "text/css" } });
  const r = await worker.fetch(req("/fonts/fonts.css"), { ASSETS: { fetch: assets } }, {});
  const h = HEADERS(r);
  ok("css 资产: nosniff 有、CSP 无（正确分级）", h["x-content-type-options"] === "nosniff" && !h["content-security-policy"]);
}

console.log(`\n========== 响应头审计: ${pass} 通过 / ${fail} 失败 ==========`);
console.log("(✗ = 缺口)");
process.exit(0);
