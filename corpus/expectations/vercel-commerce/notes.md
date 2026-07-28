# vercel-commerce labeling notes

Pinned SHA 3761e52e.

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

- `POST /api/revalidate` → `read` (was the mechanical `POST` → `write`). This is
  a Shopify webhook RECEIVER whose only effect is invalidating the Next.js cache,
  which the labeling rule explicitly does not count as a mutation. The route is a
  one-line delegation (`app/api/revalidate/route.ts:5`: `  return revalidate(req);`)
  and the function it delegates to does exactly two things —
  `lib/shopify/index.ts:535`: `    revalidateTag(TAGS.collections, "seconds");`
  and `:539`: `    revalidateTag(TAGS.products, "seconds");`. `revalidateTag` is
  `next/cache` (`lib/shopify/index.ts:11`). There is no `fetch`, no Shopify
  Admin/Storefront mutation, no datastore client and no cookie or session write
  anywhere in the function (`:506-543`); its other statements read a header,
  read a query parameter, compare a secret, and build the JSON response.

  Receiving a webhook is not the same as firing one: the rule counts an outbound
  effect the caller cannot take back, and this handler makes no outbound call.

  Read from the pinned source and independently confirmed by a second reviewer
  given only the handler excerpt, the then-current label and the rule. Do not
  relabel from model output.

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
