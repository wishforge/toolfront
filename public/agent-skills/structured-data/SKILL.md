---
name: structured-data
description: Give AI structured facts about a page — products, prices, reviews, organization — plus OpenGraph tags, instead of raw text to guess from. Use when a ToolFront scan reports structured-data as fail or partial, or when asked to "add structured data", "add JSON-LD", "fix schema markup", or "add og tags".
license: MIT
compatibility: Requires write access to page templates in the site source.
metadata:
  author: ToolFront
  scanner-check: structured-data
  scanner-points: 16
---

# Add structured data

Give AI structured facts about the page — prices, products, reviews,
and social previews — instead of forcing it to guess from raw text.

This skill implements the fix for the `structured-data` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `structured-data` as `fail` (no JSON-LD
  or OpenGraph) or `partial` (fragments only)
- The user asks to add JSON-LD / OpenGraph tags / schema markup

## Requirements (what the scanner verifies)

- At least 1 JSON-LD block
  (`<script type="application/ld+json">`); 3+ blocks is a full score
- `og:title` and `og:description` meta tags
- Prices and availability in `Offer`/`Product` schema so agents quote
  the site accurately

## Scope contract — read this first

- Only edit the page templates the user identifies (homepage, product,
  article layouts).
- Every price/offer must come from the user or the actual page content.
  Never invent prices, ratings, or facts to make the score pass — that
  poisons the data agents will quote.
- Show the diff and get explicit user confirmation before writing.
- Never edit a site the user does not own.

## Instructions

1. Identify the page template(s): homepage, product pages, article
   pages. Each page type gets its own appropriate schema.
2. Add OpenGraph tags to the shared head (once, not per page):
   ```html
   <meta property="og:title" content="SITE or PAGE TITLE">
   <meta property="og:description" content="One accurate sentence.">
   ```
3. Add JSON-LD blocks per page type. Homepage — organization + website:
   ```html
   <script type="application/ld+json">
   {"@context":"https://schema.org","@type":"Organization","name":"NAME","url":"https://DOMAIN/"}
   </script>
   <script type="application/ld+json">
   {"@context":"https://schema.org","@type":"WebSite","name":"NAME","url":"https://DOMAIN/"}
   </script>
   ```
   Product page — product with offer (price from the real price):
   ```html
   <script type="application/ld+json">
   {"@context":"https://schema.org","@type":"Product","name":"PRODUCT","offers":{"@type":"Offer","price":"REAL_PRICE","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
   </script>
   ```
   Article page — Article schema with the real title and date.
4. Keep the JSON valid (escape quotes, no trailing commas). Wrong JSON
   is worse than none — the block is counted but not parsed.
5. Run the verification step below.

## Verification

```
node skills/structured-data/scripts/validate.mjs --domain YOUR-DOMAIN.com
```

Wait for `structured-data -> pass`.
