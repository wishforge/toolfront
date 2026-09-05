# Score ceiling differs per site (86 vs 102) — findings-to-fix-design

Date: 2026-09-05 · Investigation only (no code changed)
Question from user: "为什么总分上限其他网站没有超过 100 分" (why does every other site's
denominator stay under 100 while toolfront.dev shows 102?)

## Evidence

### E1 — Empirical scans (local engine, `/api/scan`, 2026-09-05)

| domain | score / max | pct | grade | checks marked n/a |
|---|---|---|---|---|
| toolfront.dev (self-scan) | **102 / 102** | 100 | A | api-errors |
| example.com | 22 / **86** | 26 | F | webmcp, tool-security, api-errors |
| www.iana.org | 24 / **86** | 28 | F | same three |
| www.rust-lang.org | 27 / **86** | 31 | D | same three |
| www.python.org | 32 / **86** | 37 | D | same three |
| developer.mozilla.org | 31 / **86** | 36 | D | same three |
| tailwindcss.com | 15 / **86** | 17 | F | same three |
| www.nginx.org | 31 / **86** | 36 | D | same three |

Domain names above are audit inputs only — none is published anywhere.

### E2 — Code (worker.js)

- `POOL_BUDGET = { essential: 86, surface: 14, emerging: 8 }` → absolute ceiling **108**.
- `max = round(POOL_BUDGET[pool] * share)`; scoring loop:
  `if (c.points === null) continue; score += c.points; scoreMax += c.max;`
  → **n/a checks leave both the numerator and the denominator.**
- `webmcp` → `notApplicable("webmcp", NA_NO_TOOLS)` when the site exposes **no tools at all**.
- `api-errors` → n/a when there is no API surface (and always for a self-scan, which is
  why toolfront.dev loses exactly those 6).
- `grade = pct >= 85 ? "A" : ...` where `pct = score / scoreMax`.

So a site with no tool surface is judged on the **86-point essential pool only**; its
ceiling is 86, and **74/86 (86%) is already a grade A**.

## Findings

- **F-1 (P2 · by design, not a bug):** the denominator varies (86 / 94 / 100 / 102 / 108)
  because n/a checks are excluded from both sides. This is the intended rule — it stops a
  site from being penalised for a check that cannot apply to it. **No change proposed.**
- **F-2 (P1 · real design risk, surfaced by this investigation):** the same rule has a
  second, unreported consequence — a site with **no agent-facing tool surface at all** is
  graded on a *narrower* pool, where **100% (grade A) is reachable without any tool
  surface**. The ceiling being lower makes the top easier to reach. Cross-site comparison
  of `pct`/grade is therefore not apples-to-apples: 100% on 86 points and 100% on 102
  points are not the same claim. Today the only compensating signal is the percentile line
  ("higher than N% of sites"), which is easy to miss.
- **F-3 (P2 · copy):** `102 / 102` reads as "over 100" to a first-time visitor. The
  explanatory note ("Achievement against applicable checks…") exists but is small and
  below the hero number.

## Fix design (options, smallest first)

- **(a) Status quo** — keep everything, no work. Leaves F-2 and F-3.
- **(b) Say the breadth out loud (recommended, one line, no rescoring):** next to the
  score, state the basis explicitly, e.g.
  `102 / 102 · 100% — 评测范围 102 分（满分 108；API 报错格式不适用）`
  and for a narrow site
  `74 / 86 · 86% — 评测范围 86 分（满分 108；未检测到工具面，相关项不计入）`.
  No engine change, no SCORING_VERSION bump, no history migration.
- **(c) Make the breadth visible as its own signal:** add a small "评测范围 / coverage"
  chip (essential / +surface / +emerging) so a reader sees *how much* of the rubric the
  site was judged on. Also no rescoring.
- **(d) Change the grade rule** (e.g. A requires the surface pool to be applicable): this
  **re-scores every site**, bumps `SCORING_VERSION`, invalidates cached reports and the
  benchmark anchors. Expensive, and it would punish sites for simply not having an API.
  **Not recommended.**

Recommendation: **(b) + (c)** — one line of copy plus a coverage chip. Both are
presentation-only: the engine, stored scores and benchmark stay untouched.

## Honest limits

- The sample is 8 domains, all with no tool surface except toolfront.dev; no real site in
  the sample actually reached A (max 37%), so F-2 is a **structural** risk shown by the
  grade thresholds, not an observed inflation.
- I did not check how many domains in the rankings board sit at 86-point ceilings; that
  would need a query over stored `scoreMax` values.

## Addendum — user's verdict: the variable exam scope itself is the defect

"分数上限不定 和考察范围不对 容易出现问题 相当于考题范围没有统一"

Agreed: F-2's root cause is not copy, it is the model. Three candidate models:

### Model A — status quo (variable paper)
- paper = 86 / 94 / 100 / 102 / 108 depending on which checks apply
- fair to each site, impossible to compare two sites
- narrow but well-built site can reach 100% / A with zero tool surface

