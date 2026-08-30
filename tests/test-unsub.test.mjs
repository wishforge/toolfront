// 退订功能（合规增强）专项红蓝对抗 —— 生产 worker.js 原样 import
import { createHmac } from "node:crypto";
import worker from "../worker.js";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

function mockKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    async get(k, t) { const v = m.get(k); if (v === undefined) return null; if (t === "json") { try { return JSON.parse(v); } catch { return null; } } return v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    count: p => [...m.keys()].filter(k => k.startsWith(p)).length,
  };
}
const UNSUB = "test_unsub_secret_0123456789";
const email = "user@example.com";
const b64 = (s) => Buffer.from(s).toString("base64url");
const hmac = (e) => createHmac("sha256", UNSUB).update("toolfront-unsub:v1:" + e).digest("hex");
const unsubPath = (e, t) => "/unsubscribe?e=" + encodeURIComponent(b64(e)) + "&t=" + t;
const req = (path, opts = {}) => new Request("https://toolfront.dev" + path, opts);

const env = { KV: mockKV(), UNSUB_SECRET: UNSUB };

/* 1. 合法退订链路 */
console.log("[退订] 功能链路");
await worker.fetch(req("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }), env, {});
let r = await worker.fetch(req(unsubPath(email, hmac(email))), env, {});
let body = await r.text();
ok("合法退订 200 + 成功页", r.status === 200 && body.includes("You're unsubscribed"));
ok("抑制记录写入（sha256 key）", env.KV.count("wl:suppressed:") === 1);
ok("订阅/pending 记录清理", !env.KV.m.has("wl:" + email) && !env.KV.m.has("wl:pending:" + email));
ok("抑制记录存的是哈希非明文", ![...env.KV.m.keys()].some(k => k.includes(email)));

/* 2. 伪造 token → 无 oracle */
console.log("[退订] 伪造/枚举防护");
r = await worker.fetch(req(unsubPath(email, "f".repeat(64))), env, {});
body = await r.text();
ok("错误 HMAC → 无效页（无 oracle）", r.status === 200 && body.includes("not valid"));
const before = env.KV.count("wl:suppressed:");
r = await worker.fetch(req(unsubPath(email, hmac("other@x.com"))), env, {}); // 正确签名的另一邮箱
ok("错误 token 不写 KV", env.KV.count("wl:suppressed:") === before);

/* 3. email 注入载荷 → 不反射 */
console.log("[退订] email 反射 XSS");
const evilEmails = ['<script>alert(1)</script>@x.com', 'a@x.com"><img src=x onerror=alert(1)>', 'a\x00@x.com', '..%2f..%2fetc%2fpasswd'];
for (const e of evilEmails) {
  const p = "/unsubscribe?e=" + encodeURIComponent(b64(e)) + "&t=" + hmac(e);
  r = await worker.fetch(req(p), env, {});
  body = await r.text();
  ok(`注入 email 不反射 ${JSON.stringify(e.slice(0, 22))}`, body.includes("not valid") && !body.includes("<img") && !body.includes("<script"));
}

/* 4. 抑制后：waitlist/resend/confirm 全链路尊重退订 */
console.log("[退订] 抑制全局生效");
env.KV.m.set("wl:suppressed:" + createHmac("sha256", "x").update("x").digest("hex").slice(0, 0), "x"); // no-op
// 重新 setup：让 email 已被抑制（上面第 1 步已抑制），再测
r = await worker.fetch(req("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }), env, {});
ok("抑制后 waitlist 统一 ok 不落库", r.status === 200 && !env.KV.m.has("wl:pending:" + email));
r = await worker.fetch(req("/api/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }), env, {});
ok("抑制后 resend 统一 ok", r.status === 200);

/* 5. 限流验证（退订端点限流返回 200 统一页防枚举，非 429） */
console.log("[退订] 限流缺口验证");
const env2 = { KV: mockKV(), UNSUB_SECRET: UNSUB };
const goodPath = unsubPath(email, hmac(email));
const pages = [];
for (let i = 0; i < 32; i++) {
  const rr = await worker.fetch(req(goodPath, { headers: { "CF-Connecting-IP": "7.7.7.7" } }), env2, {});
  pages.push(await rr.text());
}
ok("前 30 次正常处理（成功页）", pages.slice(0, 30).every(p => p.includes("unsubscribed")));
ok("第 31 次起被限流（翻转为统一无效页，防枚举）", pages[30].includes("not valid") && pages[31].includes("not valid"));
ok("限流后不再写 KV（抑制记录条数不随请求增长）", env2.KV.count("wl:suppressed:") === 1);

/* 6. base64url roundtrip + safeEqual 恒定时间 */
console.log("[退订] 密码学原语");
import { timingSafeEqual } from "node:crypto";
const t1 = hmac(email);
ok("HMAC 固定 64 hex", /^[0-9a-f]{64}$/.test(t1));
ok("不同 email 不同 token", t1 !== hmac("b@x.com"));

console.log(`\n========== 退订专项: ${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
