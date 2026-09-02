---
name: machine-surfaces
description: Publish sitemap.xml and an OpenAPI description so agents have a machine-readable map of a site and its API. Use when a ToolFront scan reports machine-surfaces as fail or partial, or when asked to "add sitemap", "add OpenAPI", "publish an API spec", or "make the site machine-readable".
license: MIT
compatibility: Requires write access to the site source and to the API implementation or docs.
metadata:
  author: ToolFront
  scanner-check: machine-surfaces
  scanner-points: 19
---

# Publish machine-readable surfaces

Give agents a map of the site and its services: `sitemap.xml` for
pages and an OpenAPI spec for the API surface. Without them, an agent
flips pages like a human and anything it cannot reach does not exist.

This skill implements the fix for the `machine-surfaces` check in the
ToolFront agent-readiness scanner (https://toolfront.dev).

## When to use

- A ToolFront scan report lists `machine-surfaces` as `fail` (neither
  surface) or `partial` (one of the two)
- The user asks to add a sitemap or an OpenAPI spec

## Requirements (what the scanner verifies)

- `/sitemap.xml` served with HTTP 200, using absolute URLs
- An OpenAPI description (typically `/openapi.json`) served with
  HTTP 200
- `operationId`s and request/response schemas in the OpenAPI spec so
  it is usable for tool calling

## Scope contract — read this first

- Only add files the user confirms exist as their site's pages and API
  endpoints. Do not fabricate endpoints.
- Show what will be written and get explicit confirmation first.
- Never publish internal/private API endpoints in the OpenAPI spec —
  expose only what is safe for public use.
- Never add these files for a site the user does not own.

## Instructions

1. Sitemap: locate the site root source and add a valid sitemap listing
   real public URLs (absolute):
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     <url><loc>https://DOMAIN/</loc></url>
     <url><loc>https://DOMAIN/pricing</loc></url>
   </urlset>
   ```
   Every URL must be a page that actually exists on the site.
2. OpenAPI: ask the user which public API endpoints exist and their
   methods. Build an OpenAPI 3.1 document. Every operation needs a
   unique `operationId`, parameter schemas, and response schemas. A
   minimal valid skeleton:
   ```json
   {
     "openapi": "3.1.0",
     "info": { "title": "API NAME", "version": "1.0" },
     "paths": {
       "/endpoint": {
         "get": {
           "operationId": "listThing",
           "responses": { "200": { "description": "ok" } }
         }
       }
     }
   }
   ```
3. Do not invent endpoints: confirm each one with the user and against
   the real API. An OpenAPI spec describing endpoints that do not exist
   misleads agents worse than no spec at all.
4. Validate JSON and XML syntax before finishing.
5. Run the verification step below.

## Verification

```
node skills/machine-surfaces/scripts/validate.mjs --domain YOUR-DOMAIN.com
```

Wait for `machine-surfaces -> pass` (needs BOTH sitemap.xml and an
OpenAPI spec).
