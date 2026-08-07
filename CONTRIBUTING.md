# Contributing to Vendo

Thanks for helping make Vendo better.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 22+, pnpm 11. The repo is a turbo monorepo: `packages/` are the published
`@vendoai/*` libraries. The behavior contract is each package's exported
types/zod schemas and its test suites (layering is enforced in `pnpm lint`).
The demo host apps live under `examples/`.

## Making changes

- Branch from `main`; open a PR against `main`.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must pass.
- `pnpm lint:report` is report-only and always exits 0. It runs
  eslint-plugin-sonarjs and knip over `packages/*`, which `pnpm lint` does not
  cover. Nothing it prints blocks a merge; it exists so a rule set can be
  chosen from real counts. Run it after `pnpm build` — knip loads each
  package's vite/vitest config, and those import built `dist/`.
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
