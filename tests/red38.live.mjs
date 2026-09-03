// red38 — dual-mode login attack surfaces (monitor dev, 8787).
// New endpoints from feat/dual-mode-login (PR #16): /api/login-link,
// /login/continue, /api/login-link/verify, /api/monitor-setup.
// Covers: enumeration parity (byte-level), forged/expired/garbled tokens,
// single-use consumption, open-redirect guard on `next`, cookie flags,
// mail-bombing throttles, and the anti-gateway-preview confirm page.
// Token minting uses the LOCAL dev secret (.dev.vars) — never production.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MON = "http://127.0.0.1:8787";
const MONDIR = fileURLToPath(new URL("../../toolfront-monitor/", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c ? "" : "  " + e)); c ? pass++ : fail++; };

const env = { ...process.env, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
const post = (path, body) => fetch(MON + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path, headers = {}) => fetch(MON + path, { headers });

const secret = readFileSync(MONDIR + ".dev.vars", "utf8").match(/JWT_SECRET=(.*)/)[1].trim();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mint = (payload) => b64(payload) + "." + createHmac("sha256", secret).update(b64(payload)).digest("base64url");
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql], { cwd: MONDIR, env, encoding: "utf8" })
  .slice(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", "SELECT 1"], { cwd: MONDIR, env, encoding: "utf8" }).length ? 0 : 0));

// Pre-flight: the login-link IP bucket (30/60s) may still be draining from a
// previous run — a 429 here means wait one refill window, not a product bug.
{
  const warm = await post("/api/login-link", { identity: "warmup-red38@example.org" });
  if (warm.status === 429) {
    console.log("  …login-link bucket refilling — waiting 61s (expected on back-to-back runs)");
    await new Promise((r) => setTimeout(r, 61000));
  }
}

console.log("═══ A. magic door: enumeration & mail-bombing ═══");
{
  const known = "ui-check-1788397272@example.org";
  const unknown = "red38-nobody-" + Date.now() + "@example.org";
  const r1 = await post("/api/login-link", { identity: known });
  const r2 = await post("/api/login-link", { identity: unknown });
  const t1 = await r1.text(), t2 = await r2.text();
  ok("A1 known vs unknown: byte-identical body", t1 === t2, t1.slice(0, 40) + " vs " + t2.slice(0, 40));
  ok("A2 both 200", r1.status === 200 && r2.status === 200);
  ok("A3 no input reflection", !t1.includes(known));
  const sc = r1.headers.get("set-cookie") || "";
  ok("A4 autologin cookie flags", /tfm-autologin=/.test(sc) && /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Lax/i.test(sc), sc);
  ok("A5 cookie 30-minute window", /Max-Age=1800/.test(sc));
  // MAIL_LIMITER is 1/60s per email: a second immediate send must be refused
  const r3 = await post("/api/login-link", { identity: known });
  ok("A6 mail cooldown: rapid resend throttled", r3.status === 429, "HTTP " + r3.status);
  ok("A7 429 leaks nothing about the account", !(await r3.text()).includes(known));
  const bad = await post("/api/login-link", { identity: "not-an-email" });
  ok("A8 malformed email -> uniform ok (no oracle)", bad.status === 200);
}

console.log("═══ B. token attacks ═══");
{
  const email = "red38-flow-" + Date.now() + "@example.org";
  await post("/api/monitor-setup", { url: "https://probe.example.com", email });
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command",
    `SELECT login_jti FROM users WHERE email='${email}'`], { cwd: MONDIR, env, encoding: "utf8" });
  const rows = JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
  const jti = rows[0].login_jti;
  ok("B0 setup created the account with a jti", !!jti);

  ok("B1 garbage token -> invalid, no session", !(await get("/login/continue?token=garbage")).headers.get("set-cookie"));
  const forged = mint({ type: "login", email, jti, exp: Date.now() + 3e5 });
  const forgedSig = forged.slice(0, -4) + "AAAA";
  const rForged = await post("/api/login-link/verify", { token: forgedSig });
  ok("B2 tampered signature rejected", rForged.status === 400, "HTTP " + rForged.status);
  const expired = mint({ type: "login", email, jti, exp: Date.now() - 1000 });
  ok("B3 expired token rejected", (await post("/api/login-link/verify", { token: expired })).status === 400);
  const wrongType = mint({ type: "reset", email, jti, exp: Date.now() + 3e5 });
  ok("B4 wrong token type rejected", (await post("/api/login-link/verify", { token: wrongType })).status === 400);

  // valid token: GET (no cookie) must NOT consume — only render the confirm page
  const token = mint({ type: "login", email, jti, next: "/panel", exp: Date.now() + 3e5 });
  const enc = encodeURIComponent(token);
  const page = await get("/login/continue?token=" + enc);
  const pageText = await page.text();
  ok("B5 GET without cookie -> confirm page (anti gateway preview)", pageText.includes("即将登录") || pageText.includes("continue-btn"));
  const v1 = await post("/api/login-link/verify", { token });
  const v1j = await v1.json();
  ok("B6 verify issues a session", v1.status === 200 && !!v1j.token && v1j.ok === true);
  ok("B7 session JWT carries no jti/secret material", !JSON.stringify(v1j).includes(jti));
  const v2 = await post("/api/login-link/verify", { token });
  ok("B8 replay rejected (single use)", v2.status === 400, "HTTP " + v2.status);
  // open-redirect guard: a hostile `next` must fall back to /panel
  const email2 = "red38-next-" + Date.now() + "@example.org";
  await post("/api/monitor-setup", { url: "https://probe.example.com", email: email2 });
  const raw2 = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command",
    `SELECT login_jti FROM users WHERE email='${email2}'`], { cwd: MONDIR, env, encoding: "utf8" });
  const jti2 = JSON.parse(raw2.slice(raw2.indexOf("[")))[0].results[0].login_jti;
  const evil = mint({ type: "setup", email: email2, jti: jti2, next: "https://evil.example.com/c", exp: Date.now() + 3e5 });
  const v3 = await post("/api/login-link/verify", { token: evil });
  const v3j = await v3.json();
  ok("B9 hostile next -> falls back to /panel", v3j.ok === true && v3j.next === "/panel", JSON.stringify(v3j.next));
}

