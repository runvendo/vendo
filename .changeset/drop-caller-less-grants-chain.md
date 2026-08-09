---
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

The per-person app-sharing chain — the Share dialog and everything under it —
is removed. No host ever mounted the dialog; every name below was re-grepped
across `packages/`, `examples/`, `fixtures/`, `corpus/`, `scripts/`,
`docs-site/` and the console repo before removal, and the only callers found
were other members of this same chain.

**Gone from `@vendoai/ui`:** the `ShareDialog` component and `ShareDialogProps`
(from `@vendoai/ui/chrome`), the `useAppGrants` hook, and the five client
methods that existed only to feed them — `client.apps.grants`, `.share`,
`.unshare`, `.promote` and `.resolvePerson`. `ForkOffer` and
`encodeGrantPrincipal` shared the dialog's file and are unaffected; the file is
now `chrome/fork-offer.tsx`.

**Gone from `@vendoai/vendo`:** the wire routes `GET`/`POST`/`DELETE
/apps/:id/grants`, `POST /apps/:id/grants/resolve` and `POST /apps/:id/promote`,
their handlers, and the `promoteApp` composition seam.

**Gone from `@vendoai/apps`:** `AppsRuntime.promote`, and the write half of
`AppsRuntime.access` — `list`, `grant`, `revoke` and `holder`. Their now
unreachable supporting seams go with them: `AppsConfig.multiParty`,
`AppsConfig.promoteApp`, and the internal `requireMultiParty` / `requireAccess`
/ `reportShare` helpers.

**Unchanged, and deliberately so:**

- `AppsRuntime.access.levelFor`, and `access-checks.ts`' `holds` / `owned` /
  `requireOwned` / `grantedRecords` — the permission backbone behind every app
  door.
- The `AppAccess` seam itself (`@vendoai/store`'s `appAccess(store)`), whose
  full `levelFor`/`grant`/`revoke`/`list`/`can` surface and conformance kit are
  untouched. Grant rows are still written and read there; only the runtime door
  over that write half is gone.
- `vendo.apps.share()` and `vendo.apps.publish()` — the Cloud snapshot and
  registry feature. A different feature that merely shares a name with the
  deleted grants `share`.
- The auth presets' `resolvePerson` seam and `/status`'s `namesPeople` flag.
- `@vendoai/store`'s `appStore().promote` row primitive and the hosted store's
  `lifecycle.promote` op.
