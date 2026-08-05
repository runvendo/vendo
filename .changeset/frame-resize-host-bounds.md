---
"@vendoai/ui": minor
---

An embedded app reports its height and the frame fits it — inside the host's
bounds, never outside them.

`HttpFrame` — the embedded served app — had no resize protocol at all. It sat at
a fixed `min-height: var(--vendo-app-frame-height, 320px)`, so a served app was
either padded with dead space or clipped, whichever way its real content fell.
The jail frame next door has had a working protocol the whole time. There are now
exactly ONE of them, shared:

- `tree/frame-resize.ts` owns the identity gate (`event.source ===
  iframe.contentWindow` — the one thing a sender cannot forge), the message
  validation, and the clamp. Both `JailedComponent` and `HttpFrame` call it, and
  the jail's private `MAX_JAIL_HEIGHT` and inline resize handler are gone. A
  security gate with two copies is a gate with two chances to be wrong.
- The wire is unchanged, deliberately: the framed document posts
  `{ vendo: true, kind: "resize", height }` to its parent, exactly as the jail
  runtime already does. Nothing renamed, no field added.

**The host's bounds win.** The host sized the slot when it embedded Vendo; that
is a constraint the app lives inside, never overrides. The app *reports* its
natural height, and the frame fits that report between the host's floor and
ceiling — an app taller than the ceiling scrolls inside its own frame instead of
pushing the host's page around. Both bounds are plain CSS on the frame, so a host
states them where it already styles Vendo and in whatever unit it likes:

- floor: `--vendo-app-frame-height` (served apps, default 320px) and
  `--vendo-jail-min-height` (generated components, default 16px) — both already
  existed and both mean the same thing they did before.
- ceiling: `--vendo-app-frame-max-height`, new, defaulting to `8192px` — the
  jail's old hard limit to the pixel, so a host that configures nothing gets
  exactly today's behaviour.

No new React props: a host that never touches this sees no new API.

**Breaking, small:** `AppFrameKeepalive.reopen` is removed. A woken machine used
to mint a fresh ingress URL, so the frame had to notice the wake and re-open for
the new address — and to notice it, it listened to four global activity events,
tracked an activity flag, and read `document.activeElement` as a stand-in for
activity it could not see inside a cross-origin frame. Served-app URLs are stable
proxy URLs now: a wake is invisible to the frame, the address never changes, and
there is nothing to recover. The `ping` leg is untouched and still keeps an
on-screen embed's machine awake. Callers passing `{ ping, reopen }` drop
`reopen`; nothing else changes.
