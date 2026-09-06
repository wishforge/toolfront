---
name: freshness
description: Add machine-readable last-modified signals (JSON-LD dateModified, OG article:modified_time) so AI systems can tell how recent your content is. Use when a ToolFront scan reports freshness as fail or partial, or when asked to "fix content freshness", "add dateModified", or "make AI see my update time".
license: MIT
compatibility: Requires write access to page templates and deploy ability.
metadata:
  author: ToolFront
  scanner-check: freshness
  scanner-points: 12
---

# Add content freshness signals

AI systems prefer fresh content but cannot guess how old a page is.
Publish the last-modified date in a machine-readable form.

This skill implements the fix for the `freshness` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `freshness` as `fail` (no signals) or
  `partial` (incomplete signals)

## Requirements (what the scanner verifies)

- JSON-LD `dateModified` on the page, or `<meta property="article:modified_time">`
- The date must be real — do not fake freshness; agents cross-check content

## Scope contract — read this first

- Never stamp a date newer than the actual content change. Faked freshness
  is a trust violation the scanner cannot see but users can.

## Instructions

1. Locate the page template (layout, head partial, or CMS output).
2. Add one of:

```html
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "WebSite",
  "dateModified": "2026-09-05" }
</script>
```

   or (for articles):

```html
<meta property="article:modified_time" content="2026-09-05T08:00:00Z">
```

3. Wire the value to the real last-modified date (build time, CMS field,
   or git commit date) so it updates itself.

## Verification

Re-scan the domain with ToolFront and wait for `freshness -> pass`.
