---
"@vendoai/vendo": patch
---

Onboarding safety and honesty: four fixes to the first `vendo init`.

- **A secret written into a committed file now says so.** `vendo login` and
  `vendo init --cloud-key` land `VENDO_API_KEY` in `.env.local`. When
  `git check-ignore` says that file is not ignored, both print one line naming
  the fix. The write is never blocked — the key is already minted.
- **The keyless closing line stopped over-promising.** A run that resolved no
  model key now ends "the agent is live once you add a model key" instead of
  claiming it is live in your app.
- **A pages-only Next host gets instructions that work.** The manual wiring
  paste and the agent tail named `app/layout.tsx`, a file such a host does not
  have. They now name `pages/_app.tsx` and wrap `<Component {...pageProps} />`
  (the generated `vendo/vendo-root.tsx` is a client component, so it mounts
  there unchanged). Where the API route segment is scaffolded is unchanged.
- **An interactive init at a monorepo root names the real host.** Detection
  finds no `next`/`express` at a workspace root and falls through to the
  runtime-neutral `custom` scaffold — silently one level too high. It now names
  the workspace packages that do look like hosts ("did you mean apps/web?").
  Non-interactive runs already errored with the exact flag; unchanged.
