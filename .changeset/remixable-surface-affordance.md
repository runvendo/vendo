---
"@vendoai/ui": minor
---

New `Remixable` chrome component: wrap any host element to mark it remixable.
At rest a small muted ✦ sits in the element's top-right corner; hovering (or
tabbing into) the element blooms it in place into a **✦ Remix** pill, held open
for a 200ms grace so the cursor can travel to it. Clicking opens the
conversation surface EMPTY with the element attached — a `Remixing · <name>`
chip in the panel chrome that rides with the next message and clears on send —
so the pill can never fire a turn on its own. Under `prefers-reduced-motion`
the bloom snaps.

```tsx
<Remixable name="Rent Roll">
  <RentRollTable units={units} />
</Remixable>
```

`name` is the surface in the host's own words (the chip's label, and what the
agent is told); the optional `context` is one grounding line appended after the
user's message, exactly like `VendoTrigger`'s. Hosts wiring their own element
call `openVendoConversation({ remix: { name, context } })` — the same registry
seam, now carrying an attachment alongside a prompt.

Distinct from `VendoSlot`'s `remix` flag, which forks the component pinned in
that slot; `Remixable` attaches any element to the next ask and forks nothing.
