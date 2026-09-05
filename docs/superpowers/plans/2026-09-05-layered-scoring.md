# Layered Scoring (Mastery 86 + Capability 108) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the variable-denominator score display (86/94/102/108) with two fixed-basis metrics — **Mastery** (essential pool / 86, drives the grade, comparable across all sites) and **Capability** (whole rubric / 108, shown as /100, drives board ranking) — without changing the stored raw `score`.

**Architecture:** The engine (`toolfront/worker.js`) keeps computing the absolute `score` exactly as today and additionally derives `mastery {earned,max,pct}` and `capPct` from the existing per-check results; the grade is rebased from the variable `pct` to the fixed `masteryPct`. The report page and both leaderboard surfaces render capability as `x / 100` with a mastery sub-line. Old cached reports (SCORING_VERSION 3.0.0, no new fields) fall back to the legacy rendering via feature detection. The rankings board is currently empty (verified: `GET /api/rankings` → count 0), so the grade-semantics change costs zero migration.

**Tech Stack:** Cloudflare Worker (single-file `worker.js`, ESM), vanilla-JS pages in `public/*.html` with inline `LANGS`/`PAIRS` dictionaries, D1 (`scan_history`) + KV cache, Vitest-style offline suites in `tests/*.test.mjs` (jsdom), precommit gates (`secret-scan`, `regression.mjs`, `i18n-audit.mjs`).

**Spec:** findings ledger `/tmp/score-max-findings-2026-09-05.md` (copy into the repo in Task 0). Decision recorded there: Model C (layered), do NOT copy isagentready's inflated /100.

## Global Constraints

- Stored raw `score` semantics are unchanged: absolute points out of the 108-point rubric. D1 columns and the monitor rankings API keep returning it.
- `SCORING_VERSION` bumps `"3.0.0"` → `"3.1.0"`; `BENCHMARK_VERSION` stays `"1"` (anchors are keyed on absolute `score`, unaffected).
- Grade thresholds stay 85/70/50/30 but are applied to `masteryPct`, not the variable `pct`.
- All new user-facing copy is bilingual (EN + ZH) wired through the page's own dictionary; shared strings go to `public/i18n/common.js`. No hardcoded copy in markup.
- No third-party (isagentready) data is ingested anywhere; their site is reference only.
- Commit messages in English. Never commit `wrangler.toml` KV ids (secret-scan gate).
- UI changes ship through the pre-commit gates and require local preview + user confirmation before `wrangler deploy` (standing user rule).

---

### Task 1: Engine — `layeredScores()` in worker.js, grade rebase, version bump

**Files:**
- Modify: `toolfront/worker.js` (insert after the scoring loop at ~line 1152–1160; add exported pure function near `POOL_BUDGET` at line 940; change `SCORING_VERSION` at line 939)
- Test: `toolfront/tests/scoring-layered.test.mjs` (new)

**Interfaces:**
- Produces: `export function layeredScores(checks, poolBudget)` → `{ masteryEarned, masteryMax, masteryPct, capPct, capMax, grade }`, where `checks` is the report's `checks` array (`{pool, points, max, status}`; `points === null` means n/a) and `poolBudget` defaults to `POOL_BUDGET`. The report payload gains `mastery: {earned, max, pct}` and `capPct`; `grade` is now mastery-based.
- Consumes: existing `checks` array and `POOL_BUDGET` (already in scope at both sites).

- [ ] **Step 1: Write the failing test**

