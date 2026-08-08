---
"@vendoai/ui": patch
---

Three promises the chrome was not keeping.

- `theme.motion: "reduced"` is now honoured by the pin ceremony and the morph
  toast, not just the OS media query. The pin flight reads `data-vendo-motion`
  off the chrome boundary the card sits in — the stylesheet rule that kills
  animations inside a reduced-motion root could never have stopped it, because
  the flight is a Web Animations animation. The morph toast folds the same
  setting into the flag that picks its timings and its exit, so it stops writing
  "reduced" onto the DOM while running the full travel budget and docking.
- A new approval is brought into view even when the transcript re-renders inside
  the 80ms before the scroll. The scroll target lives in a ref now: previously
  the approval was marked "seen" up front and one re-render in that window
  cancelled the scroll permanently rather than deferring it — and a settling
  stream re-renders several times right when an approval arrives, so consent that
  landed below a tall generated view was never scrolled to.
- A polled collection hook skips its read while the document is hidden, and
  re-reads the moment the tab comes back. A workspace left open in a background
  tab was spending a request every few seconds for a view nobody could see; the
  shared approvals feed has followed this rule since ENG-219 and now every
  resource does.
