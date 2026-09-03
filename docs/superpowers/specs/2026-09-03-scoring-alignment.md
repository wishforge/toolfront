# Spec: scoring-model alignment (three-pool model)

**Date:** 2026-09-03 · **Branch:** `feat/scoring-alignment` · **Status:** drafting

## 1. Problem

Our score is built as three tiers with fixed budgets
(`TIER_BUDGET = { blocking: 55, interpretation: 35, enrichment: 10 }`, max 99).
Two checks inside `blocking` carry 27 of those 99 points:

| Check | Points | Measured pass rate (internal benchmark, 92 real domains) |
|---|---|---|
| `webmcp` | 19 | 11% |
| `api-errors` | 8 | 7% |

Two consequences follow, and both are visible to users on the first report:

1. **Almost every site loses ~27 points before the scan really starts.** The
   observable result is a mean score ~25 points below an independent industry
   benchmark, with a stable offset across every band — a scale artefact, not a
   judgement difference (ordering still correlates 0.777).
2. **Sites with no API at all are penalised for API-shaped checks.** There is no
   "this surface does not exist here, so this check does not apply" path. We
   already have `na` plumbing (`tool-security` when there is no tool surface,
   self-scan `api-errors`) — it is simply not applied to the API surface.

Evidence lives in the private workspace (`toolfront-cfg/competitive-benchmark/`):
a 3,250-domain corpus, a 123-domain stratified sample, and published
source-code/official-site rules from the standards bodies and several vendors.
This spec deliberately does not restate competitor names; the public repo should
argue from our own measurements.

## 2. Goal

Separate **what every site must answer** from **what only applies if the site
offers that surface** from **what is genuinely new and cannot yet be required** —
without losing the differentiator that makes our scan worth running.

## 3. Design — three pools

### Pool A · Essential (always scored)
Checks that answer "can an agent read and understand you". They apply to every
site, so they are always in the denominator.

- `robots-policy` (AI crawler policy)
- `machine-surfaces` (sitemap / OpenAPI discoverability)
- `structured-data` (JSON-LD)
- `freshness` (content date signals)
- `llms-txt`
- `link-headers` (RFC 8288)

### Pool B · Surface-gated (scored only when the surface is detected)
Checks that only mean something if the site actually exposes that surface.
Detection is a single shared decision: **does this origin expose an API or
tool surface?** (positive signals: `openapi.json` / `api-catalog` / MCP server
card / `/.well-known` API metadata / an `/api/*` route that responds
machine-readably).

- **Detected** → the checks are scored normally.
- **Not detected** → the checks are `na` (`points: null`), the denominator
  shrinks by their max, and the UI shows them as "not applicable", not "failed".

Checks in this pool: `api-errors`, `tool-security`.

`tool-security` keeps its current behaviour when a surface *does* exist —
poisoning detection stays a hard failure. That check is ours alone in this field
and is a reason to run our scanner; it must not be softened.

### Pool C · Emerging (add-only bonus, capped)
Standards that are real, worth showing, and not yet reasonable to require.
Present → bonus points. Absent → nothing deducted, and the check is labelled as
a forward-looking opportunity rather than a failure.

- `webmcp` — capped bonus (proposed: 8 points).

This matches how the browser vendor that is driving WebMCP treats it in its own
tooling: an informational audit that returns not-applicable (not a failure) when
nothing is registered.

### Scoring shape

- `score` = sum of points from Pool A + applicable Pool B + Pool C bonus.
- `scoreMax` = sum of max points from Pool A + applicable Pool B only.
  **Pool C is never in the denominator** — that is the whole point of add-only.
- Grade bands are unchanged (A ≥ 85, B ≥ 70, C ≥ 50, D ≥ 30, F below): they
  already sit inside the industry range, and changing them would be a second
  variable in the same experiment.
- `SCORING_VERSION` → `3.0.0` (a structural change, not a tweak). The monitor's
  re-baseline guard already handles version changes; **there are no monitoring
  customers yet, so the migration cost is zero, which is exactly why we do this
  now.**

## 4. Public methodology page (ships first)

`GET /methodology` — a page listing every check, its pool, its weight, what pass
/ partial / fail mean, and the current `rules_version` + `scoring_version`.
Served with the same security headers as the rest of the site, bilingual
(en/zh), and **also available as Markdown** (`Accept: text/markdown`) so agents
can read the rules without parsing HTML.

Rationale: the number on the report is a claim, and a claim needs a page behind
it. Shipping this before the rescoring means the change reads as "we explained
our standard" rather than "we moved the goalposts".

## 5. Acceptance criteria (measured, not asserted)

Re-run the internal benchmark (scripts already exist in the private workspace)
against the same corpus and report:

1. **Spearman rank correlation ≥ 0.75** — alignment must not damage ordering.
   If it drops, the change is wrong even if the mean looks better.
2. **Mean delta moves from −24.5 to ≥ −10** — the scale artefact is gone.
3. Offline suites and both precommit gates stay green.

## 6. Explicitly out of scope

- Adding more checks. Granularity was never the problem (9 vs 16–118 elsewhere,
  ordering still correlates 0.777).
- Changing grade bands.
- Behavioural testing (a real agent attempting tasks) — still deferred.
- Any competitive claim in a public artifact. The methodology page describes
  **our** rules; it does not compare us to anyone.
