---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

A risk grade pinned in `.vendo/overrides.json` now wins for an outside-service
tool the agent reached by searching a provider's catalog, not just for the tools
on the listing. The dispatcher grades those calls live off the broker's own tag,
and it never read the authored file — so the one tool whose grade is decided at
call time was the one tool nobody could correct, while the docs said an override
is the last word.

```json .vendo/overrides.json
{
  "format": "vendo/overrides@3",
  "tools": {
    "GMAIL_DELETE_THREAD": { "risk": "destructive" }
  }
}
```

It reads the registry's own loaded copy of the file — the same source
`mergeOverride` applies to a listed tool, never a second read — so the two
layers cannot disagree. Nothing changes for a slug you did not pin: the broker's
tag still decides, and a slug nobody owns still grades `read` rather than
parking an approval for a call that cannot run.

The boot warning about orphaned override entries stops calling those pins typos
when a connector that dispatches by slug is configured.
