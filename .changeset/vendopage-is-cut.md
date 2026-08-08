---
"@vendoai/ui": patch
---

`VendoPage` is removed

The full-page workspace surface is cut. Two public exports go with it:

- `VendoPage` (component)
- `VendoPageProps` (type)

Nothing else is removed. `AutomationsPanel`, `ActivityPanel` and
`ConnectedAccountsPanel` — the three panels `VendoPage` used to mount behind
its tabs — stay exported and are individually mountable, and `WaitingQueue`,
`VendoOverlay`, `VendoThread`, `VendoPalette` and `VendoSlot` are untouched.

**If you rendered `<VendoPage />`,** mount the panels you actually want
instead. Each carries its own theme and stylesheet, so a `VendoProvider`
ancestor is the only requirement:

```tsx
<VendoProvider client={client}>
  <div style={{ maxWidth: 780, margin: "0 auto" }}>
    <AutomationsPanel />
    <ConnectedAccountsPanel />
    <ActivityPanel />
  </div>
</VendoProvider>
```

Keep them in a ~780px container. `VendoPage` used to cap their measure and the
activity ledger rows stretch badly at full bleed.

The `surface="page"` mode of `VendoEmbed` and the `.fl-page*`, `.fl-center*`
and `.fl-rail*` chrome CSS are removed along with it.

One behaviour change outside the page: the pin ceremony now skips its flight
animation when the page has no landing target (no host slot and no Apps
shelf). Pinning still works; it just does not animate. Previously the ghost
lifted and then vanished mid-air, because the Apps shelf it aimed at only ever
existed inside `VendoPage`.
