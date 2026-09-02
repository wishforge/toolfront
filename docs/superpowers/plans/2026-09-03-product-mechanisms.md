# Product Mechanisms Implementation Plan (Batch 1 + Batch 2)

> **For agentic workers:** Execute task-by-task in order. Batch 1 = Tasks 1–7 (this session, ends with local preview and USER CONFIRMATION — no deploy, per the preview gate). Batch 2 = Tasks 8–9 (only after the user approves the Batch 1 preview). Steps use checkbox syntax. Merging/deploying is a human action.

**Goal:** Turn the report page from "a list of findings" into "a prescription" (gain-sorted fixes), deepen the scanner with three checks isagentready empirically flagged on our own domain (api-errors, freshness, link-headers), then add the two growth surfaces (compare, rankings).

**Architecture:** No new scan engine. `fetchCapped`/`probePath` learn to return `ctype` + `link` headers once; three new checks read from existing probes; `CHECK_POLICY` shares resplit within unchanged tier budgets; `SCORING_VERSION` bumps to 2.1.0 (monitor re-baseline guard handles comparability). Report page gains a within-tier gain sort (comparator edit only) and a bottom waitlist form reusing `/api/waitlist`. Batch 2 adds two routes + two pages reusing `scanDomainCore()` and monitor D1.

**Tech Stack:** Cloudflare Workers/wrangler, vanilla DOM JS in `report.html` (repo convention: DOM-built via `textContent`, no framework), Node 22 plain `.mjs` self-executing tests, D1 (monitor repo) for rankings.

**Spec:** `docs/superpowers/specs/2026-09-03-product-mechanisms.md`

## Global Constraints

- No new npm dependencies.
- All dynamic DOM content built via `textContent` (XSS safety, existing convention in report.html).
- Commit messages in English. No Simplified Chinese in code, comments, or tests.
- KV namespace id in `wrangler.toml` stays a placeholder in commits (guarded by `git update-index --skip-worktree`).
- Before every commit: run the two gates (`node skills/precommit-ui-regression/scripts/secret-scan.mjs`, then `node skills/precommit-ui-regression/scripts/regression.mjs`). Both green or fix first.
- Preview gate: after Batch 1, run `wrangler dev`, show the user, and WAIT — no `wrangler deploy` in this plan.
- `SCORING_VERSION` must be bumped in the same commit that changes `CHECK_POLICY` (atomicity: monitor clients key comparability off it).

---

### Task 1: Fix-card sort — within-tier gain ordering (F1)

**Files:**
- Modify: `public/report.html` (comparator at lines 1021–1024)

**Interfaces:**
- Produces: fix cards ordered by tier group first, then `gain = max - points` descending within each group. No data-shape change.

- [ ] **Step 1: Extend the existing comparator**

```js
// Order by blast radius first (blocking → interpretation → enrichment), then by
// repair gain within each tier: the top of the list is always the highest-value fix.
fixable.sort(function (a, b) {
  var t = GROUP_ORDER.indexOf(tierOf(a)) - GROUP_ORDER.indexOf(tierOf(b));
  if (t !== 0) return t;
  return (b.max - (b.points || 0)) - (a.max - (a.points || 0));
});
```

- [ ] **Step 2: Verify** — scan a domain with mixed fail/partial checks; confirm the top blocking card is the largest `+N pts` one and group headers still appear in tier order.

---

### Task 2: Email capture on the report page (F2) — DROPPED (2026-09-03)

Dropped by user decision during implementation: toolfront-monitor already ships the account funnel (signup → confirm → login) and the report CTA already links to monitor `/signup`. A second email capture would split the funnel and duplicate the audience store (ponytail rung 1). No code kept. See spec §F2.

---

### Task 3: Header plumbing in fetchCapped/probePath (F3 enabler)

**Files:**
- Modify: `worker.js` (`fetchCapped` return objects; `probePath` self-scan branch)

**Interfaces:**
- Produces: successful probe results carry `ctype` (lowercased Content-Type, `null` if absent) and `link` (Link header value or `null`). Error/redirect-chain results omit both (callers treat `undefined` as absent).

- [ ] **Step 1: `fetchCapped`** — on the final GET return (line ~378) and HEAD return (line ~363) add:

```js
ctype: (res.headers.get("content-type") || "").toLowerCase() || null,
link: res.headers.get("link"),
```

- [ ] **Step 2: `probePath` self-scan branch** — add the same two fields from the ASSETS response headers.
- [ ] **Step 3: Verify** — `node --check worker.js`; existing tests still pass (`npm test`).

---

### Task 4: Three new checks + policy resplit + version bump (F3)

**Files:**
- Modify: `worker.js` (`CHECK_POLICY`, `SUB_CHECKS`, `SCORING_VERSION`, new check functions, `scanDomainCore` wiring)

**Interfaces:**
- Produces: report `checks[]` includes `api-errors`, `freshness`, `link-headers` with the same `{ id, label, tier, evidence, max, status, points, detail }` shape. `scoring_version` = `"2.1.0"`.

