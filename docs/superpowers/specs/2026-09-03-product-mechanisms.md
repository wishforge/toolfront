# Product Mechanisms: Action Plan, Compare, Rankings — Engineering Spec

**Date:** 2026-09-03
**Status:** Approved for implementation (see plan: `docs/superpowers/plans/2026-09-03-product-mechanisms.md`)
**Scope:** `wishforge/toolfront` — report page action plan, email capture, three new scan checks, compare page, rankings page
**Origin:** Competitive analysis of isagentready.com (scan / compare / rankings pages, 2026-09-02) mapped onto this repo's actual code.

---

## 1. Competitive evidence (observed, 2026-09-02)

isagentready proves three mechanisms work on the same scan core:

| Mechanism | Their implementation | Our gap (verified in code) |
|-----------|---------------------|----------------------------|
| Action plan sorted by repair impact | Failed checks labeled "+N overall pts", sorted, top 3 shown | Fix cards exist (`report.html` `buildFixes`, line 980) but sort by tier only (line 1021–1024); gain is computed (`totalGain`, line 1030–1031) yet not used for ordering |
| Compare page (`/compare/a/b`) | Two scan results side by side, "leads by N" badge, per-check diff | No route, no page; `scanDomainCore()` is a pure function callable twice (line 802) |
| Rankings page (`/rankings`) | Aggregate of all scans, score-desc table, rows link to reports | monitor's D1 `scan_reports` table already stores per-domain latest scores; no aggregation endpoint anywhere |
| Email capture on report page | "Free PDF report" form at page bottom | N/A — monitor signup funnel already covers this (F2 dropped, see §F2) |
| Three checks we lack | api-errors (+3), freshness (+3), link-headers (+3) — all failed on toolfront.dev itself | `CHECK_POLICY` (worker.js line 750) has 6 checks; none covers API error shape, content freshness, or `Link:` response headers |

isagentready's rankings lose credibility because the top of the list is unknown domains (cavalli.tr). Our rankings will curate known SaaS brands instead — that is a strategy difference, not just UI.

**What we deliberately do NOT copy:** their 42-checkpoint granularity, 5-category taxonomy, AI visitor test, and per-profile readiness scores (rationale in §5). What we borrow is information architecture patterns only; all UI is built from our own V5 design system (glow-border cards, macOS chrome bar, score track, Blume-style fix cards).

## 2. Design decisions (ponytail ladder applied)

- **F1 sort:** reuse the existing comparator at `report.html:1022`. The gain (`c.max - c.points`) is already computed per card. Change: secondary sort key within tier. No new component, no new data.
- **F2 email capture:** reuse `/api/waitlist` verbatim (same-origin enforced, honeypot fields `name`/`company`). New code is one form + one fetch in `report.html`.
- **F3 three checks:** root cause is that `fetchCapped` (worker.js line 339) discards response headers except `cf-mitigated`. Fix the shared function once — add `ctype` and `link` to its return — and all three checks read from existing probes. Only `api-errors` needs one extra request.
- **F4/F5 compare + rankings:** reuse `scanDomainCore()` and monitor's D1 tables. New routes, no new scan logic.

## 3. Feature specs

### F1 — Action plan sorted by repair gain

- Within each tier group (blocking → interpretation → enrichment, order unchanged), fix cards sort by `gain = max - points` descending.
- Card header already shows a `+N pts` gain badge; sorting makes it the visual ordering principle.
- "Potential score" projection (checkbox recalculation) is untouched — it sums the same gains.

### F2 — Email capture on the report page — DROPPED (2026-09-03)

Original intent: a waitlist form at the report bottom reusing `/api/waitlist`, per the isagentready "Free PDF report" pattern.

Dropped during implementation review: toolfront-monitor already ships a full account funnel (signup → email confirm → login) and the report page CTA already links to monitor `/signup`. A second email capture on the same page would split the funnel, duplicate the audience store, and add a surface to maintain — ponytail rung 1 ("does this need to be built at all?") rejects it. isagentready needed the waitlist because it has no account product; we do.

If the waitlist is ever revisited, `/api/waitlist` (worker.js, honeypot + same-origin enforced) remains the ready backend.

### F3 — Three new checks

Shared enabler: `fetchCapped` and `probePath` return `ctype` (Content-Type) and `link` (Link header) alongside `status`/`text`.

