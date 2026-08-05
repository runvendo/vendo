# Contributing to Vendo

Thanks for helping make Vendo better.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 22+, pnpm 11. The repo is a turbo monorepo: `packages/` are the published
`@vendoai/*` libraries, built against the frozen contracts in
`docs/archive/contracts/` (read `00-overview.md` first; layering is enforced in
`pnpm lint`). The demo host apps live under `examples/`.

## Making changes

- Branch from `main`; open a PR against `main`.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must pass.
- UI-affecting changes need before/after screenshots in the PR.
- Keep PRs focused; small is reviewable.

## Releases

Releases are tag-driven and CI-only: pushing a `v*` tag runs
`.github/workflows/release.yml`, which publishes the lockstep `@vendoai/*`
group to npm via OIDC trusted publishing — no npm tokens exist, in CI or
anywhere else. Feature PRs include a changeset (`pnpm changeset`); the
Version Packages PR accumulates the bumps between releases. Maintainers'
full release runbook lives in the private repo.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](./SECURITY.md)
— do not open a public issue.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