- [ ] **Step 1: Resplit `CHECK_POLICY`** exactly as spec §F3 (blocking 0.35/0.35/0.15/0.15, interpretation 0.40/0.35/0.25, enrichment 0.60/0.40). Add evidence grades: api-errors `B`, freshness `B`, link-headers `C`.
- [ ] **Step 2: `SCORING_VERSION = "2.1.0"`** and add the three ids to `SUB_CHECKS`.
- [ ] **Step 3: Implement check functions** (pure, testable):

```js
function checkApiErrors(probe) {          // probe = result of /api/tf-probe-<ts>
  if (!probe || probe.status === 0) return { status: "na", ratio: 0, detail: "Probe unreachable." };
  const ok4xx = probe.status >= 400 && probe.status < 500;
  const isJson = !!probe.ctype && probe.ctype.includes("json");
  if (ok4xx && isJson) return { status: "pass", ratio: 1, detail: "API errors return machine-readable JSON." };
  if (ok4xx) return { status: "fail", ratio: 0, detail: "API errors return " + (probe.ctype || "no content-type") + " — agents cannot parse HTML error pages." };
  return { status: "partial", ratio: 0.5, detail: "Unknown API path returned HTTP " + probe.status + "." };
}
function checkFreshness(home, headersLastModified) {
  const t = home.text || "";
  if (/dateModified|article:modified_time/i.test(t) || headersLastModified) return { status: "pass", ratio: 1, detail: "Content freshness signals found." };
  if (/article:published_time|<time[^>]+datetime/i.test(t)) return { status: "partial", ratio: 0.5, detail: "Published date found but no last-modified signal." };
  return { status: "fail", ratio: 0, detail: "No freshness signals — agents cannot tell how recent this content is." };
}
function checkLinkHeaders(home) {
  const link = home.link;
  if (!link) return { status: "fail", ratio: 0, detail: "No Link response header — agents must parse HTML to discover machine resources." };
  if (/api-catalog|service-desc|service-doc|sitemap/i.test(link)) return { status: "pass", ratio: 1, detail: "Link header advertises agent-relevant relations." };
  return { status: "partial", ratio: 0.5, detail: "Link header present but carries no agent-relevant rel." };
}
```

- [ ] **Step 4: Wire into `scanDomainCore`** — one extra probe `probePath(env, domain, "/api/tf-probe-" + Date.now())` in the existing `Promise.all`; freshness/link-headers read from the existing `home` probe (plus `home.headers` Last-Modified — expose it in Task 3 as `lmod`). Self-scan: `api-errors` forced `na` (asset server cannot exercise worker routes — spec limitation).
- [ ] **Step 5: Verify** — `npm test`; scan `toolfront.dev` via `wrangler dev` and confirm the three new cards appear with honest statuses.

---

### Task 5: i18n + fix-card copy for the new checks (F1/F3 glue)

**Files:**
- Modify: `public/report.html` (fixDict entries + `t()` dictionaries en/zh)

**Interfaces:**
- Consumes: check ids from Task 4. Produces: fix cards for `api-errors.<status>`, `freshness.<status>`, `link-headers.<status>` with title, serif detail, and paste-ready sample blocks (RFC 9457 problem+json sample; JSON-LD `dateModified` sample; nginx `add_header Link` sample — same content isagentready cited, rewritten in our voice).

- [ ] **Step 1: fixDict** — add entries for all three ids × (fail, partial).
- [ ] **Step 2: i18n** — check labels come from the API (`policyOf`), fix-card copy and waitlist strings added to both dictionaries.
- [ ] **Step 3: Verify** — toggle lang switch on the report page; no `report.fix.*` raw keys leak through.

---

### Task 6: Tests

**Files:**
- Modify: `tests/dogfood.test.mjs` (new check ids appear in self-scan; api-errors is `na` for self-scan)
- Create: `tests/product-checks.test.mjs` — unit tests for the three pure check functions (pass/partial/fail/na per spec table), the Task 1 comparator ordering, and that `policyOf` maxes sum to ≤ tier budgets.
- Modify: `package.json` (append the new suite to `scripts.test`)

**Interfaces:**
- Repo convention: self-executing, `console.log` progress, `process.exit(fail ? 1 : 0)`.

- [ ] **Step 1: Write `tests/product-checks.test.mjs`** (export the check functions from worker.js or re-declare via import — follow however `dogfood.test.mjs` accesses the engine).
- [ ] **Step 2: Update dogfood expectations** for the resplit maxes and the `na` api-errors on self-scan.
- [ ] **Step 3: `npm test`** — all suites green.

---

### Task 7: Gates + local commit + preview (Batch 1 checkpoint)

- [ ] **Step 1: `node skills/precommit-ui-regression/scripts/secret-scan.mjs`** → green.
- [ ] **Step 2: `node skills/precommit-ui-regression/scripts/regression.mjs`** → green.
- [ ] **Step 3: Commit locally (English message, no push):**

