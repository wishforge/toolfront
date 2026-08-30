// email-lang — waitlist confirmation is sent in ONE language, matching the
// language the visitor used when signing up (spec: never bilingual).
// Runs the production worker.js with a mocked KV and a stubbed Resend API.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../worker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

function mockKV() {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); if (v === undefined) return null; if (t === "json") { try { return JSON.parse(v); } catch { return null; } } return v; },
    async put(k, v, o) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

function envWithSecrets(kv) {
  return {
    KV: kv,
    RESEND_API_KEY: "re_test_key",
    POSTAL_ADDRESS: "123 Example St, Test City, TC 00000",
    UNSUB_SECRET: "test-unsub-secret",
    PUBLIC_BASE_URL: "https://toolfront.dev",
  };
}

// Capture the outbound Resend call instead of hitting the network.
let sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.resend.com")) {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: "test" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

async function signUp(lang, email) {
  sent = [];
  const kv = mockKV();
  const res = await worker.fetch(
    new Request("https://toolfront.dev/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, lang }),
    }),
    envWithSecrets(kv),
    {}
  );
  return { res, kv, mail: sent[0] };
}

console.log("\n[A] 英文注册 → 英文确认邮件");
{
  const { res, kv, mail } = await signUp("en", "en-user@outlook.com");
  ok("返回 200", res.status === 200, `status=${res.status}`);
  ok("发出一封邮件", !!mail);
  if (mail) {
    ok("主题为英文", mail.subject === "Confirm your spot on ToolFront", mail.subject);
    ok("正文含英文引导语", mail.html.includes("thanks for your interest"));
    ok("正文无中文（单语）", !/[一-鿿]/.test(mail.html), "出现中文字符");
    ok("纯文本版本也是英文", mail.text.includes("Confirm your spot on ToolFront"));
  }
  const pending = await kv.get("wl:token:" + [...kv.m.keys()].find(k => k.startsWith("wl:token:")).replace("wl:token:", ""), "json");
  ok("pending 记录记住 lang=en", pending && pending.lang === "en", JSON.stringify(pending && pending.lang));
}

console.log("\n[B] 中文注册 → 中文确认邮件");
{
  const { res, kv, mail } = await signUp("zh", "zh-user@outlook.com");
  ok("返回 200", res.status === 200, `status=${res.status}`);
  ok("发出一封邮件", !!mail);
  if (mail) {
    ok("主题为中文", mail.subject === "请确认订阅 ToolFront", mail.subject);
    ok("正文含中文引导语", mail.html.includes("感谢关注"));
    ok("正文无英文句子（单语）", !/thanks for your interest|Please confirm your email/.test(mail.html), "残留英文句式");
    ok("纯文本版本也是中文", mail.text.includes("请确认订阅 ToolFront"));
  }
  const tk = [...kv.m.keys()].find(k => k.startsWith("wl:token:"));
  const pending = await kv.get(tk, "json");
  ok("pending 记录记住 lang=zh", pending && pending.lang === "zh", JSON.stringify(pending && pending.lang));
}

console.log("\n[C] 缺失/非法 lang 回退英文");
{
  const { mail } = await signUp("fr", "fallback-user@outlook.com");
  ok("未知语种回退英文", mail && mail.subject === "Confirm your spot on ToolFront", mail && mail.subject);
}

console.log("\n[D] 合规项未丢（CAN-SPAM）");
{
  const { mail } = await signUp("zh", "compliance-user@outlook.com");
  ok("中文邮件仍含实体邮政地址", mail && mail.text.includes("123 Example St"));
  ok("中文邮件仍含退订链接", mail && mail.text.includes("取消订阅"));
}

globalThis.fetch = realFetch;
console.log(`\nemail-lang 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
