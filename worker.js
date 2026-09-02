// Rules are data: the JSON source of truth is rules/poisoning.json, compiled
// through the four fail-closed gates below. See docs/superpowers/specs/.
import ruleset from "./rules/poisoning.mjs";

// ToolFront Agent-Readiness Scanner — Cloudflare Worker (hardened)
// Endpoints:
//   GET  /api/scan?domain=example.com   -> heuristic agent-readiness report (JSON)
//   POST /api/waitlist  {email, domain?} -> double opt-in: pending record + confirmation email
//   POST /api/resend    {email}          -> re-send confirmation (max 3/email/24h)
//   GET  /confirm?token=...               -> single-use confirm, idempotent, inline render
//   GET  /unsubscribe?e=..&t=..           -> HMAC-signed unsubscribe, writes suppression record
//   *    /                              -> static assets (landing page)
//
// Security posture (v0.3):
//   - SSRF: hostname must be a public domain (alphabetic TLD — all IP-literal
//     encodings rejected: decimal/octal/hex), then DNS pre-resolved via DoH and
//     every A record checked against private/CGNAT/link-local ranges.
//   - Redirects followed manually, max 3 hops, every hop re-validated (same
//     public-domain + DNS check). Cross-origin redirects to private targets die.
//   - Errors returned to clients are generic; details go to logs only.
//   - Waitlist: same-origin enforced when Origin present, honeypot field,
//     email capped at 254 chars, strict RFC-ish charset, shares the IP rate
//     limit (KV-backed, with a bounded in-memory fallback when KV is absent),
//     per-email cooldown (1h) against mail-bombing via IP rotation, uniform
//     responses (no enumeration), CSPRNG single-use 7-day tokens.
//   - Confirm page: Referrer-Policy no-referrer, zero redirect params,
//     idempotent for invalid/expired/reused tokens.
//   - RESEND_API_KEY: Worker secret ONLY (never wrangler.toml — that file is
//     committed to git). Create with: npx wrangler secret put RESEND_API_KEY
//
// Known residual risks (accepted, documented):
//   - TOCTOU on DNS: A record checked via DoH, fetch re-resolves independently.
//   - Enterprise email scanners (Safe Links/Barracuda) may prefetch the confirm
//     URL — accepted industry-wide risk for low-risk waitlists.
//   - Per-email cooldown has a TOCTOU window: concurrent submissions of the
//     same address (or cross-PoP requests inside KV's ~60s eventual-consistency
//     window) can each mint a token before the wl:cool key propagates. KV has
//     no compare-and-swap, so this cannot be fixed with KV alone; mitigations:
//     the 30 req/min/IP rate limit caps per-attacker volume, KV's per-key
//     1 write/sec errors loudly (500) on bursts, and every confirmation email
//     carries a working unsubscribe link. Measured in round 16 (5 concurrent →
//     5 tokens); accepted as a soft control, same class as the KV rate-limit
//     weakness documented in round 11.

const SCAN_UA = "ToolFront-Scanner/0.3 (+https://toolfront.dev/bot)";
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 300_000;
const CACHE_TTL_S = 86400;
// Rate limit: 30 requests per 60s window per IP, shared across all API
// endpoints. Enforced by the official Rate Limiting binding (per Cloudflare
// location, in-memory counters, zero KV cost) when configured; otherwise by
// the bounded in-memory fallback below. NOTE: the binding's period must be
// 10 or 60 seconds, so this is a per-minute burst limit, not the old 30/hour
// window — long-run abuse is still checked by per-email cooldowns (1h),
// resend caps (3/24h), and the honeypot.
const RATE_LIMIT = 30;
const RATE_LIMIT_PERIOD_MS = 60_000;
const MAX_REDIRECTS = 3;

// Deliberately NO CORS headers (round-18 finding): we have zero cross-origin
// consumers — the SPA calls these endpoints same-origin, and the internal
// scanning client uses a Service Binding (never browser CORS). Emitting
// ACAO:* gave unneeded third-party pages the ability to call the public scan
// API as a free proxy. The same-origin policy now blocks them by default
// (OWASP Secure Headers: "otherwise, omit both headers").

/* ————— rate limiting —————
   Cloudflare's official Rate Limiting binding ([[unsafe.bindings]] in
   wrangler.toml, Workers Paid plan) is the primary limiter: atomic-enough
   local counters, no KV reads/writes, no added latency. KV is deliberately
   NOT used for rate limiting — every KV-based check burns a write against
   a quota an attacker can exhaust (free plan: 1k writes/day ≈ 1,000 requests
   to knock every endpoint into 500s), and KV's ~60s eventual consistency
   makes cross-PoP counters unreliable anyway. When the binding is absent
   (local dev / tests / unbound deployment) we fall back to a bounded
   per-isolate in-memory limiter — weaker (resets on isolate recycle) but
   it never amplifies into a resource-exhaustion DoS. */
const memRL = new Map(); // ip -> { n, reset }
const MEM_RL_MAX = 10000;
let memRLWarned = false; // warn once per isolate — degraded limiter must be loud, not silent

async function rateLimitAllow(ip, env) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return success !== false;
    } catch (_) { /* binding error → fall through to memory */ }
  }
  // Fallback is fail-OPEN (availability-correct per Cloudflare's own docs),
  // but the DEGRADATION must be observable — a silently-weakened limiter is
  // the worst failure mode (you only learn about it after an incident).
  if (!memRLWarned) {
    memRLWarned = true;
    console.warn("rate_limit_fallback_in_memory — RATE_LIMITER binding not configured or errored; limit is per-isolate (weaker). Set [[unsafe.bindings]] in wrangler.toml for production.");
  }
  const now = Date.now();
  let e = memRL.get(ip);
  if (e && e.reset <= now) e = null;
  if (!e) e = { n: 0, reset: now + RATE_LIMIT_PERIOD_MS };
  if (e.n >= RATE_LIMIT) { memRL.set(ip, e); return false; }
  e.n += 1;
  memRL.set(ip, e);
  if (memRL.size > MEM_RL_MAX) {
    for (const [k, v] of memRL) if (v.reset <= now) memRL.delete(k);
    if (memRL.size > MEM_RL_MAX) memRL.delete(memRL.keys().next().value); // evict oldest
  }
  return true;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "X-Content-Type-Options": "nosniff", "Allow": "GET, POST, OPTIONS" } });
    try {
      if (url.pathname === "/api/scan") return await handleScan(url, request, env);
      if (url.pathname === "/api/compare") return await handleCompareApi(url, request, env);
      if (url.pathname === "/api/waitlist") return await handleWaitlist(request, env);
      if (url.pathname === "/api/resend") return await handleResend(request, env);
      if (url.pathname === "/confirm") return await handleConfirm(url, env);
      if (url.pathname === "/unsubscribe") return await handleUnsubscribe(url, request, env);
      if (url.pathname === "/internal/scan") return await handleInternalScan(url, request, env);
    } catch (err) {
      console.log("worker_error", request.method, url.pathname, String(err && err.message || err));
      return json({ error: "internal_error", detail: "Something went wrong on our side. Try again later." }, 500);
    }
    // Standalone report page (/report?domain=...): dedicated V5 page —
    // its own shell (public/report.html), separate from the landing page.
    if (url.pathname === "/report" || url.pathname === "/report/") {
      if (!env.ASSETS) return json({ name: "toolfront", status: "ok" });
      return harden(await env.ASSETS.fetch(new Request(url.origin + "/report.html", request)));
    }
    // Compare page (/compare?a=...&b=...): the URL is the shareable artifact.
    if (url.pathname === "/compare" || url.pathname === "/compare/") {
      if (!env.ASSETS) return json({ name: "toolfront", status: "ok" });
      return harden(await env.ASSETS.fetch(new Request(url.origin + "/compare.html", request)));
    }
    // Agent-skills repair docs live under the standard /.well-known/agent-skills/
    // path (the agentskills discovery convention). Workers static assets skip
    // dot-prefixed directories (.well-known), so the files are stored under
    // /agent-skills/ and re-served here at their canonical well-known URL.
    if (url.pathname.startsWith("/.well-known/agent-skills/")) {
      const rel = url.pathname.slice("/.well-known/agent-skills/".length);
      if (env.ASSETS) return harden(await env.ASSETS.fetch(new Request(url.origin + "/agent-skills/" + rel, request)));
      return json({ error: "not_found" }, 404);
    }
    if (env.ASSETS) return harden(await env.ASSETS.fetch(request));
    return json({ name: "toolfront", status: "ok" });
  },
  async scheduled(event, env, ctx) {
    // No cron on the main worker — scheduled scanning runs in a separate
    // internal worker, which calls /internal/scan via a Service Binding.
  },
};

/* ————— internal scan endpoint (Service Binding callers only) —————
   Invoked by an internal scanning client via a Service Binding to run
   the shared scan engine (single engine in the codebase). Authenticated
   by a shared secret header, NOT reachable usefully from the public
   internet (key required; key is a Worker secret on both sides). */

