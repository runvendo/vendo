---
"@vendoai/core": minor
"@vendoai/apps": minor
---

A screen mounts only once its build is terminal.

A screen saves as it goes, so its app ROW lands at the first save that paints — and the mandatory reviewer pass and its one repair round run after that. Every surface that mounts from the row stops looking the moment `open()` answers, so a person could be left in front of a draft — a wrong NUMBER included — while the server already held the corrected version, with nothing but a page reload to fix it.

`AppDocument.building` (`@vendoai/core`, optional, server-written) is that window made durable: the first painting save of a build stamps it, and `open()` answers the same not-found the app gave a moment earlier with no row at all — which the wire's build window already turns into the `{kind:"pending"}` every embed keeps polling on. So there are no client changes: `useApp` and `VendoAppEmbed` both branch on it today, and `VendoSlot` gets "building" off the placement read. The trade is deliberate: first paint waits for the repair.

`buildInFlight(building)` is new on `@vendoai/apps/contract`, and it is time-bounded on purpose — past the UI build deadline either the watchdog landed a terminal record or the build's process died, and a flag that never cleared would leave the app unmountable forever.

The window is wired ONCE, around `assemble` itself, so the two doors that run an assembler cannot disagree about when a build ends, and a `finally` settles a run that threw or escalated. A harness writing `app.tsx` straight through the workspace is untouched — there is no build behind that save to be unfinished.
