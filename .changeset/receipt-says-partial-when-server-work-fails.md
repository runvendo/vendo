---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

The make receipt says `"partial"` when the server work did not get built.

A create whose server lane failed already told the person the truth in words —
"I built the screen, but the server-side part didn't get built" — and still
handed back `status: "ready"`. So the sentence was honest and the FIELD was not:
everything that branches on `status` rather than reading `say` — a host's own
`if`, the pack's ref capture, an outside agent over MCP — saw a clean build of a
half-built app. That is the original silent-success bug one field over.

`MakeReceipt.status` gains `"partial"`: the screen is painted and on the person's
page, and the server work its plan required is not. It is deliberately not
`"failed"`, which means nothing was painted and sends an agent to rebuild — this
view is real, reopenable, and still narrates through its own card. Hosts that
switch on `status` should treat `"partial"` as a success with a named gap; hosts
that only relay `say` are unaffected.

The tool pack's ref capture refuses it for the same reason it already refuses a
failed edit: `vendo/app-ref@1` is `{ kind, appId, title, status: "building" }`
and carries neither `status` nor `say`, so laundering a partial build through it
left a BYO loop — and `vendo_delegate`'s `refs` — waiting on a completion that
already came, with no sentence saying what was missing. It now falls back to the
receipt itself, both fields intact.
