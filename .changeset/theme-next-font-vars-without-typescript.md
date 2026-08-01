---
"@vendoai/vendo": patch
---

The theme extractor now resolves `next/font` CSS variables on hosts without a
resolvable `typescript`. The standard Next.js pattern — `--font-sans:
var(--font-inter)` in CSS, `Inter({ variable: "--font-inter" })` in the root
layout — is read through a real TypeScript program, and `typescript` is an
optional resolution: a JS-only Next app, a strict pnpm tree, or an npx-run CLI
simply doesn't have one. When it was missing, every next/font derivation went
dark at once and `vendo init` fell all the way through to "No host evidence for
fontFamily — neutral defaults used" on an app whose font was sitting right
there in its layout.

Without a compiler the extractor now text-scans the layout's next/font and
geist loader calls for the family each CSS variable names. The scan reports
those fonts as un-applied, because text cannot prove a font reaches the markup:
every derivation that needs that proof still fails closed to the model pass,
and only var() resolution — where the host's own CSS is the authority on what
the body font is — gains an answer. `next/font/local` stays unresolvable by
design; its loader declares a variable but no family name.
