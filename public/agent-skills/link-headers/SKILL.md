---
name: link-headers
description: Add RFC 8288 Link response headers with agent-useful relation types (api-catalog, service-doc, describedby) so agents discover resources at request time. Use when a ToolFront scan reports link-headers as partial or fail, or when asked to "add Link headers for agents".
license: MIT
compatibility: Requires control of server response headers (origin config, edge worker, or framework headers API).
metadata:
  author: ToolFront
  scanner-check: link-headers
  scanner-points: 8
---

# Add Link response headers for agent discovery

Agents read `Link` response headers to discover machine-readable
resources without parsing HTML. Preload-only headers do not help them.

This skill implements the fix for the `link-headers` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `link-headers` as `partial` (Link headers
  present but no agent-useful relation types) or `fail` (absent)

## Requirements (what the scanner verifies)

- `Link` headers on the homepage response using registered or documented
  relation types useful to agents: `api-catalog`, `service-desc`,
  `service-doc`, `describedby`
- RFC 8288 format; RFC 9727 §3 relations where applicable

## Scope contract — read this first

- Only add headers for resources that actually exist. A dead `api-catalog`
  link is worse than none — agents retry and lose trust.

## Instructions

1. Find where response headers are set (server config, middleware, or
   framework headers API).
2. Add one header per resource, or a comma-separated list:

```text
Link: </.well-known/agent-skills/index.json>; rel="api-catalog"
Link: </docs/api>; rel="service-doc"
```

3. Verify each target URL returns 200 and is genuinely machine-readable.

## Verification

```
curl -sI https://YOUR-DOMAIN.com | grep -i '^link:'
```

Wait for `link-headers -> pass` in the next ToolFront scan.
