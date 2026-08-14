---
"@vendoai/apps": minor
---

One idiom for actions — a plain `<Button>` that calls a tool, and the product
does the asking.

`<ActionButton>` is removed before it ever shipped. It was a second way to spell
a write, and the component catalog the manual interpolates
(`contract/kit/kit-prompt.ts`) already taught the first one — so a model reading
the manual met two idioms for the same press and had to pick. A screen writes the
call the way React writes every other event:

```tsx
<Button label="Cancel" variant="danger" onClick={() => tools.cancel_transfer({ id: transfer.id })} />
```

Nothing about the press changes: the same `tools` proxy, the same intent, the
same guard, the same approval modal, the same refresh on success. What the
element cost was the extra idiom, the ambient declaration that had to be printed
beside the catalog, and the engine's own component in the VM.

The confirm rule it carried stays, said plainly instead of attached to one
component. The manual now states it on the Actions paragraph — destructive and
money-moving calls are confirmed by the product OUTSIDE the screen, so a screen
never builds a confirm step of its own — and the reviewer is told the same about
any control that files its tool call directly: asking twice is the bug, not
asking once.
