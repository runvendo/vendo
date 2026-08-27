---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

`VendoPalette` is deleted.

It was named for a command palette and never drew one. It rendered `null`, and
its whole job was to register a `⌘K` binding plus a list of commands the host
had to draw itself. A component that renders nothing is a component nobody can
see is there.

**The component is gone**, along with `VendoCommand`, `HotkeyChord`,
`PaletteHotkey`, and the command-set half of the overlay registry
(`registerConversationCommands` / `getConversationCommands`). Nothing consumed
that command set — the overlay's chip strip was removed in July 2026 and never
replaced.

**The built-in `⌘K` goes with it.** Vendo now binds no keyboard shortcut at
all, so your app keeps every chord it owns. If you want one, it is four lines
against the seam that was already there:

```tsx
import { openVendoConversation } from "@vendoai/vendo/react";

useEffect(() => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    openVendoConversation({ toggle: true });
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, []);
```

**Drawing your own command UI is unchanged.** `openVendoConversation` and every
one of its options stay: `prompt`, `send`, `newConversation`, `appId`,
`toggle`, and `close` (close first, then navigate, so your own routing never
lands behind the open panel).

`vendo doctor` no longer counts `<VendoPalette` as a visible surface, so a host
whose only surface marker was the palette now fails `E-WIRE-006` — correctly,
since that host had nothing on screen.
