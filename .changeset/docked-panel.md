---
"@vendoai/ui": minor
---

Dock the conversation panel beside the product — opt-in.

`VendoOverlay` takes a `placement` prop. `"dock"` parks the panel against the
right edge at full height and reflows the host page into the remaining width,
so the surface being reshaped stays visible and clickable while the panel is
open. `dockWidth` (default `420`) sets the panel width and, with it, how far
the page reflows. Below the mobile breakpoint both still collapse to the
full-bleed takeover.

`placement` defaults to `"center"`, the centered modal that has always
shipped, so this release changes nothing for an existing host: the scrim, the
body scroll-lock, `inertBehind` and `aria-modal` are all still there unless a
host asks for `placement="dock"`.

Docked is deliberately NON-modal — no scrim, no body scroll-lock, no
`inertBehind`, no focus trap, and no `aria-modal` — because a modal that
covers the page is the wrong shape for a tool whose job is editing that page.
The page reflows via a width reduction on `documentElement` (not `body`,
whose width is usually author-controlled), torn down on close, unmount, and
placement flips. Host chrome that is itself `position: fixed` is anchored to
the viewport rather than to `documentElement`, so it does not reflow with
this; such elements can read `--vendo-dock-w` to inset themselves.

The reflow is owned centrally and refcounted: `data-vendo-dock` and
`--vendo-dock-w` live on the one `documentElement` every overlay shares, so
closing one of two open docked panels no longer hands the page back its full
width while the other is still open.

The workspace expander stays a centered-placement feature — a full-height rail
has nowhere to grow a stage into — so it is hidden while docked. For the same
reason a docked conversation does not auto-stage a built app: staging on the
user's behalf there would strand an app they could neither see nor collapse.
The embed still lands in the rail.

**An indeterminate progress bar** sweeps along the top edge of the framed page
while a turn runs, driven by the existing cross-tree run-activity store. No
percentage: `RunActivity`'s `done`/`total` count steps already begun, not a
forecast, and inventing a completion estimate would break the same "no fake
percentage, no completion jump" rule the app-boot hairline already follows.

Public API added: `placement` and `dockWidth` on `VendoOverlay`.
