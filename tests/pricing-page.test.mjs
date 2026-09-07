// pricing-page — structure, waitlist form contract, and copy rules
// Static checks (no network): page shell + worker route + abuse guards.
import { readFileSync } from "node:fs";

const HTML = readFileSync("./public/pricing.html", "utf8");
const WORKER = readFileSync("./worker.js", "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name + (detail ? " | " + detail : "")); }
  else { fail++; console.log("  ✗ " + name + (detail ? " | " + detail : "")); }
}

console.log("\n[pricing] page shell");
ok("plans: all three tiers present", ["¥99", "¥299", "¥199"].every(p => HTML.includes(p)), "99/299/199");
ok("Pro carries the hot-tag", HTML.includes("FULL WATCH"));
ok("free-forever line present", /free — forever|免费——永久/.test(HTML));
ok("no credit-card promises (copy rule)", !/credit card|信用卡/i.test(HTML));
ok("no checkout words (no billing yet)", !/checkout|pay now|立即支付/i.test(HTML));

console.log("\n[pricing] waitlist form contract");
ok("form posts to /api/waitlist", HTML.includes("/api/waitlist"));
ok("email field present", HTML.includes('type="email"'));
ok("plan select with whitelisted values", ["basic", "pro", "report"].every(v => HTML.includes(`value="${v}"`)));
ok("honeypot field present (bot trap)", HTML.includes('class="hp"'));
ok("double opt-in explained", /Double opt-in|双确认/.test(HTML));

console.log("\n[pricing] worker wiring");
ok("worker serves /pricing", WORKER.includes('"/pricing"') && WORKER.includes("/pricing.html"));
ok("waitlist stores plan (whitelisted)", WORKER.includes('PLAN_KEYS.indexOf(body.plan)'));
ok("plan whitelist covers pricing tiers", WORKER.includes('["basic", "pro", "report"]'));

console.log("\n[pricing] i18n");
ok("zh summary block present", HTML.includes('class="zh"'));
ok("runtime wired for UI toggling", HTML.includes("/i18n/runtime.js"));
ok("PAIRS covers badge + plans + form", ["p.badge", "p.b1", "p.wl.btn", "p.q3"].every(k => HTML.includes("'" + k + "'")));

console.log(`\npricing-page 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
