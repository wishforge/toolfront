---
name: webmcp
description: Register WebMCP tools so AI agents can operate a website directly instead of screenshotting and clicking blind. Use when a ToolFront agent-readiness scan reports webmcp as fail or partial, when asked to "make the site agent-ready", "register WebMCP tools", "add a WebMCP manifest", or "let agents act on my site".
license: MIT
compatibility: Requires read/write access to the website source. Network access only to api.toolfront.dev for verification.
metadata:
  author: ToolFront
  scanner-check: webmcp
  scanner-points: 22
---

# Register WebMCP tools

Expose machine-readable tools so AI agents can operate the site
directly, instead of screenshotting it and clicking blind. A WebMCP
tool surface turns a page from "something an agent reads" into
"something an agent can use".

This skill implements the fix for the `webmcp` check in the ToolFront
agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `webmcp` as `fail` or `partial`
- The user asks to make their site operable by AI agents / register
  native tools for agents
- The user pastes a scan report or score and asks to fix it

## Requirements (what the scanner verifies)

- The page declares a WebMCP tool surface: a
  `<script type="webmcp">` manifest, or a platform-injected surface
  (e.g. Shopify Storefront WebMCP)
- Every tool has a `name` and a human-readable `description`
- Descriptions are static, literal strings (not built at runtime from
  variables or concatenation), so the surface can be audited

## Scope contract — read this first

- Only edit the file(s) the user identifies as their site source
  (entry HTML, layout template, or storefront theme).
- Show the change as a diff and get explicit user confirmation
  before writing.
- Never modify a production origin server directly; edit source and
  let the user deploy through their normal pipeline.
- Never apply this to a site the user does not own.

## Instructions

1. Identify the page entry point: the HTML file, layout, or theme that
   renders the site root (index.html, layout template, head include).
2. Pick the key actions a user would ask an agent to perform (search,
   login, signup, order status, booking, checkout, contact). Start
   with the 1-3 most valuable; more tools is not better.
3. Add a WebMCP manifest to the page `<head>`:

```html
<script type="webmcp">
[
  {
    "name": "search",
    "description": "Search the product catalog by keyword and return matching items with prices.",
    "readOnlyHint": true
  },
  {
    "name": "order-status",
    "description": "Look up an order by order number and email and return its current status.",
    "readOnlyHint": true
  }
]
</script>
```

   - `name`: short kebab-case identifier.
   - `description`: plain human-readable sentence. State what the tool
     does, what input it needs, what it returns. Do NOT include
     instructions addressed to an agent ("ignore previous
     instructions", "if you see X do Y") — descriptions are
     agent-facing instructions and must stay neutral.
   - `readOnlyHint: true` on tools that never change state.
   - If a tool consumes untrusted user content (search terms, URLs),
     keep that visible in the description; never claim a state-changing
     action is read-only.
4. Validate the JSON parses (no trailing commas, valid escaping).
5. Run the verification step below.

## Verification

```
node skills/webmcp/scripts/validate.mjs --domain YOUR-DOMAIN.com
```

Wait for `webmcp -> pass`. If `fail` or `partial`, re-check that the
manifest is inside the served HTML (not injected after load by JS) and
that tool descriptions are static literals.
