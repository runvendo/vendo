---
"@vendoai/vendo": patch
---

`vendo init` now writes the one Next.js setting a Vendo install cannot work without, and `vendo doctor` fails without it.

On a fresh pnpm + Next.js host every generated screen failed its checks, and nothing else looked wrong: Next bundles `@vendoai/apps` into the server chunk, so the app checker's `import("esbuild")` became a bare runtime resolve from the app root — where pnpm never hoists esbuild, since it lives only under `node_modules/.pnpm/@vendoai+apps…`. Init had never touched `next.config` at all.

Listing `"esbuild"` does NOT fix it, which is the trap: the checker reaches esbuild through a VARIABLE specifier behind bundler-ignore comments, so there is no static `"esbuild"` request for Next to match against `serverExternalPackages`. The package itself has to be external. Our own examples looked fine only because the monorepo root hoists esbuild; their lists were equally inert, and they now carry `@vendoai/apps` too.

Init ensures a Next host's `next.config.(ts|js|mjs)` carries `serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"]`: the missing names are spliced into a list the config already keeps, the whole property is added to the object the config exports, or a minimal `next.config.mjs` is created when the repo has none. The edit is deliberately conservative — a config init cannot read as an object literal (a function of `phase`, a computed export) is never rewritten; the line is printed as a paste instead, and reported in both the human output and the `--agent` receipt like every other repair.

`vendo doctor` grades the same fact statically as **E-CFG-004**, failing on a list that carries `esbuild` but not `@vendoai/apps`, with the exact line to paste in the message. It reads both spellings of the list, so a Next 14 host on `experimental.serverComponentsExternalPackages` passes.
