# umami labeling notes

Pinned SHA af1b6c6e.

## Known expected-miss: `radius` (6)

The 6px control radius lives inside the vendor package
`@umami/react-zen`'s stylesheet (`styles.full.css`, imported in
`src/app/layout.tsx:7`), not in the host's own tree —
`src/app/global.css` declares no radius token. The theme gatherer
deliberately does not chase package-specifier CSS (host brand tokens
live in the host's own tree; vendor sheets carry library tokens that are
not the host's brand), so the extractor reports the slot as DEFAULTED —
a visible miss, never a silent wrong value. A nightly miss on this
dimension is expected, not an extraction regression (analysis:
extraction-quality-1 lane, 2026-07-26).