console.log("═══ C. setup door ═══");
{
  const s1 = await post("/api/monitor-setup", { url: "https://x.example.com", email: "red38-bad-url-" + Date.now() + "@example.org" });
  ok("C1 invalid url -> uniform ok (no oracle)", s1.status === 200);
  const s2 = await post("/api/monitor-setup", { url: "https://probe2.example.com", email: "not-an-email" });
  ok("C2 invalid email -> uniform ok", s2.status === 200);
  const probe = "red38-pw-" + Date.now() + "@example.org";
  await post("/api/monitor-setup", { url: "https://probe3.example.com", email: probe });
  const login = await post("/api/login", { email: probe, password: "GuessedPassword123!" });
  ok("C3 link-only account: password door refuses (unusable hash)", login.status === 401, "HTTP " + login.status);
}

console.log("═══ D. static guards ═══");
{
  const auth = readFileSync(MONDIR + "src/routes/auth.ts", "utf8");
  ok("D1 next whitelist: only /panel passes", auth.includes("startsWith('/panel')"));
  ok("D1b verify endpoint carries its own burst throttle", auth.includes("login-verify:${ip}"));
  ok("D2 consume is atomic and single-use", auth.includes("UPDATE users SET login_jti = NULL, email_confirmed = 1") && auth.includes("r.meta.changes"));
  const pages = readFileSync(MONDIR + "src/monitor-pages.ts", "utf8");
  ok("D3 token never embedded in HTML (read from URL at click)", !/value="\$\{token\}/.test(pages) && pages.includes("URLSearchParams(location.search).get('token')"));
  ok("D4 mailer gate hides the door without sending", readFileSync(MONDIR + "src/monitor-routes.ts", "utf8").includes("RESEND_API_KEY && env.POSTAL_ADDRESS"));
}

console.log(`\n════════ red38: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
