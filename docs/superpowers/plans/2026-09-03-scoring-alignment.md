# Plan: scoring-model alignment

**Spec:** `docs/superpowers/specs/2026-09-03-scoring-alignment.md`
**Branch:** `feat/scoring-alignment` (cut from the current feature branch)
**Why now:** we have no monitoring customers, so a `SCORING_VERSION` bump costs
zero migrations. Once reports are public and indexed, a score becomes a promise.

## Order of work (deliberate: explanation ships before the number moves)

### Task 1 — `/methodology` page (no scoring change)

**Files**
- Create: `public/methodology.html`
- Modify: `worker.js` (route), `public/report.html` (link from the version
  stamp), `public/compare.html` (footer link)
- Create: `tests/methodology.test.mjs`

**Interfaces**
- `GET /methodology` → HTML, bilingual, same security headers as other pages.
- `GET /methodology` with `Accept: text/markdown` → Markdown version of the same
  content (agents can read the rules without parsing HTML).
- Content is generated from the same constants the scanner uses
  (`CHECK_POLICY`, `TIER_BUDGET` after Task 2) so the page cannot drift from the
  engine: one source of truth, rendered, not retyped.

- [ ] **Step 1:** render the check table from `CHECK_POLICY` (label, pool, max
      points, what pass/partial/fail/na mean) plus `rules_version` and
      `scoring_version`.
- [ ] **Step 2:** `Accept: text/markdown` variant; `Link` header pointing at it
      (dogfooding our own check).
- [ ] **Step 3:** link from the report page version stamp and the compare footer.
- [ ] **Step 4:** tests — table row count matches the policy, markdown variant
      returns `text/markdown`, security headers present, no drift between the
      rendered weights and `CHECK_POLICY`.

### Task 2 — three-pool scoring model

**Files**
- Modify: `worker.js` (`CHECK_POLICY` pool field, `TIER_BUDGET` → pool budgets,
  surface detection, scoring loop, `SCORING_VERSION` 2.1.0 → 3.0.0)
- Modify: `public/report.html` (pool-aware grouping/labels, na wording,
  "not applicable" vs "failed")
- Modify: `tests/product-checks.test.mjs`, `tests/supplemental.test.mjs`,
  `tests/dogfood.test.mjs` (new expectations)

**Interfaces**
- `CHECK_POLICY[id].pool` ∈ `essential` | `surface` | `emerging`.
- `report.checks[]` gains `pool`; `na` keeps `points: null` and is excluded from
  both `score` and `scoreMax`.
- `emerging` checks contribute to `score` only, never `scoreMax`.
- New shared `detectApiSurface(domain, env, probes)` → boolean, used once per
  scan for the `surface` pool.

- [ ] **Step 1: surface detection.** Positive signals: `openapi.json`,
      `/.well-known/api-catalog`, MCP server card, an `/api/*` probe that
      answers machine-readably. Cheap: reuse probes already in the scan.
- [ ] **Step 2: pool the checks.** Essential: robots-policy, machine-surfaces,
      structured-data, freshness, llms-txt, link-headers. Surface: api-errors,
      tool-security. Emerging: webmcp (bonus, cap 8).
- [ ] **Step 3: scoring loop.** Denominator = essential + applicable surface.
      Emerging bonus added to `score` only. `tool-security` stays a hard failure
      when a surface exists.
- [ ] **Step 4: UI.** Group by pool, label na as "not applicable", label
      emerging as a forward-looking opportunity with its bonus.
- [ ] **Step 5: `SCORING_VERSION` → 3.0.0.** Confirm the monitor re-baseline
      guard (monitor-cron.ts) needs no change — it keys on the version string.
- [ ] **Step 6: tests + gates + local commit.**

### Task 3 — re-run the benchmark and report

- [ ] **Step 1:** re-scan the same 123-domain stratified sample (scripts in the
      private workspace; ~8 minutes at 8 concurrent).
- [ ] **Step 2:** re-run `analyze.py`; confirm Spearman ≥ 0.75 and mean delta
      ≥ −10.
- [ ] **Step 3:** if Spearman drops, stop and reassess — the change is wrong.
- [ ] **Step 4:** write the result into the private `REPORT.md`, then present
      the new scoring model to the user for preview.

### Task 4 — gates, commit, preview

- [ ] **Step 1:** `npm test` (all suites) — green.
- [ ] **Step 2:** secret-scan + UI regression gates — green.
- [ ] **Step 3:** local commit, push branch, open PR. Merge stays manual.
- [ ] **Step 4:** `wrangler dev` preview of the report page and the methodology
      page; wait for confirmation. **No deploy.**

---

## Self-Review

**Spec coverage scan:** §1 problem → Task 2 (pooling + surface detection) ·
§2 goal → Task 2 · §3 Pool A/B/C → Task 2 Steps 2-4 · §3 scoring shape → Task 2
Steps 3 and 6 · §4 methodology page → Task 1 · §5 acceptance → Task 3 ·
§6 out of scope → explicitly not in any task (more checks, grade bands,
behavioural tests). Every spec section has a task; nothing in the spec is
silently dropped.

**Placeholder scan:** every file named above exists or is explicitly created by
this plan. Weights are stated as numbers (19/8, cap 8), not "TBD". Task 3 has
numeric pass/fail thresholds, not "verify it looks right".

**Interface/type consistency:** `CHECK_POLICY` gains a `pool` field while
keeping `tier` (report page groups by tier today; both fields coexist for one
release so the UI change and the engine change can be verified separately).
`report.checks[]` gaining `pool` is additive — the monitor stores `report_json`
and reads only `score`/`grade`/`checks[].status`, so no monitor change is
required beyond the version-keyed re-baseline that already exists.
`scoreMax` shrinking on `na` is the behaviour the monitor already sees today for
`tool-security`; extending it to `api-errors` is the same code path.

## Execution Handoff

**Option A — subagent-driven (recommended if resuming in a fresh session):**
one implementer per task, in order (Task 1 → 2 → 3 → 4); each receives this
plan path, the spec path, the task text, and the repo constraint block. The
orchestrator runs gates after Task 2 and before the Task 4 commit, and stops at
the Task 4 preview checkpoint.

**Option B — inline (this session):** execute Tasks 1–4 sequentially in the main
session; run `npm test` after Tasks 1 and 2, the benchmark after Task 2, and both
gates before the Task 4 commit; stop at the preview checkpoint and wait for the
user.