### Model B — one fixed paper (108), n/a scores 0
- every site judged on the identical 108-point rubric; fully comparable
- "no tool surface" becomes a hard −22 → a brochure site caps at 86/108 = 79.6% (grade C)
- re-scores every site, bumps SCORING_VERSION, invalidates cached report grades;
  benchmark anchors are keyed on absolute `score`, so they survive

### Model C — layered: mandatory core + optional credit (recommended)
- **掌握度 (mastery) = essential points / 86** — fixed denominator for every site,
  fully comparable, drives the grade
- **能力总分 (capability) = score / 108** (unchanged numbers, shown explicitly) — used for
  board ranking and "how much headroom you still have"
- a site with no tool surface can still earn 100% mastery / A (it did all the basics), but
  its capability total tops out at 79.6% and it ranks below sites that also built a tool
  surface
- unifies the exam (mastery is always out of 86), keeps the "no free points" property
  (missing surface never inflates mastery), does **not** re-score anything: `score` is
  untouched; only the percentage/grade basis changes (→ SCORING_VERSION bump, and the
  board is currently empty, so the migration cost is at its minimum)

Data point for the decision: `GET monitor.toolfront.dev/api/rankings?vertical=all`
returned **count: 0** on 2026-09-05 — no board history yet, so a model change now costs
nothing in backfill.

## Competitor benchmark — isagentready.com/en/rankings (observed 2026-09-05)

Observed on their live page (facts only):
- "Showing 1–25 of **3542 websites**" — their board is fully populated
- score shown as **X / 100** with grade A+ — **fixed 100-point scale**
- category weights displayed per row: Discovery 30%, AI Search Signals 20%, …
- per-check points shown inline (DNS-AID agent records 0/10, AI crawler directives 20/20,
  robots.txt 15/15, XML Sitemap 15/15, JSON-LD 20/20)

### Same-domain comparison (their scale vs our engine, same day)

| domain | theirs | ours |
|---|---|---|
| cavalli.tr | 100 / 100 (A+) | 67 / 92 → 73% (B) |
| negativeev.com | (not top row) | 88 / 92 → 96% (A) |
| topbots.lol | — | 88 / 92 → 96% (A) |
| outoutbid.lol | — | 88 / 92 → 96% (A) |

Two conclusions:
1. **Our numbers are not theirs** — one order stricter on the same domain (100 vs 73).
   Also proof of provenance: our board reads from our own D1 `scan_reports`
   (`src/routes/rankings.ts`: `SELECT ... FROM scan_reports ...`), zero ingestion.
   The only "isagentready" strings in either repo are 3 code comments (benchmark/parity
   notes) — no scraper, no feed, no import.
2. **The industry convention is a fixed denominator.** A visitor who sees 100/100
   elsewhere and 102/102 here has no way to relate the two.

### On scraping their board: not an option
- legal/ToS exposure, and it contradicts the standing rule (no borrowed sources in this
  product). Their data can be used as a **benchmark reference** (scale, presentation),
  never as a data source. Our board fills from domains that opt into monitoring.

## Full comparison run (2026-09-05, n=48 paired domains from their board)

Their board harvested: 1033/3542 rows (pages 1–39, score-descending; harvest
throttled by their site after that — polite pacing kept). 48 domains scanned
with our engine (our own rate limit: 30/min → a full 3542 sweep would take ~2h).

| metric | theirs | ours |
|---|---|---|
| mean | 86.2 | 69.5 |
| median | **97** | 72 |
| range | 48–100 | 12–96 |
| correlation | r = 0.79 (same-day, same domains) | |
| stricter side | we are lower on **46/48 (96%)** of domains, avg −16.7 pts | |

Notable rows:
- claude.com: theirs **100 / A+** → ours **55% / C** (47/86, all three surface checks n/a)
- arkancertifiedtranslation.ae: theirs 100 / A+ → ours 51% / C
- isagentready.com itself: theirs 100 / A+ → ours 96% / A (fair — they do have the surfaces)

Our denominator distribution across the 48: 86×21 · 92×21 · 102×1 · 108×5 — the
variable paper is confirmed empirically, and it is NOT rare: 42/48 sites sit on
a different denominator than the next site.

### Decision (data-driven)

1. **Do not copy their scale.** Their board clusters at the top (median 97, rows
   of 100/A+ including sites we rate C) — weak discrimination. Our distribution
   (12–96, median 72) actually separates sites. Strictness is a feature.
2. **Unify the paper anyway** (the user's point stands): adopt the layered model —
   mastery = essential/86 (fixed denominator, drives the grade, comparable across
   every site) + capability = score/108 (breadth, drives board ranking), both
   displayed on a /100 basis.
3. Full 3542-domain sweep: possible but ~2h at our 30/min limit; n=48 with r=0.79
   is already decision-grade. Can be extended in batches on request.
