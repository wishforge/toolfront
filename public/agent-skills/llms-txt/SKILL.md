---
name: llms-txt
description: Create an llms.txt file so language-model clients learn what a site does from its own words. Use when a ToolFront scan reports llms-txt as fail or partial, when a site has no /llms.txt, or when asked to "add llms.txt", "make the site readable to AI", or "publish a site summary for agents".
license: MIT
compatibility: Requires write access to the website source and deploy ability for the site root.
metadata:
  author: ToolFront
  scanner-check: llms-txt
  scanner-points: 10
---

# Create an llms.txt

Publish a one-page markdown summary of the site so language-model
clients can learn what you do from your own words, not from a guess.

This skill implements the fix for the `llms-txt` check in the ToolFront
agent-readiness scanner (https://toolfront.dev). It is the cheapest
agent-readiness win available: one markdown file at the site root.

## When to use

- A ToolFront scan report lists `llms-txt` as `fail` (no /llms.txt) or
  `partial`
- The user asks to add an llms.txt / make the site self-describing for
  AI agents / publish a site guide for language models

## Requirements (what the scanner verifies)

- `/llms.txt` is served at the site root with HTTP 200
- Markdown with a `#` title, a one-sentence summary, and a bullet list
  of key pages with link descriptions
- Keep it under a few hundred lines: a reading list, not a dump

## Scope contract — read this first

- Only add or edit `/llms.txt` (and, if missing, nothing else) in the
  site source the user identifies.
- Show the file content and get explicit user confirmation before
  writing.
- Never overwrite an existing llms.txt without showing the diff first.
- Never create this file for a site the user does not own.

## Instructions

1. Find where the site root file is served from in the user's source
   (public/, static/, dist root, or a route handler).
2. Build the file with this structure:

```markdown
# SITE NAME

> ONE-SENTENCE summary: what the site is and who it is for.

## Start here
- [Homepage](https://DOMAIN/): what we do and who it is for.

## Site guide
- [robots.txt](https://DOMAIN/robots.txt): crawler policy (AI + all).
- [sitemap.xml](https://DOMAIN/sitemap.xml): every public page,
  machine-readable.
```

3. Use the site's real name from the user (or its homepage title); do
   not invent one. Ask if unsure.
4. List the 5-15 most important pages (products, docs, pricing,
   categories) each on one line with a short link description.
5. Run the verification step below.

## Verification

```
node skills/llms-txt/scripts/validate.mjs --domain YOUR-DOMAIN.com
```

Wait for `llms-txt -> pass`. Note: verification hits the LIVE site —
the file must be deployed, not only created locally.
