---
"@vendoai/ui": patch
---

The embeds work bare: `VendoProvider` is now an override, not a prerequisite.

`<VendoToolResult>`, `<VendoAppEmbed>` and `<VendoApprovalEmbed>` used to throw
without a surrounding provider, which made the first thing a BYO chat does a
piece of setup. Every setting the provider carries already had a universal
default — the wire at `/api/vendo`, auth riding the session cookie the browser
already sends, Vendo's own `--vendo-*` tokens — so the provider was never
telling the embeds anything they could not have assumed.

Now they assume it. With nothing above them the three embeds render, poll,
approve, deny and mount apps exactly as they always have, off one shared client
per page — a fresh client per embed would be a fresh wire per embed, and every
poll keys its effect on client identity. A surrounding `VendoProvider` still
wins, for everything inside it, with no observable change to any page that has
one: it was always "settings for the components inside me", and this only adds
"here is what I assume when you don't say".

No new props, no config object, no environment variable. The headless hooks
ride the same seam, so they self-boot too.
