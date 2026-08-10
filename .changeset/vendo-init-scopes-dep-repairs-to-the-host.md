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

The host's own `pnpm-lock.yaml` is what proves it is not a member: pnpm keeps
exactly one lockfile, at the workspace root, never inside a member package.
Genuine workspace members — and hosts that are their own workspace root —
keep today's behavior exactly.
