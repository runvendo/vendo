---
"@vendoai/ui": patch
---

Two surfaces that answered a click by doing nothing, silently.

- The connect tray's cancel latch was only ever SET, by an unmount cleanup, so
  React's dev StrictMode remount latched it for the tray's whole life: every
  connect exited its status poll on the first check, which means the row sat on
  "Connecting…" forever with no error and no end while the person finished
  signing in elsewhere. The mount effect clears the latch now, the way
  `ConnectCard` and `ConnectedAccountsPanel` already did.
- The automations panel's run-health strip discarded its own `/runs` response
  whenever its effect restarted — which is every refresh, since a refresh is a
  new `automations` array. The restarted effect had already skipped the row as
  "fetched", and the discarded response then unmarked it, so no retry was ever
  issued. With the poll on, the run sweep covered for this a tick later; with
  the cadence off (`pollMs={0}`, a host driving its own refreshes) the strip
  was simply gone for the session. The fetch is row-keyed and lands
  idempotently, so it is no longer cancelled at all.
