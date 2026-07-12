# Contributing to Vendo

Thanks for helping make Vendo better.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 20+, pnpm 9. The repo is a turbo monorepo: `packages/` are the published
`@vendoai/*` libraries, being rebuilt block by block against the frozen
contracts in `docs/contracts/` (read `00-overview.md` first). The pre-v0
packages and demo apps live under `legacy/` — a read-only quarry that new code
must never import (enforced in `pnpm lint`); the demos return in wave 7.

## Making changes

- Branch from `main`; open a PR against `main`.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must pass.
- UI-affecting changes need before/after screenshots in the PR.
- Keep PRs focused; small is reviewable.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](./SECURITY.md)
— do not open a public issue.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
