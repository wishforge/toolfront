# Harden the tool surface

Tool descriptions are agent-facing instructions: a hostile actor can
poison them to steer an AI into leaking data or taking destructive
actions. Add the recommended security annotations and keep descriptions
auditable.

## Requirements

- Every tool description must be a static, literal string (not built at
  runtime from variables or concatenation)
- Add `readOnlyHint` to tools that do not change state
- Add `untrustedContentHint` to tools that consume untrusted input
- Avoid instruction-like content in descriptions that an agent would
  follow as commands

## Validate

```
GET /api/scan?domain=YOUR-SITE.com
```

Check that `checks.find(c => c.id === "tool-security").status` is
`"pass"` (a `"partial"` means minor findings remain; a `"fail"` means a
poisoning pattern was found).
