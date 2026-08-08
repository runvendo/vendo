---
"@vendoai/ui": patch
---

The connected-accounts panel's own two connects work again. `Reconnect` on a broken row and the connect-ahead chips called the shared `completeConnection` with no sign-in window, which left it opening one *after* the initiate await — the post-await shape Safari, Firefox and any Chromium with a popup blocker refuse by call-stack provenance, so the buttons did nothing at all when clicked. Both now open the window synchronously inside the click, as `ConnectCard` always has. And a window the browser refuses anyway is no longer a dead end on any connect surface: the panel and the connect tray both offer the broker's sign-in URL as a plain link while the poll keeps running, so finishing it in a tab still settles the account. Previously a refused window left a spinner and, two minutes later, "nothing changed" — with nothing the person could do about it.
