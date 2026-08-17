---
"@vendoai/vendo": patch
---

`vendo init` now writes the one Next.js setting a Vendo install cannot work without, and `vendo doctor` fails without it.

On a fresh pnpm + Next.js host every generated screen failed its checks, and nothing else looked wrong: Next bundles `@vendoai/apps` into the server chunk, so the app checker's deliberately bundler-hidden `import("esbuild")` resolved at runtime from the app root — where pnpm never hoists esbuild, since it lives only under `node_modules/.pnpm/@vendoai+apps…`. Our own examples never hit it because each of them sets `serverExternalPackages` by hand, and init had never touched `next.config` at all.

Init now ensures a Next host's `next.config.(ts|js|mjs)` carries `serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/store"]`: the missing names are spliced into a list the config already keeps, the whole property is added to the object the config exports, or a minimal `next.config.mjs` is created when the repo has none. The edit is deliberately conservative — a config init cannot read as an object literal (a function of `phase`, a computed export) is never rewritten; the line is printed as a paste instead, and reported in both the human output and the `--agent` receipt like every other repair.

`vendo doctor` grades the same fact statically as **E-CFG-004**, with the exact line to paste in the message. It reads both spellings of the list, so a Next 14 host on `experimental.serverComponentsExternalPackages` passes.
