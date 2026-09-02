---
name: robots-policy
description: State which AI crawlers are welcome in robots.txt and stop turning away retrieval agents that cite and link back. Use when a ToolFront scan reports robots-policy as partial or fail, when robots.txt names no AI crawlers, or when asked to "fix robots.txt for AI", "allow AI crawlers", or "set an AI crawler policy".
license: MIT
compatibility: Requires write access to the robots.txt source and deploy ability.
metadata:
  author: ToolFront
  scanner-check: robots-policy
  scanner-points: 22
---

# Fix the AI crawler policy

State which AI crawlers are welcome in `robots.txt`, and stop turning
away the ones that cite and link back to you. A single catch-all rule
cannot express "welcome retrieval agents, block training scrapers".

This skill implements the fix for the `robots-policy` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `robots-policy` as `partial` (robots.txt
  exists but names no AI crawlers) or `fail` (AI crawlers blocked)
- The user asks to set an AI crawler policy or unblock AI agents

## Requirements (what the scanner verifies)

- `/robots.txt` served as text with HTTP 200
- AI crawlers the site wants to be cited by are named in explicit
  `User-agent` groups and NOT `Disallow: /`
- If training scrapers are blocked, it is done with a named group, not
  a blanket `User-agent: *` block

## Scope contract — read this first

- Only edit the robots.txt file in the user's source. Never remove a
  security-motivated disallow (e.g. `/admin`) to game the score.
- Show the diff and get explicit user confirmation before writing.
- Never change robots.txt for a site the user does not own.

## Instructions

1. Locate robots.txt in the source (public/robots.txt, or a route /
   middleware that serves it).
2. Review the current file. Keep every legitimate privacy/security
   rule (`/admin`, `/private`, payment paths). This fix ONLY adjusts
   AI-crawler policy.
3. Add named groups for the crawlers the site wants to welcome (choose
   the ones relevant to the site):

```text
User-agent: GPTBot
Disallow:

User-agent: ClaudeBot
Disallow:

User-agent: Claude-Web
Disallow:

User-agent: CCBot
Disallow:

User-agent: Google-Extended
Disallow:

User-agent: PerplexityBot
Disallow:

User-agent: Applebot-Extended
Disallow:

User-agent: OAI-SearchBot
Disallow:
```

   `Disallow:` (empty) = allowed. Keep existing groups intact.
4. If the site wants to block training scrapers, do it per-bot (e.g.
   `User-agent: GPTBot` with `Disallow: /`), and tell the user the
   trade-off: GPTBot is also a retrieval/citation bot for many
   engines. Never use `User-agent: *` with `Disallow: /` — it also
   blocks the scanners and retrieval bots that cite the site.
5. Run the verification step below.

## Verification

```
node skills/robots-policy/scripts/validate.mjs --domain YOUR-DOMAIN.com
```

Wait for `robots-policy -> pass`. The report card shows the exact
wording: "Explicit policy for X, Y, Z — allowed."