// Dedicated quota for the internal endpoint: even a leaked key must not
// become an unbounded fetch amplifier. 120 scans/min is far above the cron's
// real load (≤5 per 15 min) but caps damage hard.
const internalRL = new Map();
async function handleInternalScan(url, request, env) {
  const now = Date.now();
  let e = internalRL.get("global");
  if (e && e.reset <= now) e = null;
  if (!e) e = { n: 0, reset: now + 60_000 };
  e.n += 1;
  internalRL.set("global", e);
  if (internalRL.size > 100) internalRL.clear();
  if (e.n > 120) return json({ error: "rate_limited" }, 429);

  const key = request.headers.get("x-internal-key") || "";
  const expected = env.INTERNAL_SCAN_KEY;
  if (!expected || typeof key !== "string") {
    return json({ error: "forbidden" }, 403);
  }
  // Constant-time compare WITHOUT a length early-return (length must not
  // leak through timing either; compare over the longer of the two).
  const n = Math.max(key.length, expected.length);
  let diff = key.length ^ expected.length;
  for (let i = 0; i < n; i++) diff |= (key.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  if (diff !== 0) return json({ error: "forbidden" }, 403);

  const domain = normalizeDomain(url.searchParams.get("domain"));
  if (!domain) return json({ error: "invalid_domain" }, 400);
  const report = await scanDomainCore(domain, env);
  if (!report) return json({ error: "unscannable", detail: "SSRF-blocked, opted-out, unreachable, or refused." }, 502);
  return json(report, 200);
}

/* ————— security headers for our own pages/assets —————
   CSP note: script/style 'unsafe-inline' is required by the single-page
   bundle; everything else is locked to 'self'. External script injection
   (the escalation path of any future HTML bug) dies here. */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";

function harden(res) {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  const ct = h.get("Content-Type") || "";
  if (ct.includes("text/html")) {
    h.set("Content-Security-Policy", CSP);
    h.set("X-Frame-Options", "DENY");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff", // JSON never rendered as HTML even if MIME is confused
      "Cache-Control": "no-store",          // API responses carry no PII-worthy cache; scan overrides via extra
      ...extra, // may override Cache-Control (e.g. scan's public max-age)
    },
  });
}

// Dual-layer body size gate (round-19): Content-Length fast-path rejects
// oversized POSTs at 413 without reading the body; chunked-encoding requests
// (no Content-Length) fall through to the post-read length check — the layer
// an attacker cannot bypass. A 100MB JSON POST must never cost us parse CPU.
const MAX_BODY_BYTES = 4096;
async function readJsonBody(request) {
  const cl = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY_BYTES) return { error: "payload_too_large" };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "payload_too_large" };
  try { return { body: JSON.parse(text) }; } catch (_) { return { error: "bad_json" }; }
}

/* ————— domain validation ————— */

// A registrable domain with an alphabetic TLD. This single rule rejects every
// IP-literal encoding (decimal 1.2.3.4, octal 0177.0.0.1, hex 0x7f.0.0.1,
// integer 2130706433) because none of them ends in an alphabetic TLD.
function normalizeDomain(raw) {
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (d.length > 253) return null;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(d)) return null;
  if (/[.]{2,}/.test(d)) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld)) return null;
  if (labels.some(l => l.length === 0 || l.length > 63)) return null;
  // RFC 1035 §2.3.1: labels must start and end with an alphanumeric — a
  // leading/trailing hyphen is not resolvable and only invites odd input.
  if (labels.some(l => /^-|-$/.test(l))) return null;
  if (d === "localhost" || d.endsWith(".local") || d.endsWith(".internal") || d.endsWith(".localhost")) return null;
  return d;
}

/* ————— DNS pre-check via Cloudflare DoH (SSRF guard) ————— */

const dnsCache = new Map(); // domain -> { ok, expires }

function isPrivateIp(ip) {
  if (typeof ip !== "string" || ip === "") return true;
  if (ip.includes(":")) {
    let v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v.startsWith("::ffff:")) v = v.slice(7); // IPv4-mapped -> recheck as IPv4
    if (v.includes(".")) return isPrivateIp(v);
    if (v === "::1" || v === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true;  // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true;  // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(v)) return true;     // ff00::/8 multicast (OWASP)
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||  // CGNAT 100.64/10
    p[0] >= 224 ||                                   // multicast 224/4 + reserved 240/4 (OWASP)
    (p[0] === 198 && (p[1] === 18 || p[1] === 19))  // benchmark testing 198.18/15
  );
}

const DOH_PROVIDERS = [
  "https://cloudflare-dns.com/dns-query", // same-network in Workers prod
  "https://dns.alidns.com/resolve",       // fallback resolver
];

async function resolveRecords(domain) {
  // OWASP: check both A and AAAA to defeat single-stack rebinding.
  const doh = async (type) => {
    for (const base of DOH_PROVIDERS) {
      try {
        const res = await fetch(base + "?name=" + encodeURIComponent(domain) + "&type=" + type, {
          headers: { "accept": "application/dns-json" },
          signal: AbortSignal.timeout(5000),
        });
        const j = await res.json();
        return (j.Answer || []).filter(a => a.type === (type === "A" ? 1 : 28)).map(a => a.data);
      } catch (_) { /* try next provider */ }
    }
    return null;
  };
  const [a, aaaa] = await Promise.all([doh("A"), doh("AAAA")]);
  if (a === null && aaaa === null) return null; // all resolvers unreachable -> fail closed
  const out = [];
  if (a) out.push(...a);
  if (aaaa) out.push(...aaaa);
  return out;
}

async function dnsAllows(domain) {
  const now = Date.now();
  const c = dnsCache.get(domain);
  if (c && c.expires > now) return c.ok;
  // Memory bound: an attacker sweeping random hostnames through /api/scan
  // (multi-IP) could otherwise grow this Map without limit. 5k entries ×
  // ~100B is a cheap full reset; entries re-populate from real traffic.
  if (dnsCache.size > 5000) dnsCache.clear();
  const ips = await resolveRecords(domain);
  // fail closed: if we cannot verify DNS, we do not fetch
  const ok = ips === null ? false : (ips.length === 0 || ips.every(ip => !isPrivateIp(ip)));
  if (!ok) {
    // Blue-team signal: the hostname is syntactically valid but resolves into
    // private / link-local / cloud-metadata space. That is someone probing the
    // SSRF guard, not a typo. Safe to log because it is expensive to reach —
    // it needs a real DNS answer for a hostname that passes every format check,
    // the per-IP rate limit applies first, and the 60s dnsCache above means a
    // repeated domain cannot re-log. Deliberately no visitor IP: the log stays
    // free of PII (round 19), the resolved target is what matters for triage.
    console.warn("ssrf_guard_blocked", JSON.stringify({ domain, ips: (ips || []).slice(0, 3) }));
  }
  dnsCache.set(domain, { ok, expires: now + 60_000 });
  return ok;
}

/* ————— fetch helper: manual redirects, timeout, size cap ————— */

async function fetchCapped(rawUrl, method = "GET", hop = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl, {
      method,
      signal: ctrl.signal,
      redirect: "manual", // never let fetch follow redirects on its own
      headers: { "User-Agent": SCAN_UA, "Accept": "text/html,text/plain,*/*" },
    });
    const cfMitigated = res.headers.get("cf-mitigated") || null;
    if ([301, 302, 303, 307, 308].includes(res.status) && hop < MAX_REDIRECTS) {
      const loc = res.headers.get("Location");
      if (!loc) return { status: res.status, text: "", cfMitigated };
      let next;
      try { next = new URL(loc, rawUrl); } catch (_) { return { status: 0, text: "", blocked: true, cfMitigated }; }
      if (next.protocol !== "https:" && next.protocol !== "http:") return { status: 0, text: "", blocked: true, cfMitigated };
      const host = next.hostname.toLowerCase();
      if (normalizeDomain(host) !== host || !(await dnsAllows(host))) {
        return { status: 0, text: "", blocked: true, cfMitigated };
      }
      return fetchCapped(next.toString(), method, hop + 1);
    }
    if (res.status >= 300 && res.status < 400) return { status: 0, text: "", blocked: true, cfMitigated }; // redirect chain too long
    if (method === "HEAD") return { status: res.status, text: "", cfMitigated, ctype: (res.headers.get("content-type") || "").toLowerCase() || null, link: res.headers.get("link"), lmod: res.headers.get("last-modified") };
    if (!res.body) return { status: res.status, text: "", cfMitigated, ctype: (res.headers.get("content-type") || "").toLowerCase() || null, link: res.headers.get("link"), lmod: res.headers.get("last-modified") };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done || size >= MAX_BYTES) break;
      chunks.push(value);
      size += value.byteLength;
    }
    try { reader.cancel(); } catch (_) {}
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { const take = Math.min(c.byteLength, size - off); buf.set(c.subarray(0, take), off); off += take; }
    return { status: res.status, text: new TextDecoder().decode(buf), cfMitigated, ctype: (res.headers.get("content-type") || "").toLowerCase() || null, link: res.headers.get("link"), lmod: res.headers.get("last-modified") };
  } catch (err) {
    return { status: 0, text: "", error: String(err && err.name || "fetch_failed") };
  } finally {
    clearTimeout(timer);
  }
}

/* ————— challenge page detection (spec 2026-08-30, techval 23/23) —————
   A target's bot protection (Cloudflare et al.) may answer our probe with an
   interstitial instead of the real resource. Counting that as "fail" scores
   the site's defenses, not its agent-readiness — and hides our best onboarding
   moment. Two detection channels, in priority order:
   1. `cf-mitigated: challenge` — Cloudflare's official marker, set for ALL
      challenge types (cloudflare-docs commit 2c2ae20). Header-only, no body
      needed; we cannot guarantee cross-zone readability, so channel 2 stands
      alone.
   2. Body fingerprints from cloudscraper's detection matrix, gated behind
      status ∈ {403,429,503}: `/cdn-cgi/challenge-platform/`,
      `window._cf_chl_opt`, `window._cf_chl_ctx`, "Just a moment",
      "Attention Required", challenge-form.
   HARD RULE: status 200 can NEVER be a challenge — a blog post discussing
   Cloudflare contains the same strings; only error statuses may trigger the
   body channel. This also blunts score-gaming: a site faking challenge
   markers still surfaces in report.unavailable and the UI warning banner. */
