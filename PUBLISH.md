# Publishing

Releases are CI-only: tokenless npm publishes via OIDC trusted publishing from
the Release workflow. No npm login, no tokens. (The one-time 0.4.0 launch
procedure this file used to carry — first TTY publish, propagation checks,
unpublishing the pre-v0 era — was executed and lives in git history.)

Gotcha for any manual npm command: `~/.npmrc` has `min-release-age=7`, which
causes false `ENOVERSIONS` failures while fresh workspace dependencies
propagate. Prefix manual npm/pnpm registry commands with
`NPM_CONFIG_MIN_RELEASE_AGE=0`.

## Releases

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

## OPEN BLOCKER: `@vendoai/harnesses` first publish

`@vendoai/harnesses` joined the fixed group (`.changeset/config.json`) but has
never been published: `npm view @vendoai/harnesses` is a 404. Because
`release.yml` publishes **every** non-private `packages/*` workspace on a `v*`
tag, the next tag will attempt its first publish automatically — and that
publish will FAIL unless a trusted-publisher entry exists for it first.
Trusted publishing can only be configured for a package that already exists on
the registry, so the first `@vendoai/harnesses` publish has to come from
Yousef's TTY, after which the trusted publisher can be added.

Do this before tagging the next release:

```bash
NPM_CONFIG_MIN_RELEASE_AGE=0 pnpm --filter @vendoai/harnesses publish --access public --no-git-checks
```

Then add the trusted publisher (settings below) at
`https://www.npmjs.com/package/@vendoai/harnesses/access`.

## Trusted publishing configuration

Every published package needs a trusted publisher on its npm Access page
(`https://www.npmjs.com/package/<name>/access` — not general settings):

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

## Clean-room verification (after a release, if paranoid)

Verify the public install name in a fresh Next.js app. Init's starter model
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
npx --no-install vendo --version   # must print the released version
npx --no-install vendo init --yes
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3137 >"$root/dev.log" 2>&1 &
server_pid=$!
until curl --fail --silent http://127.0.0.1:3137/api/vendo/status >/dev/null; do sleep 1; done
npx --no-install vendo doctor --url http://127.0.0.1:3137/api/vendo
kill "$server_pid"
```

Success: CLI and `/status` both report the released version, init writes the
`.vendo` contract and Next wiring, the app builds, and doctor shows the wiring
checks and the `/status` live round-trip green. Without a model key doctor's
live model turn is `broken` by design and doctor exits nonzero — that is the
expected keyless outcome, not a packaging failure. Repeat with
`npm install @vendoai/vendo` for the scoped umbrella if paranoid.
