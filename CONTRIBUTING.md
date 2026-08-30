# Contributing to ToolFront

Thanks for helping make the web more agent-readable. This project is maintained
by one person, so the bar is: **make the machines do the checking, and keep the
human review to semantics.** Everything below exists to make that possible.

## What can be contributed

| Change type | How |
|-------------|-----|
| New / changed **scan rules** | PR touching ONLY `rules/poisoning.json` (+ samples in `tests/rules-samples.json`). See below. |
| Engine, scanner, website code | Open an issue first. Code PRs without a matching issue may be closed. |
| Docs, README, typos | PR directly — docs-only PRs auto-merge after CI passes. |

## Rule contributions — the mandatory sample policy

> **A rule PR must extend `tests/rules-samples.json` with at least one
> TRUE-positive sample (your rule must fire on it) and the full benign corpus
> must stay clean. PRs without samples are closed automatically by CI, not
> reviewed.**

`rules/poisoning.json` is the only file a rule PR may change. It is compiled
through four fail-closed gates before anything else happens:

1. **JSON schema** — whitelisted fields, `type ∈ {regex, length-over, executor}`,
   `severity ∈ 1..3`, kebab-case id `^[a-z0-9-]{3,40}$`, unique.
2. **Compile whitelist** — regex flags limited to `i`/`u` (no stateful flags);
   executors are whitelist-only (`decodeFindings`); no code ships in JSON.
3. **Dynamic ReDoS probe** — your regex is fed adversarial inputs (generated
   from its own literal alphabet) and timed. Exponential or super-linear
   behavior above budget is rejected. This is empirical, not a lint.
4. **Differential samples** — your rule must hit every sample it declares and
   zero of the 5 benign tools.

A green gate still requires maintainer approval — the machine proves the rule
is *safe and effective*, a human judges whether it *should exist*.

## Local checks before opening a PR

```bash
npm ci
npm run build:rules          # regenerate rules/poisoning.mjs after JSON edits
node scripts/rules-gate.mjs  # the four gates, locally
npm test                     # full offline suite
```

CI runs the same things (`Offline suites` + `Rules gate` jobs) and `main` is
protected: if CI is red, the PR cannot merge.

## License

Contributions are licensed under Apache-2.0 (no CLA required).
