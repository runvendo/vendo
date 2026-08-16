---
"@vendoai/actions": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

Host fonts become bytes, not just a name.

Theme extraction learned that the brand font is called "Inter". That name is
enough for the host's own pages and useless everywhere else: a generated screen
renders inside surfaces the host's stylesheet never reaches, where "Inter"
resolves to whatever the surface happens to have — normally nothing.

- **`vendo sync` now writes `.vendo/fonts.css`** — the theme's families resolved
  to real files and inlined as data-URI `@font-face` rules. Three sources, in
  order of how much each proves about what the host actually ships: next/font's
  build output, the host's own `@font-face` rules pointing under `public/`, then
  the Google Fonts css2 API. The first and last are re-resolved on every run and
  never recorded — next/font's filenames carry a per-build hash and gstatic's
  carry a font version, so a stored path is a path that rots. Written with
  `theme.json` and only then (install, and any sync where the brand actually
  moved), because resolving a face can reach the network and `sync` runs from
  `predev`. `init` prints the one-line import beside the `<VendoProvider>` paste.
- **`theme.json` gets metadata, never bytes** — `typography.fonts` names each
  face's family/weight/style/source. The file is a bundle import and rides the
  `?vendoTheme=` query string, where a base64 face would blow past every proxy's
  request-line limit.
- **A host's real mono font is learned instead of discarded.** The body-stack
  derivation found the mono binding, filtered it out of the sans candidates and
  dropped it, so a host shipping Geist Mono still got the generic system stack.
  It is now derived on its own and stored as `typography.monoFamily`, falling
  back to `monospace` rather than `sans-serif` — a code font that fails to load
  must fall back to another code font.
- **`VendoProvider` takes a `fonts` string** and the chrome injects it beside
  its own sheet, as a guarded `<style data-vendo-fonts>`. Kept separate from
  `ensureChromeStyles` on purpose: the faces and the chrome are wanted
  independently — a surface rendering inside someone else's client needs the
  faces and none of the chrome.

- **Sync no longer captures its own output.** The root layout now imports
  `.vendo/fonts.css`, and the seed-baseline style capture would have read that
  sheet straight back in — ~65 KB of base64 copied into every remixable seed and
  host-component bundle, on every run. `.vendo/` is sync's output, never host
  source, and the capture skips it.

Only latin is taken, and only because both sources already publish per-subset
files. No glyph-subsetting machinery ships, and there is no license logic.
