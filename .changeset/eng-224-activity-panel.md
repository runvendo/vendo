---
"@vendoai/ui": minor
---

Activity panel rebuild (ENG-224): the self-scoped activity surface now renders
real semantics instead of a raw data dump. Each row is a concrete action taken
as the user — a kind badge (Tool, Approval, Connection, …) plus a humanized
action label (host tool metadata wins, else the prettified slug, never a raw
id), a plain-language result (Succeeded / Failed / Awaiting approval / Blocked /
Connect required / Running) with a status glyph, and a human, timezone-stable
timestamp ("Jul 11, 2026, 12:00 PM") in place of the raw ISO instant. Pagination
now ends in an explicit end-of-list marker: `useActivity` exposes `hasMore`, which
flips to `false` once a page adds no new events, so "Load more" retires instead of
re-fetching nothing. No contract or wire changes.
