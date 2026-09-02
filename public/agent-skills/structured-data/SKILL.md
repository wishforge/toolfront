# Add structured data

Give AI structured facts about your page — prices, products, reviews,
and social previews — instead of forcing it to guess from raw text.

## Requirements

- Add JSON-LD blocks (`<script type="application/ld+json">`) for your
  key entities: products, offers, reviews, organization
- Add `og:title` and `og:description` meta tags
- Keep prices and availability in `Offer`/`Product` schema so agents
  quote you accurately

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "structured-data").status` is
`"pass"`.