Create `toolfront/tests/scoring-layered.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { layeredScores } from "../worker.js";

const PB = { essential: 86, surface: 14, emerging: 8 };
const chk = (pool, points, max) => ({ pool, points, max, status: points === null ? "na" : "pass" });

console.log("\n[SL] layered scoring");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log("  ✗ " + n); } };

// Full rubric, everything passes: mastery 86/86 = A, capability 108/108 = 100
{
  const checks = [
    chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8),
    chk("surface", 8, 8), chk("surface", 6, 6), chk("emerging", 8, 8),
  ];
  const L = layeredScores(checks, PB);
  ok("full rubric: masteryEarned=86", L.masteryEarned === 86 && L.masteryMax === 86);
  ok("full rubric: masteryPct=100 grade=A", L.masteryPct === 100 && L.grade === "A");
  ok("full rubric: capPct=100 capMax=108", L.capPct === 100 && L.capMax === 108);
}
// No tool surface (surface+emerging n/a): mastery still out of 86, capability caps at 79
{
  const checks = [
    chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8),
    chk("surface", null, 8), chk("surface", null, 6), chk("emerging", null, 8),
  ];
  const L = layeredScores(checks, PB);
  ok("narrow site: masteryPct=100 grade=A", L.masteryPct === 100 && L.grade === "A");
  ok("narrow site: capPct=80 (86/108)", L.capPct === 80 && L.capMax === 108);
}
// Partial mastery: 74/86 = 86% → A threshold
{
  const checks = [chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 6, 10), chk("essential", 8, 8)];
  const L = layeredScores(checks, PB);
  ok("74/86 = 86% grade=A", L.masteryEarned === 74 && L.masteryPct === 86 && L.grade === "A");
}
// Essential blocked by bot protection: masteryMax shrinks (warn banner covers it)
{
  const checks = [chk("essential", 20, 20), chk("essential", null, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8)];
  const L = layeredScores(checks, PB);
  ok("blocked essential: masteryMax=68", L.masteryMax === 68);
}
ok("suite complete", true);
console.log(`[SL] ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd toolfront && node tests/scoring-layered.test.mjs`
Expected: FAIL — `layeredScores` is not exported.

- [ ] **Step 3: Implement**

In `worker.js`, change line 939 to `const SCORING_VERSION = "3.1.0";` and add below the `CHECK_POLICY` block (after line ~988):

```js
// Layered scoring (3.1.0): Mastery = essential pool on a FIXED denominator so
// percentages are comparable across every site; Capability = the whole rubric
// (absolute points / 108) shown on a /100 basis, used for board ranking.
// Rationale + data: docs/superpowers/specs/2026-09-05-scoring-scope-findings.md
export function layeredScores(checks, poolBudget = POOL_BUDGET) {
  const capMax = Object.values(poolBudget).reduce((a, b) => a + b, 0); // 108
  let masteryEarned = 0, masteryMax = 0;
  for (const c of checks) {
    if (c.pool !== "essential" || c.points === null) continue;
    masteryEarned += c.points;
    masteryMax += c.max;
  }
  const masteryPct = masteryMax > 0 ? Math.round((masteryEarned / masteryMax) * 100) : 0;
  const capPct = capMax > 0 ? Math.round((masteryMax === 0 ? 0 : (masteryEarned / capMax) * 100)) : 0;
  const grade = masteryPct >= 85 ? "A" : masteryPct >= 70 ? "B" : masteryPct >= 50 ? "C" : masteryPct >= 30 ? "D" : "F";
  return { masteryEarned, masteryMax, masteryPct, capPct, capMax, grade };
}
```

In the scoring loop (~line 1152–1167), after `score/scoreMax` are accumulated and **before** the existing `const grade = ...` / `const verdict = ...` lines, rebase them:

```js
  const L = layeredScores(checks);
  const grade = L.grade;
  const verdict =
    L.masteryPct >= 70 ? "Agent-ready. Agents can work with this site deliberately." :
    L.masteryPct >= 40 ? "Partially readable. Agents guess some of the time, fail the rest." :
                  "Opaque to agents. Every interaction is a screenshot-and-click gamble.";
```

(delete the old `const pct = ...` / `const grade = ...` / `const verdict = ...` trio; `pct` is no longer used — grep to confirm no other reference before deleting.)

Extend the report payload (line ~1167):

```js
  const report = { domain, score, scoreMax, grade, mastery: { earned: L.masteryEarned, max: L.masteryMax, pct: L.masteryPct }, capPct: L.capPct, capMax: L.capMax, verdict, checks, tool_surface_hash, rules_version: RULES_VERSION, scoring_version: SCORING_VERSION, percentile: benchmarkPercentile(score), benchmark_version: BENCHMARK_VERSION, scannedAt: new Date().toISOString(), cached: false };
