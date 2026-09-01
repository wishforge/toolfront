# Register WebMCP tools

Expose machine-readable tools so AI agents can operate your site
directly, instead of screenshotting it and clicking blind. A WebMCP
manifest turns your page from "something an agent reads" into
"something an agent can use".

## Requirements

- Declare a WebMCP tool surface on the page (a `<script
  type="webmcp">` manifest, or a platform-injected surface such as
  Shopify Storefront WebMCP)
- Give every tool a `name` and a human-readable `description`
- Prefer static, literal descriptions over dynamically concatenated
  strings, so the surface can be audited

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "webmcp").status` is `"pass"`.