function challengeProbe(status, text, cfMitigated) {
  if (cfMitigated === "challenge") return true; // CF 官方头，最优先
  if (status !== 403 && status !== 429 && status !== 503) return false; // 200 永不判挑战
  if (!text) return false;
  return (
    text.includes("/cdn-cgi/challenge-platform/") ||
    text.includes("window._cf_chl_opt") ||
    text.includes("window._cf_chl_ctx") ||
    text.includes("Just a moment") ||
    text.includes("Attention Required") ||
    text.includes('id="challenge-form"')
  );
}

/* ————— individual checks ————— */

/* WebMCP tool-surface extraction + security checks.
   Detection rules derive from three authoritative sources:
   - Chrome "WebMCP tool security" guide (untrustedContentHint / readOnlyHint /
     exposedTo / character budgets)
   - W3C WebMCP draft §6.3 threat model (tool poisoning, output injection,
     misrepresentation, over-parameterization)
   - mcp-scan / Aegis / WebMCP-Phalanx (zero-width & NFKC obfuscation,
     instruction patterns, encoded blobs, name shadowing) */

/* ── Rule-driven detection (source of truth: rules/poisoning.json) ──────
   Four compile-time gates, all fail-closed — a hostile rules file must throw
   here at startup, never reach production:
     gate 1  type + id whitelist, duplicate-id rejection
     gate 2  flags whitelist (i/u only — stateful g/y leak lastIndex across calls)
     gate 3  executor whitelist over a null-prototype map (`constructor` and
             every other prototype property are unreachable)
     gate 4  static ReDoS heuristics (detection support, not proof — the
             dynamic timing gate in tests/redos-guard.test.mjs is the backstop) */
const ALLOWED_TYPES = new Set(["regex", "length-over", "executor"]);
const ALLOWED_FLAGS = /^[iu]*$/;

const EXECUTORS = Object.create(null);
EXECUTORS.decodeFindings = (() => {
  const INSTRUCTION_RE = /ignore\s+(all\s+)?(previous|prior|above)|disregard\s+(the\s+)?(previous|prior|above)|do\s+not\s+(tell|inform|reveal)|exfiltrat/i;
  // Decode-and-inspect: any encoded blob found in tool text is decoded and
  // checked for instruction patterns. This removes any dependence on length
  // thresholds — a 40-char base64 of "ignore previous instructions" is caught
  // exactly like a 400-char one, while benign encoded-looking words decode to
  // harmless text and stay silent (no false positives).
  return (text) => {
    for (const b64 of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) || []) {
      try {
        const decoded = atob(b64.replace(/=+$/, "") + "===".slice((b64.length + 3) % 4));
        if (INSTRUCTION_RE.test(decoded)) return true;
      } catch (_) { /* not valid base64 */ }
    }
    for (const hex of text.match(/[0-9a-fA-F]{16,}/g) || []) {
      try {
        if (hex.length % 2) continue;
        let decoded = "";
        for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        if (INSTRUCTION_RE.test(decoded)) return true;
      } catch (_) { /* skip */ }
    }
    return false;
  };
})();
const ALLOWED_EXECUTORS = new Set(["decodeFindings"]);

const REDOS_HINTS = [
  { name: "nested quantifier (x+)+", re: /\([^)]*[+*][^)]*\)\s*[+*]/ },
  { name: "adjacent quantifiers a+*", re: /[+*]\s*[+*]/ },
  { name: "repeated group (x{n,})+", re: /\([^)]*\{[^}]*,[^}]*\}[^)]*\)\s*[+*]/ },
  { name: "alternation branch (a|aa)+", re: /\([^)]*\|[^)]*\)\s*[+*]/ },
];

export function compileRules(rules) {
  const seen = new Set();
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") throw new Error("rules: non-object rule");
    if (typeof r.id !== "string" || !/^[a-z0-9-]{3,40}$/.test(r.id))
      throw new Error("rules: bad rule id (expected kebab-case, 3-40 chars)");
    if (seen.has(r.id)) throw new Error(`rules: duplicate rule id "${r.id}"`);
    seen.add(r.id);
    if (!ALLOWED_TYPES.has(r.type)) throw new Error(`rules: unknown rule type "${r.type}"`);
    if (!Number.isInteger(r.severity) || r.severity < 1 || r.severity > 3)
      throw new Error(`rules: "${r.id}" severity must be an integer 1..3`);
    if (r.type === "regex") {
      if (typeof r.pattern !== "string" || !r.pattern) throw new Error(`rules: "${r.id}" regex requires a non-empty pattern`);
      const flags = r.flags || "";
      if (!ALLOWED_FLAGS.test(flags)) throw new Error(`rules: flags "${flags}" not allowed (i/u only)`);
      const hints = REDOS_HINTS.filter(h => h.re.test(r.pattern)).map(h => h.name);
      if (hints.length) throw new Error(`rules: pattern looks ReDoS-prone (${hints.join("; ")})`);
      out.push({ ...r, re: new RegExp(r.pattern, flags) });
    } else if (r.type === "executor") {
      if (typeof r.executor !== "string" || !r.executor) throw new Error(`rules: "${r.id}" executor requires a name`);
      if (!ALLOWED_EXECUTORS.has(r.executor) || typeof EXECUTORS[r.executor] !== "function")
        throw new Error(`rules: executor "${r.executor}" not whitelisted`);
      out.push({ ...r, fn: EXECUTORS[r.executor] });
    } else if (r.type === "length-over") {
      if (!Number.isInteger(r.limit)) throw new Error(`rules: "${r.id}" length-over requires an integer limit`);
      // needs no compilation — but it must still ship.
      out.push({ ...r });
    }
  }
  return out;
}
const COMPILED_RULES = compileRules(ruleset.rules);
const RULES_VERSION = ruleset.version;

function extractWebMcpSurface(html) {
  const surface = { tools: [], platform: null, declarative: 0, imperative: 0 };
  if (/cdn\.shopify\.com\/storefront\/webmcp/i.test(html)) surface.platform = "shopify";
  const declRe = /<script[^>]*type\s*=\s*["']webmcp["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = declRe.exec(html)) !== null) {
    surface.declarative++;
    try {
      const j = JSON.parse(m[1].trim());
      const arr = Array.isArray(j) ? j : (Array.isArray(j.tools) ? j.tools : [j]);
      for (const t of arr) if (t && typeof t === "object") surface.tools.push({ src: "declarative", ...t });
    } catch (_) { /* malformed declarative block — counted, not parsed */ }
  }
  // Imperative: registerTool({...}) — plus the addTool() naming used by early
  // Chrome builds and community polyfills (MCP-B etc). Matching only one API
  // name silently misses a whole family of real-world registrations.
  const impRe = /(?:registerTool|addTool|provideContext)\s*\(\s*\{([\s\S]{0,3000}?)\}\s*(?:,\s*\{([\s\S]{0,600}?)\})?\s*\)/g;
  while ((m = impRe.exec(html)) !== null) {
    surface.imperative++;
    const body = m[1];
    const opts = m[2] || "";
    const name = (body.match(/name\s*:\s*["'`]([^"'`]{1,128})["'`]/) || [])[1];
    // Single anchored match with a backreference: the closing quote must be the
    // same type as the opening one, and the "+" (if any) must directly follow
    // it. A loose lazy-quantifier regex here would run past the value and match
    // an unrelated concatenation later in the call body (false positives).
    const descMatch = body.match(/description\s*:\s*(["'`])([\s\S]{0,2000}?)\1\s*(\+)?/);
    const description = descMatch ? descMatch[2] : undefined;
    const concatenated = descMatch ? !!descMatch[3] : false;
    const exposedTo = (opts.match(/exposedTo\s*:\s*\[([\s\S]{0,300})\]/) || [])[1];
    surface.tools.push({
      src: "imperative", name, description, exposedTo, concatenated,
      readOnlyHint: /readOnlyHint\s*:\s*true/.test(body + opts),
      untrustedContentHint: /untrustedContentHint\s*:\s*true/.test(body + opts),
      raw: body.slice(0, 2000),
    });
  }
  return surface;
}

function toolPoisonFindings(tool) {
  const findings = [];
  for (const rule of COMPILED_RULES) {
    const targets = rule.applies.map(f => tool[f]).filter(v => typeof v === "string" && v.length);
    // Per-target push (no break): mirrors the original per-text semantics —
    // a tool with description AND raw both matching scores both findings.
    for (const text of targets) {
      let hit = false;
      if (rule.type === "regex") hit = rule.re.test(text);
      else if (rule.type === "length-over") hit = text.length > rule.limit;
      else if (rule.type === "executor") hit = rule.fn(text) === true;
      if (hit) findings.push({ code: rule.id, severity: rule.severity });
    }
  }
  return findings;
}

function checkWebMCP(surface) {
  if (surface.tools.length || surface.platform) {
    const src = surface.platform ? `${surface.platform} platform injection` :
      `${surface.tools.length} tool(s) · ${surface.imperative} imperative / ${surface.declarative} declarative`;
    return { status: "pass", ratio: 1, detail: `WebMCP surface detected (${src}). Agents can discover native tools on this page.` };
  }
  return { status: "fail", ratio: 0, detail: "No WebMCP tools registered. Agents must screenshot and click blind — every UI change risks breaking their flow." };
}

