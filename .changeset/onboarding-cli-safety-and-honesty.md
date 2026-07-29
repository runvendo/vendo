---
"@vendoai/vendo": patch
---

Onboarding safety and honesty: four fixes to the first `vendo init`.

- **A secret written into a committed file now says so.** `vendo login` and
  `vendo init --cloud-key` land `VENDO_API_KEY` in `.env.local`, and now say one
  line about whether git will commit it, with the remediation that actually
  works: `git rm --cached` when the file is already tracked (where .gitignore
  cannot help), the .gitignore line when it is untracked and unignored, and an
  explicit "git could not answer" when a live repo errors. Silent when the file
  is ignored, and when there is no repository or no git at all. The write is
  never blocked — the key is already minted.
- **The closing line stopped over-promising.** It claimed "the agent is live in
  your app" whenever a rung resolved — including a malformed `VENDO_API_KEY` or
  `VENDO_DEV_CREDENTIAL=vendo-cloud` with no key, both of which resolve a rung
  and cannot serve a turn. It now says "the agent is live once you add a model
  key" unless the credential is actually usable.
- **A pages-only Next host gets instructions that work.** The manual wiring
  paste and the agent tail named `app/layout.tsx`, a file such a host does not
  have. They now name `pages/_app.tsx` and wrap `<Component {...pageProps} />`
  (the generated `vendo/vendo-root.tsx` is a client component, so it mounts
  there unchanged). Where the API route segment is scaffolded is unchanged.
- **An interactive init at a monorepo root names the real host.** Detection
  finds no `next`/`express` at a workspace root and falls through to the
  runtime-neutral `custom` scaffold — silently one level too high. It now names
  the workspace packages that do look like hosts ("did you mean apps/web?") and
  suggests a path that resolves from the caller's own cwd, quoted when it
  contains a space. Non-interactive runs already errored with the exact flag;
  unchanged.