| Check id | Tier (share) | Pass | Partial | Fail | na |
|----------|-------------|------|---------|------|----|
| `api-errors` | blocking (0.15) | Unknown `/api/tf-probe-<ts>` returns 4xx with JSON content-type | 4xx with non-JSON but non-HTML body | 4xx HTML error page (agents cannot parse it) | probe unreachable (status 0) or self-scan (ASSETS cannot exercise worker routes) |
| `freshness` | interpretation (0.25) | `dateModified` (JSON-LD) or `article:modified_time` or `Last-Modified` header present | only `article:published_time` or `<time datetime>` | no freshness signal in homepage HTML/headers | homepage text empty |
| `link-headers` | enrichment (0.4) | `Link:` header advertises `api-catalog` / `service-desc` / `service-doc` / `sitemap` rel | `Link:` header present, no agent-relevant rel | no `Link:` header | homepage unreachable |

Scoring policy change (worker.js):

```
TIER_BUDGET unchanged: { blocking: 55, interpretation: 35, enrichment: 10 }
CHECK_POLICY shares resplit:
  blocking:       robots-policy 0.35, webmcp 0.35, tool-security 0.15, api-errors 0.15
  interpretation: machine-surfaces 0.40, structured-data 0.35, freshness 0.25
  enrichment:     llms-txt 0.60, link-headers 0.40
SCORING_VERSION: "2.0.0" → "2.1.0"
```

The version bump trips the monitor's re-baseline guard (monitor-cron.ts), which skips score comparison for historical reports — no monitor code change needed. `SUB_CHECKS` (worker.js line 726) gains the three new ids so blocked reports keep a consistent shape. Existing check labels and max values change; the frontend reads tier/evidence from the API response, so no duplicated constants break.

Honest limitation (disclosed): for self-scans (`toolfront.dev` via ASSETS), `api-errors` is `na` — the asset server cannot exercise the worker's route fallback, so the check would measure the wrong layer.

### F4 — `/compare?a=X&b=Y` page

- Worker route: parse `a`/`b` params, normalize both, `scanDomainCore()` twice concurrently (KV cache applies), return both reports to the page.
- Page (`public/compare.html`): two V5 glow-border cards (grade badge, mono score, score-track cursor) + center VS badge + "X leads by N pts" delta pill + per-check diff rows (status per side, gain on the losing side).
- Errors (invalid/missing domain, one scan blocked) rendered inline; no partial comparison of a blocked report.

### F5 — `/rankings` page

- Data: monitor's D1 `scan_reports` — latest report per domain (`GROUP BY domain`), score-desc, limit 100. Served by the monitor worker route `GET /api/rankings` (the data lives there; the main worker has no D1 binding).
- Page (`public/rankings.html` in monitor's public assets): filter tabs (All / Hosting / Payments / DevTools / AI — curated list), rows with rank, domain, mini score track, grade badge; each row links to the main worker's report page.
- Curated verticals ship as a static list in the monitor repo; uncategorized domains appear only under "All".

## 4. Batch sequencing

- **Batch 1 (this session):** F1, F3 — report page upgrade + scanner depth. All local, previewable via `wrangler dev`.
- **Batch 2 (after Batch 1 user preview):** F4, F5 — new pages, cross-repo (monitor worker for rankings data).

## 5. Explicitly out of scope

- 42-checkpoint granularity, 5-category taxonomy (our 3-tier blast-radius model is the product).
- AI visitor test (needs live LLM calls; revisit with paying users).
- PDF report generation (waitlist capture is the funnel; PDF is a later promise).
- Per-agent install commands (we ship a hosted `/mcp` endpoint later, separate spec).
- Monitor-side rules-version-upgrade notification email (separate small spec).

## 6. Implementation mapping

| Spec item | Plan task |
|-----------|-----------|
| F1 sort | Task 1 |
| F2 email capture | ~~Task 2~~ (dropped, see §F2) |
| F3 shared header plumbing | Task 3 |
| F3 three checks + policy resplit + version bump | Task 4 |
| F1+F3 i18n + fix-card copy | Task 5 |
| Tests: dogfood + new check unit tests | Task 6 |
| Gates + local commit | Task 7 |
| F4 compare (Batch 2) | Task 8 |
| F5 rankings (Batch 2) | Task 9 |
