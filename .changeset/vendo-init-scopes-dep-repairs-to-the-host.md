---
"@vendoai/vendo": patch
---

`vendo init`'s two dependency repairs — the provider install and the zod floor
bump — now run with `pnpm add --ignore-workspace` when the host is an
independent pnpm project nested inside an unrelated pnpm workspace.

pnpm picks its workspace root by walking up to the nearest
`pnpm-workspace.yaml`, so an unqualified `pnpm add` in a repo that merely sits
inside someone else's monorepo installs against that ancestor. Two ways that
goes wrong: the ancestor's `overrides` rewrite the host's own pins (a host
pinning `next@14.2.5` under an ancestor pinning `next: ">=16.2.11"` gets a
next 16 tree), and under an older pnpm the add aborts against the ancestor's
store, so init only warns (E-DEP-003) and the zod floor never applies —
leaving the build red on `zod ./v4 not exported`.

Membership is decided by the ancestor workspace's own `packages:` globs
matched against the host's relative path, so a genuine member keeps ordinary
workspace behavior even if it carries a stale leaf lockfile, and a host that
has never installed is still recognized as a non-member. A pattern form the
reader does not model resolves to "member", which is the pre-existing
behavior.
