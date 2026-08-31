---
name: precommit-ui-regression
description: Pre-commit dual gate for the ToolFront repo. ① secret-scan.mjs detects secrets in pending files (API keys, tokens, private keys, connection strings, real Cloudflare KV ids, sensitive filenames) and exits 1 to block the commit. ② regression.mjs runs multi-viewport UI regression (no horizontal overflow, key elements, scan -> finding cards, Apply fix interaction, i18n roundtrip). Run both before every commit and PR push. Triggers: pre-commit check, run regression, commit gate, secret scan, pre-push verification.
agent_created: true
---

# Pre-commit UI Regression + Secret Scan

## Overview

Run two gates before committing or pushing a PR. **The commit is only allowed when BOTH pass:**

1. **secret-scan.mjs** — scans all pending files in the working tree (modified tracked files + untracked new files) for secrets: API keys, tokens, private keys, credentialed connection strings, real Cloudflare KV/D1 ids, and sensitive filenames. Any hit exits 1 and blocks the commit.
2. **regression.mjs** — multi-viewport UI regression (desktop / tablet / mobile) to verify frontend changes did not break layout or core interactions.

## When to use

- User says "pre-commit check", "run regression", "commit gate", or asks to verify before committing/pushing (in any language)
- After ANY change (frontend / logic / config) and before committing — **mandatory for UI changes and for changes touching config files (wrangler.toml / .dev.vars / .env-like)**
- Community PR flow: contributors should self-check with the same process

## Steps

### 0. Run secret scan first (most important, prevents leaks)

```bash
/Users/david/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  skills/precommit-ui-regression/scripts/secret-scan.mjs
```

- Auto-collects pending files: git modified + staged + untracked (`??`)
- Detects: AWS / OpenAI / GitHub / Slack key prefixes, private key blocks, credentialed connection strings, JWTs, sensitive filenames (`.env*`, `.dev.vars`, `.pem`, `id_rsa`, `credentials.json`), and **32-hex real KV/D1/account ids in wrangler.toml** (comments and REQUIRED/placeholder values excluded)
- exit 0 = clean; exit 1 = hit found, **commit blocked** — remove the secret and use env vars / local .dev.vars
- Low-confidence items (generic password / api_key fields) are reported but do not fail unless `--strict` is passed

### 1. Make sure the dev server is running

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8788/
```

- `200` -> continue
- Not running -> start it first (from the toolfront project dir: `npx wrangler dev --port 8788 --local`, run in background)

### 2. Run the UI regression

```bash
NODE_PATH=/Users/david/.workbuddy/binaries/node/workspace/node_modules \
  /Users/david/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  skills/precommit-ui-regression/scripts/regression.mjs \
  --url http://localhost:8788 \
  --domain example.com
```

The script:
- Auto-discovers the local Chromium (agent-browser cache, no download needed)
- Runs 4 viewports (1280 desktop / 768 tablet / 390 phone / 375 smallest) — checks no horizontal overflow + key elements + screenshots
- Scans the given domain per viewport -> checks finding cards render (>= 3)
- Interaction: clicks Apply fix -> verifies done state toggles
- i18n roundtrip: EN -> ZH -> EN (h1 changes and reverts)
- exit 0 = pass, 1 = fail; screenshots saved to /tmp/ui-regression-shots/

### 3. Interpret results

- secret-scan prints `✓ No secrets found` AND regression prints `TOTAL: N PASS: N FAIL: 0` -> both pass, safe to commit
- Any FAIL -> **do not commit**, fix first. Distinguish real bugs from over-strict assertions (e.g. when the i18n assertion does not match the Chinese h1 copy, check whether the assertion itself is too narrow before treating it as a bug)

### 4. Custom UI checks (optional)

The script checks `nav` / hero / footer by default. Pass project-specific elements via `--custom-checks` JSON:

```bash
--custom-checks '[{"name":"report-card in viewport","selector":".report-card"}]'
```

## Environment notes

- playwright-core lives at `/Users/david/.workbuddy/binaries/node/workspace/node_modules/` (point NODE_PATH at it)
- Chromium uses the agent-browser headless shell (latest auto-discovered); **do NOT** `npx playwright install` (downloads a new browser and may fail)
- If auto-discovery fails, set `CHROMIUM_PATH` to the chromium executable

## Relationship to other flows

- This skill is the **pre-commit dual gate**, complementing ToolFront's GitHub branch protection (CI also runs `npm test`)
- Frontend UI changes follow: local preview (present_files with localhost) -> user confirms -> secret-scan -> UI regression -> commit -> push PR
- PR merging stays manual (user merges on GitHub, never auto-merge)
