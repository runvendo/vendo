---
"@vendoai/ui": patch
---

Starting one connect in the connect tray no longer makes every other connector inert. The tray tracked the connect in flight as a single toolkit for the whole surface and disabled every add button off it, so on a host with a full catalog the first click froze all 55 remaining connectors for the length of the 120s poll — with no cancel, and no disabled styling anywhere to say why, so the tray looked interactive and simply ignored every click. Connect state is now keyed per row, the way `ConnectedAccountsPanel` already keyed it: several connects can run at once, each row keeps its own spinner, its own failure reason and its own "your browser blocked the sign-in window" link, and no add button disables at all — the row that is connecting shows its progress dots instead of a button, so there is nothing left to grey out.
