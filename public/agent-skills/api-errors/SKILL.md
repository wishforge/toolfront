---
name: api-errors
description: Make unknown/failed API paths return structured JSON errors with correct status codes instead of HTML, so agents can react programmatically. Use when a ToolFront scan reports api-errors as partial or fail, or when asked to "fix API error responses".
license: MIT
compatibility: Requires control of the API/framework error handling.
metadata:
  author: ToolFront
  scanner-check: api-errors
  scanner-points: 6
---

# Machine-readable API error responses

Agents probing your API need failures in JSON with the right status
code. HTML 404 pages force them to guess.

This skill implements the fix for the `api-errors` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `api-errors` as `partial` (some paths
  return JSON, others HTML) or `fail` (HTML everywhere)

## Requirements (what the scanner verifies)

- Unknown API paths return a JSON body with a 4xx status
- Error bodies are stable and parseable (not HTML error pages)
- No stack traces or internal details in the response

## Scope contract — read this first

- Never return 200 with an error body — agents treat 200 as success.
- Do not disable auth checks to make probes pass.

## Instructions

1. Add a JSON error handler for unmatched API routes (framework-level
   404/405 handler scoped to your API prefix):

```json
{ "error": "not_found", "detail": "Unknown API path" }
```

2. Keep status codes semantic: 404 unknown path, 405 wrong method,
   400 bad input, 401/403 auth.
3. Include a `detail` string — agents use it to self-correct.

## Verification

Probe a random unknown API path and confirm JSON + 4xx. Wait for
`api-errors -> pass` in the next ToolFront scan.
