> Historical session record (frozen). Describes the repo at its date; may not match current code.

# docs.vendo.run homepage + quickstart GIFs

## Goal

Give docs.vendo.run a real landing page (in the spirit of docs.context.dev) and
add motion to the quickstart, within the constraints of Mintlify's free Starter
plan.

## Constraints

- Mintlify free Starter plan: custom CSS/JS is ignored. Branding comes from
  `docs.json`, logo/favicon, page content, and built-in components.
- Paid upgrade is planned but not for today. This homepage is a stopgap that
  must look good now and upgrade cleanly later.
- GIFs are kept as-is (no re-encode to video) per decision.

## Decisions

1. **Mintlify-native homepage** — built from Mintlify's own components, no custom
   CSS dependency. Best-effort inline styles for the hero headline and footer
   band; they degrade gracefully if Mintlify flattens them.
2. **Full-width landing** — `index.mdx` uses `mode: "custom"` (no sidebar/TOC).
   Clicking any card drops into the normal sidebar docs.
3. **Keep GIFs** — served from `docs-site/images/`.

## Homepage sections (`index.mdx`)

1. Hero — eyebrow pill, two-tone headline, subhead, install one-liner, two CTAs
   (Quickstart, "Give it to your agent" → `/llms-full.txt`), framed `hero.gif`.
2. What your customers can do — 4 GIF cards (Build views, Remix, Automate, Voice).
3. Start here — 2 quickstart cards (Next.js, any Node).
4. Explore — 4 cards (How it works, Connect, Tools & safety, Capabilities).
5. Footer band — "Self-hosted. One key. No signup." + Get started / GitHub cards.

## Quickstart GIFs (`quickstart.mdx`)

- Install step → `init.gif` (codemod running).
- Run-the-app step → `hero.gif` (first-view payoff).

## Assets

Copied into `docs-site/images/`: `hero.gif`, `remix.gif`, `automation.gif`,
`voice.gif`, `init.gif`.

## Known degradations on free plan

- Gradient headline text may render as a solid color.
- The dark footer band may flatten to a plain block.
- ~12MB of GIFs on the homepage load acceptably but not instantly.

All three are the first things a paid upgrade improves.

## Deploy note

docs.vendo.run auto-deploys from `docs-site/` on `main`, so merging this
publishes live. Not gated on ENG-198 — that gate only affects whether the
documented install commands resolve to published npm packages.
