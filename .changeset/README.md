# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one
markdown file per user-facing change describing the bump it warrants.

## How releases work here

The published packages (the `fixed` list in `config.json`) are a **fixed
lockstep group**: any changeset that bumps one bumps all of them to the same
version. All other workspaces (`examples/*`, `fixtures/*`, `bench`,
`corpus/*`, `tools/*`) are `private` and are never versioned or published.

## Adding a changeset

```bash
pnpm changeset          # interactive: pick the bump + write a summary
```

Commit the generated `.changeset/*.md` file with your PR. Nothing enforces
this — a PR with no changeset still merges (the fleet auto-merges); check
`pnpm changeset status --since=origin/main` locally if unsure.

## Cutting a release

Nothing to do by hand. Every push to the private monorepo's `main` runs its
`Version Packages` workflow, which does the equivalent of

```bash
pnpm changeset:version  # consume changesets, bump the group, write CHANGELOGs
```

on a `changeset-release/main` branch and keeps ONE standing
"chore: version packages" PR open with the result. Merging that PR is the
release: the bump syncs out to the public repo, `tag-and-release.yml` there
notices `packages/vendo`'s version has no `vX.Y.Z` tag, tags it, and dispatches
`release.yml`, which publishes to npm via OIDC.

Run `pnpm changeset:version` locally only to see what the next version would
be — throw the result away rather than committing it.