```

- [ ] **Step 4: Run the new suite and the full offline suite**

Run: `node tests/scoring-layered.test.mjs && npm test 2>&1 | tail -3`
Expected: layered suite all pass; existing suites — **the grade expectations inside existing suites may shift** where a fixture had surface checks n/a (mastery-based grade is ≥ the old grade). Fix fixtures by updating the expected grade to the mastery-based value; never by weakening the assertion.

- [ ] **Step 5: Commit**

```bash
git add worker.js tests/scoring-layered.test.mjs
git commit -m "feat(scoring): 3.1.0 - layered mastery (fixed 86) + capability (/100)"
```

---

### Task 2: Report page — capability /100 hero + mastery line + legacy fallback

**Files:**
- Modify: `toolfront/public/report.html` (hero block ~line 1610–1640, gradechip ~line 980, `LANGS` en block ~line 598 / zh block ~line 669)
- Test: `toolfront/tests/report-dom.test.mjs`

**Interfaces:**
- Consumes: `r.mastery {earned,max,pct}` and `r.capPct` from Task 1 (feature-detected: old cached reports lack them → legacy rendering).
- Produces: i18n keys `report.mastery` (EN+ZH), `report.cap.label` (EN+ZH).

- [ ] **Step 1: Add the dictionary keys**

In `report.html`, in the **en** block next to `'report.compare'` (line ~598):

```js
'report.mastery': 'Mastery {pct}% — core fundamentals {e}/{m}', 'report.cap.label': 'Capability score across the full 108-point rubric, shown out of 100',
```

In the **zh** block next to `'nav.scanner': '扫描器'` (line ~669):

```js
'report.mastery': '掌握度 {pct}%——基础面 {e}/{m}', 'report.cap.label': '能力总分按整套 108 分评测折算为百分制',
```

- [ ] **Step 2: Rework the hero (line ~1616–1626)**

Replace the `scoreNum`/`of` construction:

```js
    var hasLayers = !!(r.mastery && typeof r.capPct === "number");
    var scoreEl = el('span', null, String(hasLayers ? r.capPct : r.score));
    scoreEl.id = 'scoreNum';
    var score = el('div', 'score');
    score.appendChild(scoreEl);
    score.appendChild(el('span', 'of', hasLayers ? ' / 100' : ' / ' + ((typeof r.scoreMax === 'number' && r.scoreMax > 0) ? r.scoreMax : 100)));
```

And after the existing `pct-line` append (line ~1637), add the mastery line:

```js
    if (hasLayers) nums.appendChild(el('div', 'pct-line', t('report.mastery').replace('{pct}', String(r.mastery.pct)).replace('{e}', String(r.mastery.earned)).replace('{m}', String(r.mastery.max))));
```

- [ ] **Step 3: Update the top gradechip (line ~980)**

```js
      var pctBase = (r.capPct != null) ? r.capPct : Math.round(r.score / sm * 100);
      var chip = el('span', 'gradechip ' + cls(r.score), r.grade + ' · ' + ((r.capPct != null) ? r.capPct + '/100' : r.score + '/' + sm) + ' · ' + pctBase + '%');
```

- [ ] **Step 4: Update report-dom.test.mjs**

In the wired fixture (it already inlines common.js + runtime.js), extend the fixture report body with `mastery: {earned: 86, max: 86, pct: 100}, capPct: 94` and add:

```js
  ok("hero shows capability /100", (doc.querySelector("#scoreNum") || {}).textContent === "94");
  ok("mastery line renders", /掌握度|Mastery/.test((doc.querySelector(".pct-line:last-of-type") || {}).textContent || ""));
```

Also add a **legacy fallback** JSDOM case: same page, fixture report **without** `mastery`/`capPct` → hero must show the raw `score / scoreMax` (feature detection works).

- [ ] **Step 5: Run and verify in the browser**

Run: `npm test 2>&1 | tail -3` (all green), then open `http://localhost:8788/report?domain=toolfront.dev&lang=en` and `?lang=zh` — hero shows `94 / 100` (toolfront.dev: score 102 → round(102/108*100)=94), mastery line `Mastery 100% — core fundamentals 86/86` / `掌握度 100%——基础面 86/86`.

- [ ] **Step 6: Commit**

```bash
git add public/report.html tests/report-dom.test.mjs
git commit -m "feat(report): capability /100 hero + mastery line, legacy fallback"
```

---

### Task 3: Rankings board (toolfront) — /100 display + grade-letter filter

**Files:**
- Modify: `toolfront/public/rankings.html` (score cell rendering, filter predicates at lines ~215–217)

