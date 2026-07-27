# vercel-commerce labeling notes

Pinned SHA 3761e52e.

## fontFamily provenance

`app/globals.css:1` is Tailwind v4 (`@import "tailwindcss"`) with no
`--font-sans` override anywhere in the tree; `app/layout.tsx:4,34`
imports `GeistSans` from `geist/font/sans` and applies
`GeistSans.variable` on `<html>`. The body stack is therefore Geist Sans
heading Tailwind's documented default sans list, recorded in full per
the labeling guide.

## Known expected-misses: `accent` (#000000) and `radius` (8)

The repo has no design-token sheet; brand evidence lives entirely in
utility classes, where the primary CTAs are `bg-blue-600` and
`rounded-full` (`components/cart/add-to-cart.tsx:19`,
`components/cart/modal.tsx:249`; active rings
`components/product/variant-selector.tsx:90`). The labels record a
monochrome-brand judgment those utilities do not state, so extraction
answering the dominant interactive color (#155dfc = Tailwind v4
blue-600) or the CTA pill radius is an expected miss on these two
dimensions — no deterministic rule reproduces the labels without
counter-example failures elsewhere (analysis: extraction-quality-1
lane, 2026-07-26; full reasoning in the lane's PARKED.md).
