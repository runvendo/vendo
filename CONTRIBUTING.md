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
- `pnpm typecheck && pnpm lint` must pass, and so must the test files covering
  what you changed. CI runs the full suite on your PR, so running whole package
  suites locally first is optional.
- `pnpm lint` blocks on four things: the dependency guard, the portability
  gate, `eslint.blocking.config.mjs` over `packages/*`, and each `examples/*`
  app's own eslint. A rule joins the blocking config only when `packages/*`
  reports zero findings for it, so main stays green and every finding it prints
  is a new one; the rules still waiting on a clean tree are listed at the top
  of that file.
- `pnpm lint:report` is report-only and always exits 0. It runs the rest of
  eslint-plugin-sonarjs, plus knip, over `packages/*`. Nothing it prints blocks
  a merge; it exists so a rule can be judged from real counts before it goes
  blocking. Run it after `pnpm build` — knip loads each package's vite/vitest
  config, and those import built `dist/`.
- Before/after screenshots on a UI change are welcome and often the fastest way
  to review one, but they are not required.
- Keep PRs focused; small is reviewable.

## What happens to your PR

Vendo is developed in a private monorepo that also holds the closed-source
Cloud half, and the open-source half is projected out to this repo. Your change
travels in two steps, and only the first one involves you.

- **It is reviewed and merged here.** Your PR goes through this repo's merge
  queue and shows as merged, because it is — there is no internal PR standing in
  for it, and nothing closes your PR in place of merging it.
- **It is then imported inward**, into the private repo, by a maintainer. This
  needs nothing from you and leaves no trace on your PR.

That second step never merges itself. An import writes to the private repo from
a public source, so a maintainer — not a timer — is what puts your change in.
The import may be *proposed* automatically once your PR is merged here, but it
lands only when someone approves and merges it on the inside.

Maintainers: run the `upstream-import` workflow on `runvendo/vendo-cloud` via
`workflow_dispatch`, passing this PR's number as the `pr` input. It lands on
`oss/upstream-pr` and opens a PR there for review.

## Releases

Releases are automatic and CI-only, and nothing about them needs a maintainer
at a keyboard. When a version change lands on `main`,
`.github/workflows/tag-and-release.yml` pushes the matching `v*` tag and hands
it to `.github/workflows/release.yml`, which publishes the lockstep `@vendoai/*`
group to npm via OIDC trusted publishing — no npm tokens exist, in CI or
anywhere else.

Feature PRs include a changeset (`pnpm changeset`) describing the bump they
warrant — that part is yours, and it travels inward with your change. The
version bump itself is cut in the private monorepo, where the changesets are
consumed and the CHANGELOGs written; the result reaches this repo as an
ordinary sync commit, and `.github/workflows/tag-and-release.yml` tags it and
hands it to `release.yml`. Nothing on this repo opens a version PR.
Maintainers' full release runbook lives in the private repo.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](./SECURITY.md)
— do not open a public issue.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
