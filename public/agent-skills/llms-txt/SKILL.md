# Create an llms.txt

Publish a one-page markdown summary of your site so language-model
clients can learn what you do from your own words, not from a guess.

## Requirements

- Serve `/llms.txt` at the site root with HTTP 200
- Use markdown with a `#` title, a short summary, and a bullet list of
  key pages with link descriptions
- Keep it under a few hundred lines: it is a reading list, not a dump

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "llms-txt").status` is `"pass"`.
