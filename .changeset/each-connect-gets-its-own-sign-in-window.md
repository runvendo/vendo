---
"@vendoai/ui": patch
---

Two connects started at once now get two sign-in windows instead of fighting over one. Every connect surface opened its window under the same fixed name, and a window name is precisely what makes `window.open` hand back a window that is already open — so the second connect inherited the first's window, replaced a sign-in page that was still mid-flow, and then had that window closed underneath it by whichever connect finished first. The window is now named after the same per-row key the surface already keys its connect state by, so concurrent connects — which the connected-accounts panel and the connect tray both allow by design — stay independent from the click through to the broker's consent page.
