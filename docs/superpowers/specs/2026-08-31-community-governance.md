# Community Governance & Rules Externalization — Engineering Spec

**Date:** 2026-08-31
**Status:** Approved for implementation (see plan: `docs/superpowers/plans/2026-08-31-community-governance.md`)
**Scope:** `wishforge/toolfront` — CI merge gating, community PR review pipeline, scan-rule externalization

---

## 1. Findings (verified against repo config, 2026-08-30)

| # | Severity | Finding | Evidence |
|---|----------|---------|----------|
| F1 | P0 | `main` had no branch protection — a red CI run could still be merged | `gh api …/branches/main/protection` → 404; `rulesets` = `[]`; `allow_auto_merge` = false. **Fixed on 2026-08-30**: required check `Offline suites (SAST · secrets · regressions)`, `enforce_admins=true`, `strict=true`, auto-merge enabled. Merging is a human action. |
| F2 | P1 | 4 test suites were orphans — never executed anywhere: `dogfood`, `email-lang`, `red32`, `report-dom` | Present in `tests/`, absent from both `npm test` and the CI workflow. Verified 4/4 PASS locally. |
| F3 | P1 | Static ReDoS linting is provably incomplete (5/6 coverage in self-test) | `(x+x+)+y` and `<(?:[a-zA-Z]+)*\s*>` evade fixed-input-family detection. |
| F4 | P2 | No CONTRIBUTING / PR template / CODEOWNERS — every community PR's education cost falls on the solo maintainer | Repository inspection. |

Key correction of understanding: "running the checks" (CI) and "preventing the merge" (branch protection) are two independent mechanisms. F1 showed the first existed while the second did not.

## 2. Industry research (authoritative sources)

- **semgrep-rules** (community security-rule corpus): differential testing is a *merge precondition* — "The test file must contain at least one true positive **and** one true negative test case to be approved." 20+ automated lints including a performance check (`slow-pattern-top-ellipsis`). "Pull requests require the approval of at least one maintainer **and** successfully passed CI jobs" — CI pass never auto-merges community rules.
- **nuclei-templates** (largest community detection corpus): three-stage CI — yamllint → `nuclei -validate` → **honeypot weak-matcher check** (templates run against `http://honey.scanme.sh`; a hit auto-labels the PR `false-positive`). Post-merge: template signing + checksums.
- **GitHub Docs** (auto-merge): after required reviews and status checks pass, GitHub completes the merge automatically. The human Approve is the only manual step.

**Conclusion shared by all three:** nobody auto-merges community rules. Machines own everything *provable* (format, safety, performance, validity); humans own only the *unprovable* (should this rule exist). Auto-merge is reserved for trivially safe paths (docs).

## 3. Essence: split review labor by provability

| Layer | Examples | Owner | Mechanism |
|-------|----------|-------|-----------|
| Mechanically provable | format, malicious-code execution, ReDoS, false positives | **Machine** | Schema + compile-time whitelist + dynamic timing probe + differential samples |
| Constrainable by samples | does the rule actually catch what it claims | **Contributor** | Mandatory TP + TN samples (CI rejects PRs without them) |
| Unprovable | should the rule exist; severity semantics | **Human (only)** | After both layers pass, ~2 min semantic read |

## 4. Design: four gates + diff triage (validated locally, 14/14)

- **Gate 0 — diff triage:** T3 docs (fully automatic) / T2 tests / T1 rules JSON (machine-full, human reads semantics only) / T0 executable code (human reads line by line). Unrecognized paths fail closed to T0.
- **Gate 1 — JSON schema:** field whitelist, enum values, severity range, `applies` subset, id format + uniqueness, semver version.
- **Gate 2 — compile-time, fail-closed:** type whitelist (`regex|length-over|executor`); flags limited to `[iu]*` (stateful `g`/`y` leak `lastIndex` across calls); executor whitelist via a null-prototype map (`decodeFindings` only — prototype-chain escape proven blocked); static ReDoS heuristics (4 patterns).
- **Gate 3 — dynamic ReDoS probe:** static linting can't be complete, so measure instead of guess. Attack strings are generated from each regex's **own literal alphabet** (fixes the two misses above: `(x+x+)+$` needs `x`, tag-nesting needs `<`). Exponential blowup → reject at a 60 ms per-sample budget; super-linear growth → reject above a 5 ms absolute budget at 4000 chars (calibrated to the real workload: ~50 tools × ≤500-char descriptions). Ladder ×1.2 from n=8 (2× steps jump over the blowup cliff — measured 98 s detection once, 0.13 s after the fix).
- **Gate 4 — differential samples:** every rule must fire on ALL its declared malicious samples and ZERO of the benign corpus.

**Validated results (local demo, 14/14):**

| Cohort | Result |
|--------|--------|
| A — 15 normal regexes (incl. all 4 production rules) | 0 false kills, worst probe cost 11.5 ms |
| B — 12 known ReDoS patterns (OWASP/regexploit corpus) | 12/12 blocked; probe stops at budget (≤60 ms), never walks the full ladder |
| C — 1 industry-known quadratic (email regex) | correctly flagged super-linear — a true positive, initially mislabeled by us as a false positive |
| PR orchestration simulation (7 PRs) | docs→auto; ReDoS/executor-escape/benign-harm all blocked; clean rule → semantic-only review; worker.js → full human review |

Honest limitation, disclosed: the ReDoS heuristic is detection-support, not proof; the gate's thresholds derive from the current workload and need recalibration if it changes. Super-linear-but-in-budget rules warn instead of blocking. The final semantic judgment stays human.

## 5. Rules externalization (v3, validated 42/42)

`rules/poisoning.json` is the only community-editable surface; `rules/poisoning.mjs` is generated from it by `scripts/build-rules.mjs` (`JSON.parse` is the code-injection firewall — a "JSON" PR containing JS dies there) and committed so Workers deploys need no build step; CI asserts the generated file is in sync. `worker.js` compiles rules through the four gates at startup; `compileRules` is exported for regression tests (10 hostile-rule vectors must all be rejected, including duplicate-id — the worker-side compiler is self-sufficiently fail-closed).

## 6. Implementation mapping

| Spec item | Plan task |
|-----------|-----------|
| F2 — orphan suites | Task 1 |
| Gate 3 in-repo | Task 2 |
| Rules externalization (§5) | Task 3 |
| Gates 1/2/4 as CI job | Task 4 |
| Contributor path (semgrep model) | Task 5 |
| CODEOWNERS | Task 6 |
| Docs auto-merge | Task 7 |
| Delivery PR | Task 8 |

Phase 2 (explicitly out of scope): honeypot-based false-positive probing (nuclei model), post-merge rule signing.
