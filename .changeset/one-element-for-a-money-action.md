---
"@vendoai/apps": minor
---

A screen writes ONE element for an action, and the product does the asking.

A generated money screen used to hand-roll its own consent: a `confirming`
piece of state, a Callout, a "Yes, cancel it" and a "Keep it" — fifteen to
twenty-five lines per action, and often half the file. It was wasted twice
over. The reviewer rejected the screen for confirm details it could not see,
which cost a repair round on nearly every money screen; and the guard already
asks properly at the system layer, so the person who got through the screen's
panel was then asked a second time by the approval modal.

`@vendo/screen` now exports `<ActionButton>`:

```tsx
<ActionButton tool="cancel_transfer" args={{ id: transfer.id }} label="Cancel" variant="danger" />
```

It renders the Kit's own `Button`, and the press files EXACTLY the call a
handler files — the same `tools` proxy, the same intent — so the guard, the
approval modal, the single-flight lock, the per-node outcome notice and the
refresh on success are the ones already there. It adds nothing to trust.

The compiler decides whether the press is real, on the same schemas that type
`tools.<name>(args)`: `tool` is the written-out name of a tool this host has
(with TypeScript's own "did you mean" on a typo) and `args` is that tool's own
payload, required exactly when its schema requires one. A name computed from
the data satisfies no tool, so it is refused before the screen ever runs.

The screen manual now teaches it in place of the confirm panel it used to
teach, and the reviewer is told that a screen using it is not missing a
confirmation — asking twice is the bug, not asking once.
