# Vendo public docs: writing rules

This folder is a Mintlify docs site (`docs.json` + MDX pages). It documents Vendo, the devtool in this monorepo: an embedded agent that acts through the host app's own API as the signed-in user and renders generated UI in a sandboxed, brand-native surface.

## Hard rules

- The string "flowlet" (any casing) must not appear anywhere in these pages. The product is Vendo, packages are `@vendoai/*`, the codemod is `npx vendo init`, config lives in `.vendo/`, env vars are `VENDO_*`, routes are `/api/vendo/*`.
- Write installs as published: `npm install @vendoai/next` etc. Do not mention tarballs, workspaces, ENG ticket numbers, or internal status.
- Never reference the demo apps (Maple, demo-bank, Cadence, demo-accounting, the Gmail app) or anything under `apps/`. Public example references: generic snippets and the patterns in `examples/node`.
- Do not invent APIs. Every option name, function signature, route, env var, and behavior claim must be verified against the source in `packages/` (types are the ground truth) or the internal docs in `docs/`. If you cannot verify a claim, leave it out.
- Do not run builds or install dependencies. Read code only.

## Style

- Succinct and direct. No filler, no hype vocabulary, no AI-speak.
- No em dashes. Use periods, commas, or parentheses instead.
- Plain, declarative, second person ("you", "your app"). Say "your customers", never "end users". Numbers over adjectives.
- Mintlify MDX components are available (Steps, Tabs, CodeGroup, Card, Note, Warning, etc.). Use them where they genuinely help; prefer prose and code blocks otherwise.
- Every page keeps its frontmatter `title` and `description` (you may refine the description).
- Code blocks: real, runnable snippets with correct package names. TypeScript for code, bash for commands.

## Sources

- `docs/superpowers/plans/2026-07-05-public-docs-ia.md` is the page tree and per-page source map. Follow it.
- `docs/quickstart.md`, `docs/persistence-and-deploy.md`, `docs/host-components.md`, `TELEMETRY.md` are the internal source docs. Distill them; do not copy status notes or internal links.
- `packages/vendo-*/src` for API ground truth.