function checkToolSecurity(surface) {
  if (!surface.tools.length && !surface.platform) {
    return { status: "na", ratio: 0, detail: "No WebMCP tool surface on this page — the tool-surface security check does not apply." };
  }
  const findings = surface.tools.flatMap(t => toolPoisonFindings(t));
  // Anti-silent-bypass: tools whose description could not be statically
  // extracted (dynamically constructed — variable references, concatenation)
  // are NOT evidence of safety. Absence of a visible description caps the
  // score at partial; "we could not inspect it" must never read as "clean".
  const opaqueTools = surface.tools.filter(t => (typeof t.description !== "string" || !t.description.length) || t.concatenated).length;
  let points = 10;
  for (const f of findings) points -= f.severity * 3;
  // Missing advisory hints (Chrome guide) — minor deductions, floor at 3 when clean otherwise.
  for (const t of surface.tools) {
    if (typeof t.description === "string" && t.description.length) {
      if (!t.readOnlyHint) points -= 1;
      if (!t.untrustedContentHint) points -= 0; // optional per guide; only readOnlyHint is expected broadly
    }
  }
  if (opaqueTools) points = Math.min(points, 7);
  points = Math.max(0, Math.min(10, points));
  if (findings.some(f => f.severity >= 3)) {
    const codes = [...new Set(findings.map(f => f.code))].join(", ");
    return { status: "fail", ratio: 0, detail: `Tool-surface security issues detected (${codes}). Tool descriptions are agent-facing instructions — see W3C WebMCP §6.3 and OWASP ASI02.` };
  }
  if (points < 10 || findings.length) {
    const codes = [...new Set(findings.map(f => f.code))].join(", ");
    const why = opaqueTools && points >= 7 ? `${opaqueTools} tool(s) with statically-invisible descriptions (dynamically constructed) — cannot be audited from a static view` : codes || "missing advisory hints";
    return { status: "partial", ratio: points / 10, detail: `Minor tool-surface findings (${why}). Review hints and budgets per the Chrome WebMCP security guide.` };
  }
  return { status: "pass", ratio: 1, detail: "Tool surface passed static security checks: no poisoning patterns, hints and budgets within guidance." };
}

