# Publish machine-readable surfaces

Give agents a map of your site and services: `sitemap.xml` for pages and
an OpenAPI spec for the API surface. Without them, an agent flips pages
like a human and anything it cannot reach does not exist.

## Requirements

- Serve `/sitemap.xml` with HTTP 200, using absolute URLs
- Serve an OpenAPI description (typically `/openapi.json`) with HTTP 200
- Include `operationId`s and request/response schemas in the OpenAPI
  spec so it is usable for tool calling

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "machine-surfaces").status` is
`"pass"`.