```
feat(report): gain-sorted action plan, waitlist capture, api-errors/freshness/link-headers checks

- sort fix cards by repair gain within tier (scoring 2.1.0, shares resplit)
- fetchCapped/probePath now surface content-type, link, last-modified headers
- three new checks; api-errors is na for self-scan (asset-server limitation)
- report page: bottom waitlist form reusing /api/waitlist (honeypot included)
- tests: product-checks suite; dogfood updated for new policy
```

- [ ] **Step 4: `wrangler dev` → present the report page to the user → STOP and wait for confirmation.** No deploy.

---

### Task 7b (Batch 2a, added 2026-09-03): quick wins from the claude.com deep-dive

**Files:**
- Modify: `public/report.html` (SOURCES map + fix-card link row + version stamp in colophon)

**Interfaces:**
- Consumes: `r.rules_version` / `r.scoring_version` (already in the report JSON); check ids for the SOURCES map.
- Produces: each fail/partial fix card renders a row of authoritative source links (RFC / spec, `rel=noopener`, `target=_blank`); the colophon shows `rules vX · scoring vY`.

- [ ] **Step 1: `CHECK_SOURCES` const map in report.html** (per check id, 1–3 links; UI concern, no API change).
- [ ] **Step 2: Render links** inside the fix card under the skill link (only when the card is a fail/partial fix).
- [ ] **Step 3: Version stamp** in the colophon: `rules {rules_version} · scoring {scoring_version}` (mono, muted).
- [ ] **Step 4: Verify** in `wrangler dev` — links render on failing cards, stamp shows, `npm test` green (report-dom asserts the stamp).

---

### Task 8 (Batch 2): /compare route + page (F4)

**Files:**
- Modify: `worker.js` (route `/compare` → serve `public/compare.html`; API `GET /api/compare?a=&b=` returns `{ a: report, b: report }`, two concurrent `scanDomainCore` calls, KV cache applies)
- Create: `public/compare.html` (V5 dual glow cards + VS badge + delta pill + per-check diff rows)

**Interfaces:**
- Reuses `/api/scan` cache semantics; blocked reports render as "blocked" card, not compared.

- [ ] **Step 1: Worker route + API.** - [ ] **Step 2: compare.html.** - [ ] **Step 3: Mobile layout (cards stack, VS badge stays centered).** - [ ] **Step 4: Tests + gates + local commit.**

### Task 9 (Batch 2): /rankings route + page (F5)

**Files:**
- Modify: `toolfront-monitor/src/monitor-routes.ts` (`GET /api/rankings` — latest report per domain from D1, score desc, limit 100)
- Create: monitor `public/rankings.html` (filter tabs over a curated verticals list, mini score tracks, grade badges, rows link to `https://toolfront.dev/report?domain=`)

**Interfaces:**
- `GET /api/rankings?vertical=hosting` → `{ rows: [{ domain, score, grade, scannedAt }] }`. Curated list is a static module in the monitor repo.

- [ ] **Step 1: D1 aggregation query + route.** - [ ] **Step 2: rankings.html.** - [ ] **Step 3: Tests + gates + local commit.**

---

## Self-Review

**Spec coverage scan:** F1→Task 1 (+Task 5 copy), F2→DROPPED (Task 2 records the decision), F3→Tasks 3/4/5/6, F4→Task 8, F5→Task 9, scoring policy change→Task 4 Step 1–2, version bump→Task 4 Step 2, `SUB_CHECKS`→Task 4 Step 2, self-scan `api-errors` na→Task 4 Step 4 + Task 6 Step 2. All live spec items mapped; the dropped item is documented, not silently omitted.

**Placeholder scan:** No `TODO`/`TBD`/`...` placeholders in committed tasks — Batch 2 steps are intentionally collapsed one-liners marked as later-scope, which is sequencing, not a placeholder. Sample copy content is named concretely (RFC 9457 body, JSON-LD dateModified, nginx Link header).

**Interface/type consistency:** Check result shape `{ id, label, tier, evidence, max, status, points, detail }` — matches `scoreCheck`/`policyOf` (worker.js:761–873). New check functions return `{ status, ratio, detail }` — matches `scoreCheck` contract. `fetchCapped` new fields `ctype`/`link`/`lmod` are additive; all existing call sites destructure only known fields, so no breakage. `scoring_version` bump trips monitor re-baseline guard (monitor-cron.ts lines 123–129) — no monitor edit required for Batch 1. Waitlist contract verified against `handleWaitlist` (worker.js:1096): same-origin, honeypot `name`/`company`, `{ email }`.

## Execution Handoff

**Option A — subagent-driven (recommended if resuming in a fresh session):** spawn one implementer subagent per task in order (Tasks 1→7), each receives: this plan path, the spec path, the task text, and the repo constraint block; the orchestrator runs gates after Task 6 and before the Task 7 commit, and stops at the Task 7 Step 4 checkpoint for user preview.

**Option B — inline (used for this session):** execute Tasks 1–7 sequentially in the main session, running `npm test` after Tasks 4/6 and the two gates before the Task 7 commit; stop at the preview checkpoint. Batch 2 (Tasks 8–9) starts only after the user approves the Batch 1 preview.
