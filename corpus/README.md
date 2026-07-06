# OSS corpus

The corpus exercises `vendo init` against pinned open-source Next.js apps we do
not own. Corpus repos are cloned on demand under `corpus/.repos/`, which is
gitignored; do not commit foreign repo code or generated run artifacts.

## Commands

- `pnpm corpus --help` prints the current harness commands.
- `pnpm corpus validate` loads and validates `corpus/manifest.json`.
- `pnpm corpus list` prints the pinned repos in the manifest.
- `pnpm --filter @vendoai/corpus-harness test` runs the harness unit tests.

The harness currently validates/lists the manifest and has unit-tested helpers
for clone, bootstrap, and local package injection. Init and verification layers
land in later tasks.

## Local Vendo injection

The Vendo CLI's existing local/dev mode is:

```sh
vendo init [dir] --local <vendo-monorepo>
```

`--local=<vendo-monorepo>` is equivalent. That mode calls the CLI's
`installLocalVendoPackages()` path, packing local `@vendoai/*` workspace
packages and rewriting the host app to `file:vendor/*.tgz` dependencies and
overrides. The corpus harness reuses that local-pack mechanism and caches the
packed tarballs once per sweep before copying them into each repo.

Known local-pack hazard: paths containing spaces are rejected up front by the
harness. Keep both the Vendo workspace path and `corpus/.repos/<name>/` paths
space-free.

## Manifest

`corpus/manifest.json` is a JSON array. Each entry has:

- `name`: stable lowercase repo identifier.
- `gitUrl`: HTTPS git URL.
- `pinnedSha`: 40-character commit SHA from the repo's default branch.
- `license`: SPDX identifier or a documented best-effort license string.
- `tier`: `broad` or `deep`.
- `bootstrap`: install command, env template, optional seed command, build
  command, and for `deep` repos a dev-server command plus readiness URL.
- `notes`: optional verification notes.

Env template values are either literals or secret placeholders such as
`${CORPUS_UMAMI_DATABASE_URL}`. Later bootstrap code resolves placeholders from
the orchestrating environment; Vendo-specific wiring never belongs here.

## Adding a repo

1. Verify the default branch, HEAD SHA, license, and current Next.js stack with
   the GitHub API or `git ls-remote`.
2. Add one manifest entry pinned to the verified SHA.
3. Use the repo's lockfile to choose `pnpm install --frozen-lockfile`,
   `npm ci`, or the equivalent install command.
4. Copy only host-app setup needs into `envTemplate`; never add Vendo-specific
   env vars or code.
5. Run `pnpm corpus validate` and the harness tests.
