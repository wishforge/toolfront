# Fix the AI crawler policy

State which AI crawlers are welcome in `robots.txt`, and stop turning
away the ones that cite and link back to you. A single catch-all rule
cannot express "welcome retrieval agents, block training scrapers".

## Requirements

- Serve `/robots.txt` as `text/plain` with HTTP 200
- Name the AI crawlers you welcome with explicit `User-agent` groups
  (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `PerplexityBot`,
  `Applebot-Extended`, `OAI-SearchBot`, and others)
- Do not `Disallow: /` on any crawler you want to be cited by
- If you block training scrapers, do it with a named group, not a
  blanket `User-agent: *` block

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "robots-policy").status` is `"pass"`.