**Interfaces:**
- Consumes: monitor rankings API rows `{domain, score, grade, scanned_at}` (unchanged — `score` stays absolute).
- Produces: `cap100(score)` helper = `Math.round(score / 108 * 100)` displayed in the score cell; grade filter switches to matching the stored grade letter.

- [ ] **Step 1: Add the conversion helper next to `t()` (line ~158)**

```js
// Rubric total (essential 86 + surface 14 + emerging 8). The API returns the
// absolute score; the board displays it on a /100 basis like the report page.
const RUBRIC_TOTAL = 108;
const cap100 = (s) => Math.round((Number(s) || 0) / RUBRIC_TOTAL * 100);
```

- [ ] **Step 2: Replace the grade filter predicates (lines ~215–217)**

```js
    if(fGra==='A-B')return r.grade==='A'||r.grade==='B';
    if(fGra==='C')return r.grade==='C';
    if(fGra==='D-F')return r.grade==='D'||r.grade==='F';
```

(The previous raw-score thresholds `r.score>=70` encoded the OLD grade basis; the stored grade is now mastery-based, so filter by the letter — one source of truth.)

- [ ] **Step 3: Render the score cell as /100**

Find the row-building code that outputs `r.score` into `.score-cell .n` and wrap it:

```js
'<span class="n">' + cap100(r.score) + '</span>'
```

and extend the grade tooltip/small text to show the absolute too:

```js
'<span class="g">' + r.grade + ' · ' + r.score + '/108</span>'
```

- [ ] **Step 4: Browser-verify**

`npm test` green, then open `http://localhost:8788/rankings?lang=en` and `?lang=zh`: cells show `0–100` numbers, the D-F/A-B/C filters return the right rows (grade-letter based), 390px viewport no overflow.

- [ ] **Step 5: Commit**

```bash
git add public/rankings.html
git commit -m "feat(rankings): /100 capability display + grade-letter filter"
```

---

### Task 4: Monitor repo — panel and monitor /rankings page display parity

**Files:**
- Modify: `toolfront-monitor/src/monitor-pages.ts` (monitor `/rankings` page score cells ~line 955–970; panel score displays using `.score-big` ~line 331 — grep all raw-`score` renderings)

**Interfaces:**
- Consumes: same rows from `scan_reports` (absolute `score`).
- Produces: identical `/100` display convention on both sites.

- [ ] **Step 1: Locate every raw-score rendering**

Run: `grep -n "score" src/monitor-pages.ts | grep -vE "kind\.|col\.|CSS|font" | sed -n '1,20p'`
Each hit that renders a scan score into user-visible markup gets the same conversion:

```ts
const cap100 = (s: number): number => Math.round((s || 0) / 108 * 100); // rubric total 108
```

- [ ] **Step 2: Apply to the monitor /rankings table and panel widgets**

Score cells render `cap100(row.score)`; keep the absolute in a `title` attribute (`title={row.score + '/108'}`) so power users can still see it. Panel history sparklines stay absolute (they compare like-with-like).

- [ ] **Step 3: Update monitor tests**

`tests/rankings.test.mjs`: add an assertion that the rendered page contains the /100 value for a known fixture score (e.g. score 102 → `94`), and that the absolute appears in `title="102/108"`.

- [ ] **Step 4: Run and commit**

```bash
npm run check && npm test
git add src/monitor-pages.ts tests/rankings.test.mjs
git commit -m "feat(panel): /100 capability display parity with the scanner site"
```

---

### Task 5: Methodology page — document the two metrics

**Files:**
- Modify: `toolfront/public/methodology.html` (EN + ZH `<div class="en">` / `<div class="zh">` blocks; the page has no i18n mechanism — it is static side-by-side)

**Interfaces:**
- Consumes: nothing (static copy). Must state the SAME thresholds as the engine (85/70/50/30 on mastery).

- [ ] **Step 1: Add a "How the score is built" section to both language blocks**

EN (place after the existing pools/weights section):

```html
<h2>Mastery and capability</h2>
<p>Every site is graded on the same mandatory core: the <strong>essential pool (86 points)</strong>. Your <strong>mastery</strong> is the share of that core you earn — it alone decides your grade (A ≥ 85%, B ≥ 70%, C ≥ 50%, D ≥ 30%). Checks that cannot apply to your site are excluded, never penalised. On top of the core, <strong>capability</strong> measures how much of the full 108-point rubric — including the tool surface (WebMCP, API error format) — you have made real. Two sites with the same mastery can rank differently on the board: the one that also built a tool surface has the higher capability.</p>
```