function checkStructuredData(html) {
  const ldBlocks = (html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/gi) || []).length;
  const hasOgTitle = /<meta[^>]*property\s*=\s*["']og:title["']/i.test(html);
  const hasOgDesc = /<meta[^>]*property\s*=\s*["']og:description["']/i.test(html);
  let points = 0;
  if (ldBlocks >= 3) points = 14; else if (ldBlocks >= 1) points = 10;
  if (hasOgTitle && hasOgDesc) points += 6; else if (hasOgTitle || hasOgDesc) points += 3;
  if (points >= 18) {
    return { status: "pass", ratio: Math.min(1, points / 20), detail: `${ldBlocks} JSON-LD block(s) + OpenGraph tags. Agents can extract facts about this page reliably.` };
  }
  if (points > 0) {
    return { status: "partial", ratio: points / 20, detail: `${ldBlocks} JSON-LD block(s), partial OpenGraph coverage. Agents get fragments, not a full picture.` };
  }
  return { status: "fail", ratio: 0, detail: "No JSON-LD or OpenGraph data. Agents see raw text only." };
}

function checkLlmsTxt(res) {
  if (res.status === 200 && res.text.length > 10) {
    return { status: "pass", ratio: 1, detail: "llms.txt present — you are already speaking to agents in their language." };
  }
  return { status: "fail", ratio: 0, detail: "No /llms.txt. This is the cheapest agent-readiness win available: one markdown file describing your site." };
}

/* ————— paste-ready fix samples (F2: give the user the file, not just steps) —————
   For checks whose fix is a machine-generated file, the report carries a
   `sample` field that the UI renders as a copy-ready block. Nothing here is
   executable — it is static markdown, and any homepage-derived text (title)
   is stripped of markup before it can reach the sample. */
function homeTitleOf(html, domain) {
  const og = html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  if (og) return og[1].trim().slice(0, 120);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return t[1].replace(/\s+/g, " ").trim().slice(0, 120);
  const first = domain.split(".")[0] || domain;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function llmsSampleFor(domain, title) {
  const clean = String(title).replace(/<[^>]*>/g, "").trim().slice(0, 80);
  return (
    `# ${clean}\n\n` +
    `> ${clean}: replace this line with one sentence describing your site to an AI agent.\n\n` +
    `## Start here\n` +
    `- [Homepage](https://${domain}/): the entry point — what you do and who it is for.\n\n` +
    `## Site guide\n` +
    `- [robots.txt](https://${domain}/robots.txt): crawler policy (AI + all).\n` +
    `- [sitemap.xml](https://${domain}/sitemap.xml): every public page, machine-readable.\n`
  );
}

function checkRobotsAI(res) {
  if (res.status !== 200 || !res.text) {
    return { status: "partial", ratio: 0.5, detail: "No robots.txt found. AI crawlers default to allowed — but you have no stated policy." };
  }
  const groups = res.text.split(/(?=user-agent\s*:)/i);
  const AI_BOTS = [
    "GPTBot", "ClaudeBot", "Claude-Web", "CCBot", "Google-Extended",
    "PerplexityBot", "Applebot-Extended", "Bytespider", "OAI-SearchBot",
  ];
  let mentioned = [];
  let blocked = [];
  for (const g of groups) {
    const agentMatch = g.match(/user-agent\s*:\s*([^\n]+)/i);
    if (!agentMatch) continue;
    const agent = agentMatch[1].trim();
    const hit = AI_BOTS.find(b => agent.toLowerCase().includes(b.toLowerCase()));
    if (hit) {
      mentioned.push(hit);
      if (/disallow\s*:\s*\/\s*$/im.test(g) || /disallow\s*:\s*\/\*/im.test(g)) blocked.push(hit);
    }
  }
  if (blocked.length) {
    return { status: "fail", ratio: 0, detail: `robots.txt blocks ${blocked.join(", ")}. Major agents are explicitly turned away at the door.` };
  }
  if (mentioned.length) {
    return { status: "pass", ratio: 1, detail: `Explicit policy for ${mentioned.join(", ")} — allowed. Agents are welcome.` };
  }
  return { status: "partial", ratio: 0.6, detail: "robots.txt exists but names no AI crawlers. Allowed by default — a stated policy is stronger." };
}

function checkMachineSurfaces(sitemapRes, apiRes) {
  const found = [];
  if (sitemapRes.status === 200) found.push("sitemap.xml");
  if (apiRes.status === 200) found.push("openapi.json");
  // Internal scale: sitemap 10 + openapi 15. A "pass" needs both surfaces.
  const ratio = ((sitemapRes.status === 200 ? 10 : 0) + (apiRes.status === 200 ? 15 : 0)) / 25;
  if (ratio >= 0.8) return { status: "pass", ratio, detail: `${found.join(" + ")} found. Your site already exposes machine-readable maps — prime material for tool generation.` };
  if (ratio > 0) return { status: "partial", ratio, detail: `${found.join(" + ")} found. Add an OpenAPI spec and tool generation becomes near-automatic.` };
  return { status: "fail", ratio: 0, detail: "No sitemap.xml or OpenAPI spec detected. Agents have no map of your site." };
}

/* ————— api-errors: unknown API paths must fail in a machine-readable way —————
   Agents call APIs programmatically and cannot recover from an HTML error
   page. A JSON problem-details body (RFC 9457) lets them branch on failures
   instead of guessing. Probe: one request to a random /api path that cannot
   exist, so we measure the site's REAL error shape, not a cached page. */
function checkApiErrors(probe) {
  if (!probe || probe.status === 0) return { status: "na", ratio: 0, detail: "Probe unreachable — could not verify the API error shape." };
  if (probe.blocked || probe.cfMitigated) return { status: "na", ratio: 0, detail: NA_DETAIL };
  if (probe.status >= 400 && probe.status < 500) {
    if (probe.ctype && probe.ctype.includes("json")) {
      return { status: "pass", ratio: 1, detail: "Unknown API paths return machine-readable JSON errors — agents can recover from failures." };
    }
    return { status: "fail", ratio: 0, detail: "API errors return " + (probe.ctype || "no content-type") + " — agents cannot parse an HTML error page. Return application/problem+json instead." };
  }
  return { status: "partial", ratio: 0.5, detail: "Unknown API path returned HTTP " + probe.status + " instead of a structured 4xx error." };
}

/* ————— freshness: can agents tell how recent the content is? —————
   AI systems prefer recent content and several engines surface newer pages
   more often. Signals, best first: JSON-LD dateModified, OG
   article:modified_time, a Last-Modified response header; published-only
   signals (article:published_time, <time datetime>) count as partial. */
function checkFreshness(home) {
  const text = (home && home.text) || "";
  if (/dateModified|article:modified_time/i.test(text) || (home && home.lmod)) {
    return { status: "pass", ratio: 1, detail: "Content freshness signals found (dateModified / article:modified_time / Last-Modified)." };
  }
  if (/article:published_time|<time[^>]+datetime/i.test(text)) {
    return { status: "partial", ratio: 0.5, detail: "A publish date exists but no last-updated signal — agents cannot tell if the content is current." };
  }
  return { status: "fail", ratio: 0, detail: "No freshness signals — AI systems cannot determine when this content was last updated." };
}

/* ————— link-headers: RFC 8288 Link header as request-time discovery —————
   Link response headers let agents discover machine-readable resources
   without parsing HTML. Scanners (including ours) look for api-catalog,
   service-desc, service-doc, and sitemap rels. Zero extra requests: the
   header rides along on the homepage probe. */
function checkLinkHeaders(home) {
  const link = home && home.link;
  if (!link) return { status: "fail", ratio: 0, detail: "No Link response header — agents must parse HTML to discover machine-readable resources. Advertise sitemap and OpenAPI via Link." };
  if (/api-catalog|service-desc|service-doc|sitemap/i.test(link)) {
    return { status: "pass", ratio: 1, detail: "Link response header advertises agent-relevant relations." };
  }
  return { status: "partial", ratio: 0.5, detail: "Link header present but carries no agent-relevant rel (api-catalog / service-desc / sitemap)." };
}

// Paste-ready samples for the fix cards (same pattern as llmsSampleFor).
function apiErrorsSample() {
  return JSON.stringify({
    type: "https://example.com/problems/not-found",
    title: "Not found",
    status: 404,
    detail: "No such resource",
    instance: "/api/v1/missing",
  }, null, 2);
}
function freshnessSample() {
  return `<!-- Option 1: JSON-LD (preferred) -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Your Article Title",
  "datePublished": "2026-01-15T09:00:00Z",
  "dateModified": "2026-02-28T14:30:00Z"
}
</script>

<!-- Option 2: Open Graph meta tags -->
<meta property="article:published_time" content="2026-01-15T09:00:00Z">
<meta property="article:modified_time" content="2026-02-28T14:30:00Z">

<!-- Server-level: ensure Last-Modified is sent -->
# Nginx
add_header Last-Modified $date_gmt;`;
}
function linkHeadersSample() {
  return `# Nginx
add_header Link '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc", </sitemap.xml>; rel="sitemap"' always;

# Test
curl -I https://yourdomain.com/ | grep -i '^link:'`;
}

/* ————— scanner opt-out: respect robots.txt targeting our own UA —————
   Our scanner is a good citizen: if a site explicitly disallows
   "ToolFront-Scanner" in its robots.txt, we do not scan it. (Wildcard
   `User-agent: *` groups are NOT treated as opt-out — the tool is a
   one-shot readiness probe of 5 public files, not a crawler, and treating
   wildcards as opt-out would make almost every site unscannable.) */

function robotsOptedOut(robotsText) {
  if (!robotsText) return false;
  const groups = robotsText.split(/(?=user-agent\s*:)/i);
  for (const g of groups) {
    const agents = [...g.matchAll(/user-agent\s*:\s*([^\n]+)/gi)].map(m => m[1].trim().toLowerCase());
    if (!agents.some(a => a.includes("toolfront-scanner"))) continue;
    // This group targets our scanner — any blanket Disallow means opt-out.
    if (/^\s*disallow\s*:\s*\/(\*|\s*)$/im.test(g)) return true;
  }
  return false;
}

/* ————— scan orchestration ————— */

// Checks that probe SUB-RESOURCES (anything besides the homepage HTML). Each
// can independently hit a bot-protection wall; when that happens the check
// reports `na` (unavailable) instead of `fail` — excluded from score AND
// denominator, and surfaced in report.unavailable + the UI warning banner.
const NA_DETAIL = "Blocked by the site's bot protection — could not verify this surface. Note: the same wall stops AI agents, not just our scanner.";
const SUB_CHECKS = [
  { id: "llms-txt", label: "llms.txt", path: "/llms.txt", res: "llms" },
  { id: "robots-policy", label: "AI crawler policy", path: "/robots.txt", res: "robots" },
  { id: "machine-surfaces", label: "Machine-readable surfaces", path: "/sitemap.xml + /openapi.json", res: "machine" },
  { id: "api-errors", label: "API error responses", path: "/api/tf-probe (random)", res: "api" },
];

/* ————— Scoring policy: the single source of truth ————————————————
   A report reader sees three signals per fix: how urgent it is (tier),
   how many points it is worth (max), and how much we trust the evidence
   (grade). Historically these were defined in two places — the weights
   here in worker.js and the tier/grade in report.html — so they drifted
   apart: the "interpretation" tier was worth MORE total points than the
   "blocking" tier, and the single highest-value item sat in the middle
   tier. Three signals, three different answers to "what do I fix first".

   Fix: tier and evidence live here, and the weight is DERIVED from the
   tier budget below rather than hand-set per check. Grouping, badge, and
   score can no longer disagree. The frontend reads tier/evidence off the
   API response, so there is nothing left to duplicate.

   Bumping SCORING_VERSION tells monitoring clients that historical scores
   are not comparable — see the re-baseline guard in monitor-cron.ts. */
const SCORING_VERSION = "2.1.0";
const TIER_BUDGET = { blocking: 55, interpretation: 35, enrichment: 10 };
const CHECK_POLICY = {
  // tier = blast radius when this fails; evidence = how sure we are that
  // agents actually consume the signal; share = split of the tier budget.
  "robots-policy": { label: "AI crawler policy", tier: "blocking", evidence: "A", share: 0.35 },
  webmcp: { label: "WebMCP tools", tier: "blocking", evidence: "A", share: 0.35 },
  "tool-security": { label: "Tool surface security", tier: "blocking", evidence: "A", share: 0.15 },
  "api-errors": { label: "API error responses", tier: "blocking", evidence: "B", share: 0.15 },
  "machine-surfaces": { label: "Machine-readable surfaces", tier: "interpretation", evidence: "B", share: 0.40 },
  "structured-data": { label: "Structured data", tier: "interpretation", evidence: "B", share: 0.35 },
  freshness: { label: "Content freshness", tier: "interpretation", evidence: "B", share: 0.25 },
  "llms-txt": { label: "llms.txt", tier: "enrichment", evidence: "C", share: 0.60 },
  "link-headers": { label: "Link response headers", tier: "enrichment", evidence: "C", share: 0.40 },
};
/** Resolve one check's scoring policy into the shape the report needs. */
function policyOf(id) {
  const p = CHECK_POLICY[id];
  return { id, label: p.label, tier: p.tier, evidence: p.evidence, max: Math.round(TIER_BUDGET[p.tier] * p.share) };
}

// Shared scan core: used by BOTH the free HTTP scan (handleScan) and the
// scheduled scanning clients — exactly one engine in the codebase.
// Returns the full report, or null when the domain must be skipped
// (SSRF-blocked / opted-out / unreachable / target refused).
// A report with blocked:true means the homepage itself was served a bot
// challenge: no score is produced (grade null) and nothing can be gamed.
/* ————— self-scan: our own domain is read from the published assets —————
   A Cloudflare Worker cannot fetch its own zone: the request never leaves the
   edge and comes back as 522, so scanning toolfront.dev would always report
   "unreachable". For that one domain we read the published assets directly and
   run the IDENTICAL checks — and we LABEL the result (self: true) so nobody
   mistakes it for a live network scan.

   Honesty caveat: if a Cloudflare-level feature ever rewrites a response (for
   example content-signals replacing /robots.txt), the asset-based result could
   diverge from what the public receives. That is exactly why the result is
   labelled and why tests/dogfood.test.mjs re-scores public/ from disk. */
const OWN_DOMAIN = "toolfront.dev";

async function probePath(env, domain, path, method) {
  if (domain === OWN_DOMAIN && env.ASSETS) {
    // Assets are read in-process: no method negotiation, and the checks only
    // need the status plus a capped text sample.
    try {
      const res = await env.ASSETS.fetch(new Request("https://" + OWN_DOMAIN + path));
      const text = (await res.text()).slice(0, MAX_BYTES);
      return { status: res.status, text, blocked: false, cfMitigated: false, ctype: (res.headers.get("content-type") || "").toLowerCase() || null, link: res.headers.get("link"), lmod: res.headers.get("last-modified") };
    } catch (_) {
      return { status: 0, text: "", blocked: false, cfMitigated: false, ctype: null, link: null, lmod: null };
    }
  }
  // Third-party domains keep the original HEAD-first behaviour: cheaper, and it
  // is what makes the 405/501 → GET fallback below meaningful.
  return fetchCapped("https://" + domain + path, method);
}

async function scanDomainCore(domain, env) {
  // Our own domain is served from the published assets (see probePath): no
  // network round-trip, so the DNS/SSRF gate does not apply to it.
  const selfScan = domain === OWN_DOMAIN && !!env.ASSETS;

  // SSRF gate: resolve before we fetch.
  if (!selfScan && !(await dnsAllows(domain))) {
    return null;
  }

  // Opt-out gate: fetch robots.txt first and honor an explicit scanner ban.
  const robots = await probePath(env, domain, "/robots.txt");
  if (robotsOptedOut(robots.text)) {
    return null;
  }

  const [home, llms, sitemap, openapi, apiProbe] = await Promise.all([
    probePath(env, domain, "/"),
    probePath(env, domain, "/llms.txt"),
    probePath(env, domain, "/sitemap.xml", "HEAD"),
    probePath(env, domain, "/openapi.json", "HEAD"),
    // Random path that cannot exist: measures the site's real API error shape.
    probePath(env, domain, "/api/tf-probe-" + Date.now()),
  ]);

  // Some servers reject HEAD outright (405/501) while serving GET fine —
  // retry once with GET (capped at MAX_BYTES) before believing the 404.
  let sitemapRes = sitemap, openapiRes = openapi;
  if (sitemapRes.status === 405 || sitemapRes.status === 501) {
    sitemapRes = await probePath(env, domain, "/sitemap.xml");
  }
  if (openapiRes.status === 405 || openapiRes.status === 501) {
    openapiRes = await probePath(env, domain, "/openapi.json");
  }

  if (home.blocked) return null;
  if (home.status === 0) return null;

  // Homepage itself behind a challenge wall → honest "blocked" report.
  // Verdict is a fixed string; no target-controlled content is echoed (injection safety).
  if (challengeProbe(home.status, home.text, home.cfMitigated)) {
    return {
      domain, blocked: true, grade: null, score: null, scoreMax: 0,
      checks: SUB_CHECKS.map(c => ({ ...policyOf(c.id), status: "na", points: null, detail: NA_DETAIL })),
      unavailable: SUB_CHECKS.map(c => c.id),
      warning: "Scan blocked: the site's bot protection challenged our scanner before the homepage loaded. The same wall typically stops AI agents.",
      verdict: "Scan blocked by bot protection. AI agents likely hit the same wall — consider allowing verified automated readers.",
      scannedAt: new Date().toISOString(), cached: false,
    };
  }

  // Non-challenge refusals / outages — back off, cache nothing.
  if (home.status === 403 || home.status === 429 || home.status >= 500) {
    // Ops signal: what did the target's edge actually serve us? Catches the
    // "error page scored as a report" class of bugs (the old 5/F artifact was
    // exactly this: a 522/530 CF error body scored 5/F). No visitor PII.
    console.warn("scan_home_refused", JSON.stringify({ domain, status: home.status, cfMitigated: home.cfMitigated, len: home.text.length, head: home.text.slice(0, 160) }));
    return null;
  }

  // Sub-resource challenge detection → na (not fail).
  const ch = {
    llms: challengeProbe(llms.status, llms.text, llms.cfMitigated),
    robots: challengeProbe(robots.status, robots.text, robots.cfMitigated),
    machine: challengeProbe(sitemapRes.status, sitemapRes.text, sitemapRes.cfMitigated) || challengeProbe(openapiRes.status, openapiRes.text, openapiRes.cfMitigated),
    api: challengeProbe(apiProbe.status, apiProbe.text, apiProbe.cfMitigated),
  };
  const na = (id) => ({ ...policyOf(id), status: "na", points: null, detail: NA_DETAIL });
  // Merge a check result (ratio 0..1) with its policy (max from tier budget):
  // the function answers "how well did the site do", the policy answers
  // "how much is that worth". Neither can drift from the other.
  const scoreCheck = (id, result) => {
    const p = policyOf(id);
    return { ...p, status: result.status, points: result.status === "na" ? null : Math.round(result.ratio * p.max), detail: result.detail };
  };

  const surface = extractWebMcpSurface(home.text);
  const withSample = (c, sample) => {
    if (c.status === "fail" || c.status === "partial") c.sample = sample;
    return c;
  };
  const checks = [
    scoreCheck("webmcp", checkWebMCP(surface)),
    scoreCheck("tool-security", checkToolSecurity(surface)),
    scoreCheck("structured-data", checkStructuredData(home.text)),
    (() => {
      // llms.txt fix is a generated file — attach a paste-ready sample so the
      // fix card can hand the user the answer, not just a guide link.
      const c = ch.llms ? na("llms-txt") : scoreCheck("llms-txt", checkLlmsTxt(llms));
      if (!ch.llms && (c.status === "fail" || c.status === "partial")) c.sample = llmsSampleFor(domain, homeTitleOf(home.text, domain));
      return c;
    })(),
    ch.robots ? na("robots-policy") : scoreCheck("robots-policy", checkRobotsAI(robots)),
    ch.machine ? na("machine-surfaces") : scoreCheck("machine-surfaces", checkMachineSurfaces(sitemapRes, openapiRes)),
    // Self-scan honest limitation: the asset server cannot exercise the
    // worker's route fallback, so this layer is not observable from here.
    selfScan
      ? { ...policyOf("api-errors"), status: "na", points: null, detail: "Self-scan: API error behavior is served by the worker, not the asset server — not observable from published assets." }
      : ch.api ? na("api-errors") : withSample(scoreCheck("api-errors", checkApiErrors(apiProbe)), apiErrorsSample()),
    withSample(scoreCheck("freshness", checkFreshness(home)), freshnessSample()),
    withSample(scoreCheck("link-headers", checkLinkHeaders(home)), linkHeadersSample()),
  ];

  // na items (points === null) count toward neither score nor denominator —
  // an un-scannable surface must not drag the grade down. Only bot-protection
  // blocks (NA_DETAIL) land in report.unavailable + the UI warning banner;
  // other na reasons (e.g. the self-scan api-errors layer gap) stay visible
  // as na pills without claiming "bot protection stopped us".
  let score = 0, scoreMax = 0;
  const unavailable = [];
  for (const c of checks) {
    if (c.points === null) { if (c.detail === NA_DETAIL) unavailable.push(c.id); continue; }
    score += c.points; scoreMax += c.max;
  }
  const pct = scoreMax > 0 ? Math.round((score / scoreMax) * 100) : 0;
  const grade = pct >= 85 ? "A" : pct >= 70 ? "B" : pct >= 50 ? "C" : pct >= 30 ? "D" : "F";
  const verdict =
    pct >= 70 ? "Agent-ready. Agents can work with this site deliberately." :
    pct >= 40 ? "Partially readable. Agents guess some of the time, fail the rest." :
                  "Opaque to agents. Every interaction is a screenshot-and-click gamble.";

  // tool_surface_hash enables rug-pull detection in scheduled-scan diffs; report_json
  // is the durable snapshot stored in D1 scan_reports by the cron.
  const tool_surface_hash = await sha256Hex(JSON.stringify(surface.tools));
  const report = { domain, score, scoreMax, grade, verdict, checks, tool_surface_hash, rules_version: RULES_VERSION, scoring_version: SCORING_VERSION, scannedAt: new Date().toISOString(), cached: false };
  // Provenance: a self-scan never touched the network.
  if (selfScan) report.self = true;
  if (unavailable.length) report.unavailable = unavailable;
  // Store the tool surface body alongside its hash. A hash can only say that
  // the surface changed; the body lets the scheduled-scan diff say WHICH tool
  // changed and whether it was a removal, a rewritten description, or a
  // flipped safety annotation — that difference is what makes an alert
  // actionable instead of a puzzle. `raw` is dropped: it is up to 2KB of page
  // body per tool, which would bloat every D1 row for no extra diff signal.
  if (surface.tools.length) report.tools = surface.tools.map(({ raw, ...rest }) => rest);
  report.report_json = JSON.stringify(report);
  return report;
}

// Shared scan-to-JSON pipeline used by BOTH /api/scan (one domain) and
// /api/compare (two domains): KV cache read, scan, blocked handling, public
// projection (report_json / tool_surface_hash stripped), cache write.
// Rate limiting stays with the HTTP caller (a compare request scans twice
// but counts once against the caller's budget).
async function scanPublicReport(domain, forceFresh, env) {
  if (env.KV && !forceFresh) {
    const cached = await env.KV.get("scan:" + domain, "json");
    if (cached) return { status: 200, body: { ...cached, cached: true }, cacheControl: "public, max-age=60" };
  }

  const report = await scanDomainCore(domain, env);
  if (!report) {
    // Re-derive WHY cheaply for the HTTP caller (cron callers just skip).
    if (!(await dnsAllows(domain))) {
      return { status: 403, body: { error: "domain_not_allowed", detail: "This domain does not resolve to a public address." } };
    }
    const robots = await fetchCapped("https://" + domain + "/robots.txt");
    if (robotsOptedOut(robots.text)) {
      return { status: 403, body: { error: "domain_opted_out", domain, detail: "This site's robots.txt explicitly disallows ToolFront-Scanner. The scan was not performed." } };
    }
    return { status: 502, body: { error: "unreachable", domain, detail: "Could not scan this site (unreachable, or the target refused our scanner)." } };
  }

  // Blocked report (homepage served a bot challenge): still a valid, honest
  // answer — HTTP 200 with grade:null. Short cache TTL (30min): site owners
  // fixing their WAF config must not stay stuck behind a 24h cached verdict.
  if (report.blocked) {
    const { report_json, tool_surface_hash, ...publicBlocked } = report;
    if (env.KV) { try { await env.KV.put("scan:" + domain, JSON.stringify(publicBlocked), { expirationTtl: 1800 }); } catch (_) {} }
    return { status: 200, body: publicBlocked, cacheControl: "public, max-age=300" };
  }

  // Cache write is best-effort: a KV failure (quota/error) must not 500 an
  // otherwise successful scan — the report is valid without the cache entry.
  // The public response (and the cache entry) EXCLUDES report_json — that
  // field is the internal durable snapshot for scheduled scanning clients,
  // never part of the public contract (round-17 finding: it leaked a
  // redundant ~1KB internal blob in every public response).
  // Public contract = UI-rendered fields only. report_json (round 17) and
  // tool_surface_hash (round 31) are internal: the hash exists for the monitor's
  // rug-pull diffs and ships via /internal/scan — the public UI never renders it.
  const { report_json, tool_surface_hash, ...publicReport } = report;
  // Cache write: short TTL (300s) so data stays fresh.
  // Blocked reports use shorter TTL (1800s) above since WAF state is sticky.
  if (env.KV) { try { await env.KV.put("scan:" + domain, JSON.stringify(publicReport), { expirationTtl: 300 }); } catch (_) {} }
  return { status: 200, body: publicReport, cacheControl: "public, max-age=60" };
}

async function handleScan(url, request, env) {
  const domain = normalizeDomain(url.searchParams.get("domain"));
  if (!domain) return json({ error: "invalid_domain", detail: "Provide a public domain like example.com" }, 400);

  // Rate limit FIRST — prevent abuse.
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (!(await rateLimitAllow(ip, env))) {
    return json({ error: "rate_limited", detail: "Too many scans. Try again later." }, 429);
  }

  const r = await scanPublicReport(domain, url.searchParams.get("fresh") === "1", env);
  return json(r.body, r.status, r.cacheControl ? { "Cache-Control": r.cacheControl } : undefined);
}

/* ————— compare: two domains side by side (spec 2026-09-03 F4) —————
   The URL itself is the shareable artifact ("my site vs theirs"). Both sides
   reuse the single-scan cache, so a compare after a recent scan costs one
   network scan at most. A side that failed to scan does not sink the other:
   each side carries its own HTTP status and the page renders the failure
   honestly (a blocked/unreachable card instead of a score). */
async function handleCompareApi(url, request, env) {
  const a = normalizeDomain(url.searchParams.get("a"));
  const b = normalizeDomain(url.searchParams.get("b"));
  if (!a || !b) return json({ error: "invalid_domain", detail: "Provide two domains: /api/compare?a=x.com&b=y.com" }, 400);
  if (a === b) return json({ error: "same_domain", detail: "Pick two different domains to compare." }, 400);

  // One caller budget for both scans — a compare is one user action.
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (!(await rateLimitAllow(ip, env))) {
    return json({ error: "rate_limited", detail: "Too many scans. Try again later." }, 429);
  }

  const fresh = url.searchParams.get("fresh") === "1";
  const [ra, rb] = await Promise.all([scanPublicReport(a, fresh, env), scanPublicReport(b, fresh, env)]);
  return json({ a: ra.body, b: rb.body, a_status: ra.status, b_status: rb.status }, 200, { "Cache-Control": "public, max-age=60" });
}

/* ————— unsubscribe infrastructure (CAN-SPAM / CASL / GDPR Art.7) —————
   Stateful-light design: the unsubscribe link is HMAC-signed and stateless
   (no token storage needed), while the *suppression record* is stored as
   sha256(email) + timestamp — exactly what the privacy policy promises.
   UNSUB_SECRET is a Worker secret; falls back to RESEND_API_KEY if unset. */

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s) {
  const sig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64urlEncode(s) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
}

async function unsubToken(env, email) {
  // Dedicated key ONLY (OWASP: one key, one purpose). A leaked RESEND_API_KEY
  // must never let an attacker forge unsubscribe links, so we do NOT fall back
  // to it. Missing UNSUB_SECRET fails closed — no link is generated and email
  // sending is blocked in sendConfirmationEmail (CAN-SPAM requires a working
  // opt-out on every email; an email without a valid opt-out is not shipped).
  const key = env.UNSUB_SECRET;
  if (!key) return null;
  return hmacHex(key, "toolfront-unsub:v1:" + email);
}

function unsubUrl(env, email, token) {
  const base = (env.PUBLIC_BASE_URL || "https://toolfront.dev").replace(/\/$/, "");
  return base + "/unsubscribe?e=" + encodeURIComponent(b64urlEncode(email)) + "&t=" + token;
}

// GDPR Art.5(1)(e) storage limitation: the suppression record expires exactly
// 365 days after the unsubscribe — matching the privacy policy's stated 12-month
// retention. Deliberately NO refresh-on-read: the retention clock starts at the
// unsubscribe event, not at "last time someone probed the address" (an attacker
// hammering /api/waitlist must not be able to extend the record's lifetime).
async function isSuppressed(env, email) {
  if (!env.KV || !email) return false;
  const key = "wl:suppressed:" + (await sha256Hex(email));
  const rec = await env.KV.get(key, "json");
  return !!rec;
}

// Constant-time compare for the HMAC token.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ————— unsubscribe endpoint: GET/POST /unsubscribe?e=<b64url email>&t=<hmac> —————
   Idempotent: valid-but-already-unsubscribed and already-expired all render the
   same calm page. Uniform page for bad signatures too (no oracle). */

async function handleUnsubscribe(url, request, env) {
  const html = (ok) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>ToolFront — ${ok ? "Unsubscribed" : "Link invalid"}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F8FAFC;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{max-width:460px;padding:48px;text-align:center}h1{font-size:24px;margin:0 0 12px}.r{color:#DC2626}
p{color:#475569;line-height:1.6;margin:0 0 16px}a{color:#1D4ED8}</style></head>
<body><div class="c">
${ok ? `<h1>You're unsubscribed<span class="r">.</span></h1><p>You will not receive any further email from ToolFront. We keep only a minimal suppression record (a one-way hash of your address + the timestamp) so we can honor your choice.</p><p><a href="/">Back to toolfront.dev</a></p>`
      : `<h1>This link is not valid<span class="r">.</span></h1><p>If you want to unsubscribe, reply to any email you received from us, or contact privacy@toolfront.dev and we will remove you within 30 days.</p><p><a href="/">Back to toolfront.dev</a></p>`}
</div></body></html>`;
  const hdr = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP };

  // Shared IP rate limit (uniform page, no oracle) — this endpoint computes an
  // HMAC + touches KV per call, so it must not be an unbounded work amplifier.
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (!(await rateLimitAllow(ip, env))) return new Response(html(false), { status: 200, headers: hdr });

  const eRaw = url.searchParams.get("e") || "";
  const t = url.searchParams.get("t") || "";
  let email = "";
  try { email = b64urlDecode(decodeURIComponent(eRaw)).trim().toLowerCase(); } catch (_) { /* fallthrough */ }
  if (!/^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email) || !/^[0-9a-f]{64}$/.test(t)) {
    return new Response(html(false), { status: 200, headers: hdr });
  }
  const expected = await unsubToken(env, email);
  if (!expected || !safeEqual(expected, t)) return new Response(html(false), { status: 200, headers: hdr });

  if (env.KV) {
    // Idempotent suppression write (uniform whether or not they were subscribed).
    const key = "wl:suppressed:" + (await sha256Hex(email));
    const existing = await env.KV.get(key, "json");
    await env.KV.put(key, JSON.stringify(existing || { unsubscribedTs: new Date().toISOString() }), { expirationTtl: 365 * 86400 });
    // Best-effort cleanup of any live subscription/pending records.
    await env.KV.delete("wl:" + email);
    await env.KV.delete("wl:pending:" + email);
    await env.KV.delete("wl:cool:" + email);
    await env.KV.delete("wl:rs:" + email);
  }
  console.log("unsubscribe_ok");
  return new Response(html(true), { status: 200, headers: hdr });
}

/* ————— waitlist ————— */

async function handleWaitlist(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Same-origin enforcement when the browser provides Origin.
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const ownHost = request.headers.get("Host") || new URL(request.url).host;
      if (originHost && originHost.toLowerCase() !== ownHost.toLowerCase()) {
        return json({ error: "forbidden" }, 403);
      }
    } catch (_) {
      return json({ error: "forbidden" }, 403);
    }
  }

  const parsed = await readJsonBody(request);
  if (parsed.error === "payload_too_large") return json({ error: "payload_too_large" }, 413);
  if (parsed.error === "bad_json") return json({ error: "bad_json" }, 400);
  const body = parsed.body;

  // Honeypot: bots that fill the hidden field get a fake success.
  if (body && (body.name || body.company)) return json({ ok: true, stored: false });

  const email = String((body && body.email) || "").trim().toLowerCase();
  // Strict RFC-ish charset: blocks control chars/NUL/HTML metacharacters from
  // reaching KV keys or the mail provider. A waitlist needs no exotic addresses.
  if (!/^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email) || email.length > 254) {
    return json({ error: "invalid_email" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (!(await rateLimitAllow(ip, env))) return json({ error: "rate_limited" }, 429);

  // Honor prior unsubscribe choices — uniform response, nothing stored or sent.
  if (await isSuppressed(env, email)) return json({ ok: true });

  if (env.KV) {
    // Per-email cooldown (1h): one confirmation email max, regardless of IP rotation.
    const coolKey = "wl:cool:" + email;
    const cooled = await env.KV.get(coolKey);
    if (cooled) return json({ ok: true }); // uniform response; no re-send
    await env.KV.put(coolKey, "1", { expirationTtl: 3600 });

    // Double opt-in: CSPRNG token (crypto.randomUUID = 122-bit entropy), single-use,
    // 7-day TTL (industry standard), pending record never joins the active list.
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const pending = { email, domain: normalizeDomain(body.domain) || null, ip, lang: body.lang === "zh" ? "zh" : "en", signupTs: new Date().toISOString() };
    await env.KV.put("wl:token:" + token, JSON.stringify(pending), { expirationTtl: 7 * 86400 });
    await env.KV.put("wl:pending:" + email, JSON.stringify({ token, ts: pending.signupTs }), { expirationTtl: 7 * 86400 });

    if (env.RESEND_API_KEY) {
      const sent = await sendConfirmationEmail(env, email, token, pending.domain, pending.lang);
      if (!sent) {
        // Roll the submission back entirely (round-29 finding): no email was
        // delivered, so keeping the pending record would (a) store data the user
        // believes was rejected — GDPR storage limitation / data minimisation,
        // and (b) leave the 1h per-email cooldown in place, which turned every
        // retry into a uniform 200 that sends nothing: the user thinks they are
        // subscribed and never receives a confirmation. Clearing the cooldown
        // lets them retry immediately; abuse stays bounded by the 30 req/min
        // IP rate limit and by the cost of a failed provider call each time.
        await env.KV.delete("wl:token:" + token).catch(() => {});
        await env.KV.delete("wl:pending:" + email).catch(() => {});
        await env.KV.delete(coolKey).catch(() => {});
        // Uniform response: never reveal WHY the send failed — distinguishing
        // "undeliverable address" from "provider down" would be an oracle for
        // probing which addresses are deliverable.
        return json({ ok: false, stored: false }, 400);
      }
    } else {
      console.log("RESEND_API_KEY not set — pending stored without sending email (dev mode)");
    }
  }
  return json({ ok: true, stored: !!env.KV });
}

/* ————— resend confirmation (max 3 per email per 24h) ————— */

async function handleResend(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      const ownHost = request.headers.get("Host") || new URL(request.url).host;
      if (new URL(origin).host.toLowerCase() !== ownHost.toLowerCase()) return json({ error: "forbidden" }, 403);
    } catch (_) { return json({ error: "forbidden" }, 403); }
  }
  const parsed = await readJsonBody(request);
  if (parsed.error === "payload_too_large") return json({ error: "payload_too_large" }, 413);
  if (parsed.error === "bad_json") return json({ error: "bad_json" }, 400);
  const body = parsed.body;
  const email = String((body && body.email) || "").trim().toLowerCase();
  // Strict RFC-ish charset: blocks control chars/NUL/HTML metacharacters from
  // reaching KV keys or the mail provider. A waitlist needs no exotic addresses.
  if (!/^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email) || email.length > 254) {
    return json({ error: "invalid_email" }, 400);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (!(await rateLimitAllow(ip, env))) return json({ ok: true }); // silent, uniform
  if (await isSuppressed(env, email)) return json({ ok: true }); // silent, uniform
  if (env.KV) {
    const rsKey = "wl:rs:" + email;
    const n = parseInt((await env.KV.get(rsKey)) || "0", 10);
    if (n >= 3) return json({ ok: true }); // silent cap, uniform response
    await env.KV.put(rsKey, String(n + 1), { expirationTtl: 86400 });
    const pendingRec = await env.KV.get("wl:pending:" + email, "json");
    // Uniform response either way — never reveal whether the email is on the list.
    if (pendingRec && pendingRec.token && env.RESEND_API_KEY) {
      await sendConfirmationEmail(env, email, pendingRec.token, null);
    }
  }
  return json({ ok: true });
}

/* ————— confirm (GET /confirm?token=...) —————
   Idempotent: invalid/expired/already-used all render the same calm page.
   Zero redirect params; result rendered inline. Referrer blocked via meta tag. */

async function handleConfirm(url, env) {
  const token = url.searchParams.get("token") || "";
  // One language, chosen at signup time: an English signup confirms in English,
  // a Chinese signup in Chinese. The other language stays one click away.
  const html = (ok, lang) => {
    const L = lang === "zh" ? "zh" : "en";
    const zh = L === "zh";
    const copy = zh
      ? { title: "订阅成功", h1: "订阅成功", p1: "我们会在智能体工具发布时发邮件通知你。", exp: "链接已失效", expP: "确认链接为一次性使用，7 天后过期。请到 toolfront.dev 重新订阅。", home: "返回 toolfront.dev", alt: "English", altHref: "/?lang=en" }
      : { title: "Subscription confirmed", h1: "You're on the list", p1: "We'll email you when the agent-readiness tools launch.", exp: "This link has expired", expP: "Confirmation links are single-use and expire after 7 days. Please sign up again at toolfront.dev.", home: "Back to toolfront.dev", alt: "中文", altHref: "/?lang=zh" };
    return `<!DOCTYPE html>
<html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>ToolFront — ${ok ? copy.title : copy.exp}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F8FAFC;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{max-width:460px;padding:48px;text-align:center}h1{font-size:24px;margin:0 0 12px}.g{color:#16A34A}
p{color:#475569;line-height:1.6;margin:0 0 16px}a{color:#1D4ED8}</style></head>
<body><div class="c">
${ok ? `<h1>${copy.h1}<span class="g">.</span></h1><p>${copy.p1}</p><p><a href="${copy.altHref}">${copy.alt}</a> · <a href="/${zh ? "?lang=zh" : ""}">${copy.home}</a></p>`
      : `<h1>${copy.exp}<span class="g">.</span></h1><p>${copy.expP}</p><p><a href="${copy.altHref}">${copy.alt}</a> · <a href="/${zh ? "?lang=zh" : ""}">${copy.home}</a></p>`}
</div></body></html>`;
  };
  const hdr = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP };

  if (!/^[0-9a-f]{64}$/.test(token)) return new Response(html(false, "en"), { status: 200, headers: hdr });
  if (!env.KV) return new Response(html(false, "en"), { status: 200, headers: hdr });

  const raw = await env.KV.get("wl:token:" + token, "json");
  if (!raw || !raw.email) return new Response(html(false, "en"), { status: 200, headers: hdr }); // expired or already used — idempotent

  // Suppression check: if the address unsubscribed between signup and confirm,
  // burn the token and render the neutral "expired" page — never activate.
  if (await isSuppressed(env, raw.email)) {
    await env.KV.delete("wl:token:" + token);
    await env.KV.delete("wl:pending:" + raw.email);
    return new Response(html(false, raw.lang || "en"), { status: 200, headers: hdr });
  }

  // Activate: this is the auditable consent record (GDPR Art.7 proof).
  await env.KV.put("wl:" + raw.email, JSON.stringify({
    email: raw.email, domain: raw.domain || null, ip: raw.ip || null,
    signupTs: raw.signupTs || null, confirmedTs: new Date().toISOString(), source: "double-opt-in",
  }), { expirationTtl: 60 * 60 * 24 * 365 });
  // Single-use: burn the token + pending pointer.
  await env.KV.delete("wl:token:" + token);
  await env.KV.delete("wl:pending:" + raw.email);
  await env.KV.delete("wl:cool:" + raw.email);
  return new Response(html(true, raw.lang || "en"), { status: 200, headers: hdr });
}

/* ————— transactional email via Resend —————
   RESEND_API_KEY must be a Worker secret (`npx wrangler secret put RESEND_API_KEY`),
   NEVER a value in wrangler.toml (which lives in git history). */

/* Waitlist confirmation email copy — ONE language per send. The visitor's
   language is captured at signup and honoured here: an English signup gets an
   English email, a Chinese signup gets a Chinese one. Never both. */
const EMAIL_L10N = {
  en: {
    subject: "Confirm your spot on ToolFront",
    intro: "Hi — thanks for your interest in <strong>ToolFront</strong>, the agent-readiness toolkit for the open web.",
    domain: "You asked about the tool blueprint for <strong>{d}</strong> — we'll include it in your early access.",
    ask: "Please confirm your email address:",
    cta: "Confirm my email",
    orPaste: "Or paste this link into your browser:",
    ignore: "If you didn't request this, just ignore this email — nothing will be subscribed.",
    privacy: "Privacy policy",
    unsub: "Unsubscribe",
    textLink: "Open this link to confirm your email:",
  },
  zh: {
    subject: "请确认订阅 ToolFront",
    intro: "你好——感谢关注 <strong>ToolFront</strong>，这个面向开放网络的 AI 就绪度工具箱。",
    domain: "你询问了 <strong>{d}</strong> 的工具蓝图——我们会在早期访问时一并给你。",
    ask: "请确认你的邮箱地址：",
    cta: "确认我的邮箱",
    orPaste: "或把这个链接粘贴到浏览器：",
    ignore: "如果这不是你本人操作，忽略本邮件即可——不会产生任何订阅。",
    privacy: "隐私政策",
    unsub: "取消订阅",
    textLink: "打开下面的链接确认邮箱：",
  },
};

async function sendConfirmationEmail(env, toEmail, token, domain, lang) {
  const base = (env.PUBLIC_BASE_URL || "https://toolfront.dev").replace(/\/$/, "");
  const confirmUrl = base + "/confirm?token=" + token;
  // CAN-SPAM §5: every email must carry a valid physical postal address.
  // Fail closed — if POSTAL_ADDRESS is not configured as a Worker secret we
  // refuse to send rather than ship a non-compliant email.
  const postal = String(env.POSTAL_ADDRESS || "").trim();
  if (!postal) {
    console.log("email_blocked_no_postal_address — set via: npx wrangler secret put POSTAL_ADDRESS");
    return false;
  }
  // Same fail-closed gate as the postal address: no valid unsubscribe mechanism
  // (no dedicated HMAC key) = no email (CAN-SPAM). Never fall back to another
  // key's purpose.
  const unsub = await unsubToken(env, toEmail);
  if (!unsub) {
    console.log("email_blocked_no_unsub_secret — set via: npx wrangler secret put UNSUB_SECRET");
    return false;
  }
  const unsubUrlStr = unsubUrl(env, toEmail, unsub);
  const L = lang === "zh" ? "zh" : "en";
  const c = EMAIL_L10N[L];
  const subject = c.subject;
  const html = `<!DOCTYPE html><html lang="${L === "zh" ? "zh-CN" : "en"}"><body style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0F172A;max-width:520px;margin:0 auto;padding:32px">
<p style="font-size:15px;line-height:1.6">${c.intro}</p>
${domain ? `<p style="font-size:14px;color:#475569;line-height:1.6">${c.domain.replace("{d}", domain)}</p>` : ""}
<p style="font-size:15px;line-height:1.6">${c.ask}</p>
<p style="text-align:center;margin:28px 0"><a href="${confirmUrl}" style="background:#16A34A;color:#fff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:10px;display:inline-block">${c.cta}</a></p>
<p style="font-size:13px;color:#475569;line-height:1.6">${c.orPaste}<br><a href="${confirmUrl}" style="word-break:break-all">${confirmUrl}</a></p>
<p style="font-size:12.5px;color:#94A3B8;line-height:1.6">${c.ignore}</p>
<p style="font-size:12.5px;color:#94A3B8;line-height:1.6">ToolFront · ${postal} · <a href="https://toolfront.dev/privacy" style="color:#94A3B8">${c.privacy}</a>${unsubUrlStr ? ` · <a href="${unsubUrlStr}" style="color:#94A3B8">${c.unsub}</a>` : ""}</p>
</body></html>`;
  const text = `${c.subject}\n\n${c.textLink}\n${confirmUrl}\n\n${c.ignore}\n\nToolFront · ${postal} · https://toolfront.dev/privacy${unsubUrlStr ? `\n\n${c.unsub}: ${unsubUrlStr}` : ""}`;
  // Compliance assertion: no placeholder text may ever reach a recipient.
  if (html.includes("[YOUR") || text.includes("[YOUR")) {
    console.log("email_blocked_placeholder_detected");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
        ...(unsubUrlStr ? { "List-Unsubscribe": "<" + unsubUrlStr + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
      },
      body: JSON.stringify({
        from: "ToolFront <noreply@toolfront.dev>",
        to: [toEmail],
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.log("resend_error", res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.log("resend_exception", String(err));
    return false;
  }
}

// Named exports for the test suites: the scanner's pure check functions can be
// imported and run against any HTML/payload without a network round-trip, so
// tests always exercise the production implementation — never a copy.
export {
  extractWebMcpSurface, toolPoisonFindings, checkToolSecurity, checkWebMCP,
  scanDomainCore, challengeProbe, checkStructuredData, checkLlmsTxt,
  checkRobotsAI, checkMachineSurfaces, checkApiErrors, checkFreshness,
  checkLinkHeaders, CHECK_POLICY, TIER_BUDGET,
  homeTitleOf, llmsSampleFor,
};

