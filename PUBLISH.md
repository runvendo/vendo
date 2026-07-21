# Vendo 0.4.0 launch runbook

The 0.4.0 launch publish runs from Yousef's TTY because npm publish and
unpublish require passkey/WebAuthn 2FA, and because trusted publishing can
only be configured for packages that already exist on the registry. Every
release after this one is CI-only (see "Releases after launch").

## What will publish

`pnpm -r publish` skips private workspaces and publishes these thirteen
packages:

| Package | Version |
| --- | --- |
| `@vendoai/actions`, `@vendoai/agent`, `@vendoai/apps`, `@vendoai/automations`, `@vendoai/core`, `@vendoai/guard`, `@vendoai/mcp`, `@vendoai/store`, `@vendoai/ui`, `@vendoai/vendo`, `vendoai` | 0.4.0 (fixed group) |
| `@vendoai/telemetry` | 0.3.0 (hand-versioned) |
| `@vendoai/engine` | 0.1.0 (new; must ship or init's npx-engine ladder rung 404s) |

Demos, fixtures, corpus tooling/hosts, the benchmark, and spikes remain
`private: true`.

## Step 1 — publish from a TTY (launch day)

From the repository root on merged `main`, clean worktree, after `pnpm build`:

```bash
NPM_CONFIG_MIN_RELEASE_AGE=0 pnpm -r publish --access public --no-git-checks
```

The override is required: `~/.npmrc` has `min-release-age=7`, which otherwise
causes false `ENOVERSIONS` failures while fresh workspace dependencies are
being published. Keep it on every npm command in this runbook.

Then tag the release commit so the repo records what shipped (the Release
workflow will run and skip every already-published version — that no-op run
also proves the CI path):

```bash
git tag v0.4.0 && git push origin v0.4.0
```

## Step 2 — verify propagation

Brand-new scoped packages can return anonymous `404` for several minutes
after a successful publish. Wait and retry before treating that as a failure.

```bash
for package in \
  @vendoai/actions @vendoai/agent @vendoai/apps @vendoai/automations \
  @vendoai/core @vendoai/guard @vendoai/mcp @vendoai/store \
  @vendoai/ui @vendoai/vendo vendoai
do
  NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "$package@0.4.0" version
done
NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "@vendoai/telemetry@0.3.0" version
NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "@vendoai/engine@0.1.0" version
```

## Step 3 — unrelease the pre-0.4.0 era

0.4.0 is the first public release; everything older comes off the registry.
Run this only **after** Step 2 succeeds — fully unpublishing a package blocks
republishing that name for 24 hours, and an unpublished version number can
never be reused.

Remove the placeholder versions from packages that live on (this also kills
pnpm's silent non-strict remap to the broken 0.1.0 line):

```bash
NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish vendoai@0.0.1
NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish vendoai@0.1.0
NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish @vendoai/core@0.1.0
NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish @vendoai/store@0.1.0
NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish @vendoai/telemetry@0.1.0
```

Remove the dead pre-v0 package names entirely:

```bash
for package in \
  @vendoai/cli @vendoai/client @vendoai/components @vendoai/react \
  @vendoai/runtime @vendoai/server @vendoai/shell @vendoai/stage
do
  NPM_CONFIG_MIN_RELEASE_AGE=0 npm unpublish "$package" --force
done
```

npm allows unpublishing packages older than 72 hours only when they have no
dependents, under 300 weekly downloads, and a single maintainer — all true
for this set. If npm refuses one anyway, fall back to `npm deprecate` with
"Pre-v0 package; use vendoai instead."

## Step 4 — configure trusted publishing (one-time, ~15 min)

This is what makes every future release tokenless. For **each of the 13
packages**, open `https://www.npmjs.com/package/<name>/access` (the settings
live on the Access page, not general settings) and add a trusted publisher:

- Provider: **GitHub Actions**
- Organization or user: `runvendo`
- Repository: `vendo`
- Workflow filename: `release.yml` (filename only, with extension)
- Environment: leave blank
- Allowed actions: **npm publish**

The Release workflow already carries `permissions: id-token: write` and
deliberately does **not** set `registry-url` on setup-node — setup-node would
write an `_authToken` placeholder into `.npmrc` that defeats OIDC
(actions/setup-node#1551). Don't add it back, and never add an `NPM_TOKEN`
secret; there is none by design. The CI publish runs `pnpm pack` + `npm
publish <tarball>` rather than `pnpm publish`: pnpm 11.10's own OIDC token
exchange 404s against npmjs while the npm CLI (>= 11.5.1) works — don't
"simplify" it back to `pnpm publish` without re-testing that.

## Step 5 — clean-room verification

Verify each public install name in a fresh Next.js app. Init's starter model
module uses the AI SDK v6 Anthropic provider, so install the provider pair.
Use `npx --no-install vendo` only after the local package install; a global
deployment CLI also named `vendo` exists on this machine and can shadow
`npx vendo`.

```bash
root=$(mktemp -d /private/tmp/vendo-registry-check.XXXXXX)
cd "$root"
NPM_CONFIG_MIN_RELEASE_AGE=0 npx create-next-app@latest app --ts --tailwind --eslint --app --src-dir --use-npm --yes
cd app
NPM_CONFIG_MIN_RELEASE_AGE=0 npm install vendoai 'ai@^6' '@ai-sdk/anthropic@^3'
npx --no-install vendo --version   # must print 0.4.0
npx --no-install vendo init --yes
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3137 >"$root/dev.log" 2>&1 &
server_pid=$!
until curl --fail --silent http://127.0.0.1:3137/api/vendo/status >/dev/null; do sleep 1; done
npx --no-install vendo doctor --url http://127.0.0.1:3137/api/vendo
kill "$server_pid"
```

Success: CLI and `/status` both report `0.4.0`, init writes the `.vendo`
contract and Next wiring, the app builds, and doctor shows the wiring checks
and the `/status` live round-trip green. Without a model key doctor's live
model turn is `broken` by design and doctor exits nonzero — that is the
expected keyless outcome, not a packaging failure. Repeat with
`npm install @vendoai/vendo` for the scoped umbrella if paranoid.

## Releases after launch

Steady state is two clicks and a tag; no npm login, no tokens:

1. Feature PRs include a changeset (`pnpm changeset`).
2. The **Version Packages** workflow keeps a `chore: version packages` PR
   open on `main` with the accumulated bumps and changelogs. PRs opened by
   the default `GITHUB_TOKEN` don't trigger CI — close and reopen the PR to
   run checks before merging.
3. Merge it, then tag the merge commit: `git tag vX.Y.Z && git push origin
   vX.Y.Z`. The Release workflow runs build/test/typecheck/lint and publishes
   via OIDC trusted publishing with provenance. Re-runs are safe — pnpm skips
   versions already on the registry.
4. To rehearse without publishing, dispatch the Release workflow manually
   (Actions → Release → Run workflow); that runs the full gate stack plus
   `pnpm publish --dry-run`.
