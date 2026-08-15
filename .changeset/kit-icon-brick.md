---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The Kit gets an `Icon`. Generated screens have had no way to draw a glyph, so
every affordance has been a word — and the models reach for `lucide-react`
anyway, which the jail cannot resolve.

`<Icon name="arrow-up-right"/>` renders an inline stroked SVG that inherits the
surrounding text's color. 227 names, in lucide's own kebab-case, are extracted
at build time by `pnpm --filter @vendoai/ui build:icons` into the committed
`src/kit/icons.gen.ts`; lucide itself is a devDependency, so the runtime carries
the path data and never the package. A name outside the set renders nothing and
marks itself `data-kit-missing-icon` — a guessed glyph leaves a gap, never a
crash and never a broken-glyph box.
