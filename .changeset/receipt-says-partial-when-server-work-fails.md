---
"@vendoai/apps": minor
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
view is real, reopenable, and worth keeping, so it still becomes an app ref and
still narrates through its own card. Hosts that switch on `status` should treat
`"partial"` as a success with a named gap; hosts that only relay `say` are
unaffected.