ZH:

```html
<h2>掌握度与能力总分</h2>
<p>所有网站都考同一套<strong>必考核心（86 分）</strong>。<strong>掌握度</strong>是你在核心卷上的得分率——它单独决定等级（A ≥ 85%、B ≥ 70%、C ≥ 50%、D ≥ 30%）。对你的站点无法适用的检查项会被剔除，绝不因此扣分。在核心卷之上，<strong>能力总分</strong>衡量你把整套 108 分评测——包括工具面（WebMCP、API 报错格式）——落地了多少。掌握度相同的两个站，榜单排名可能不同：把工具面做出来的那个，能力总分更高。</p>
```

- [ ] **Step 2: Verify parity + commit**

Run the section-parity check used in the privacy audit:

```bash
python3 -c "
import re
s=open('public/methodology.html',encoding='utf-8').read()
en=re.search(r'class=\"en\">([\s\S]*?)<div class=\"zh\">', s).group(1)
zh=re.search(r'class=\"zh\">([\s\S]*)$', s).group(1)
print('h2 EN', len(re.findall(r'<h2>', en)), '/ ZH', len(re.findall(r'<h2>', zh)))"
```

Expected: equal counts. Then:

```bash
git add public/methodology.html
git commit -m "docs(methodology): mastery vs capability - the two-metric model"
```

---

### Task 6: Gates, preview, ship

**Files:** none new — verification only.

- [ ] **Step 1: Full gate pass on both repos**

```bash
# toolfront (port 8788 dev running, branch with all tasks merged)
npm test                                   # all suites green
node skills/precommit-ui-regression/scripts/secret-scan.mjs
node skills/precommit-ui-regression/scripts/regression.mjs --url http://localhost:8788 --out /tmp/gate-scoring
node skills/precommit-ui-regression/scripts/i18n-audit.mjs --url http://localhost:8788
# monitor
node ../toolfront/skills/precommit-ui-regression/scripts/secret-scan.mjs
```

Expected: every gate green.

- [ ] **Step 2: Local preview for user confirmation**

Present `http://localhost:8788/report?domain=toolfront.dev&lang=zh` and `http://localhost:8788/rankings?lang=zh`. **Do not deploy until the user confirms** (standing rule).

- [ ] **Step 3: Deploy after confirmation**

```bash
git push -u origin <branch> && gh pr create ...   # user merges
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  CI=true node node_modules/wrangler/bin/wrangler.js deploy
```

Live-verify: `/report?domain=toolfront.dev` hero shows `94 / 100` + `掌握度 100%` line; `scoring_version: "3.1.0"` in the API payload; board cells ≤ 100.

---

## Self-Review

**1. Spec coverage (findings ledger → tasks):**
- F-1 variable denominator by design → documented, not "fixed" (Task 5 explains it stays for n/a fairness)
- F-2 no-tool-surface A inflation → addressed by splitting mastery (fair grade) from capability (board rank): Task 1 + Task 3
- F-3 "102/102 reads as >100" → hero now `x / 100`: Task 2
- Competitor benchmark conclusion (fixed denominator convention, no copying) → /100 display basis: Tasks 2–4
- User's "考题范围没有统一" → mastery denominator is fixed at 86 for every site: Task 1
No gaps found.

**2. Placeholder scan:** All code blocks are concrete; the only "locate-then-edit" steps (Task 4 Step 1) include the exact grep and the exact conversion function to apply. No TBD/TODO.

**3. Type consistency:** `layeredScores(checks, poolBudget)` → `{masteryEarned, masteryMax, masteryPct, capPct, capMax, grade}` — used identically in Task 1 payload, Task 2 feature-detect (`r.mastery.pct`, `r.capPct`), Task 3 helper (`cap100`, standalone). Report payload key `mastery` matches Task 2's `r.mastery.earned/max/pct`. `SCORING_VERSION` "3.1.0" set once (Task 1) and asserted in Task 6 live-verify. ✔

One deliberate carry-over: `scan_history.grade` rows written before this change keep their 3.0.0 semantics; the board is empty today (verified `count: 0`), and per-domain history in the report page shows both — acceptable transient, no backfill.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-layered-scoring.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
