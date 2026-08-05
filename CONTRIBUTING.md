# Contributing to Vendo

Thanks for helping make Vendo better.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 22+, pnpm 11. The repo is a turbo monorepo: `packages/` are the published
`@vendoai/*` libraries. Behavior is now pinned by each package's types/zod schemas and tests, not prose docs (docs/archive/contracts is retired and historical only). Layering is enforced in `pnpm lint`. The demo host apps live under `apps/`.

## Making changes

- Branch from `main`; open a PR against `main`.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must pass.
- UI-affecting changes need before/after screenshots in the PR.
- Keep PRs focused; small is reviewable.
- Design specs for new work live in `docs/superpowers/specs` (decision records written while building, not maintained as ongoing law).

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](./SECURITY.md)
— do not open a public issue.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
