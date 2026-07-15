# Vendo 0.3.0 publish runbook

This runbook is for Yousef's TTY because npm publishing and deprecation require
passkey/WebAuthn 2FA. The repository is publish-ready; this document does not
authorize an automated or sandboxed publish.

## What will publish

`pnpm -r publish` skips private workspaces and publishes these twelve packages
at `0.3.0`:

- `@vendoai/actions`
- `@vendoai/agent`
- `@vendoai/apps`
- `@vendoai/automations`
- `@vendoai/core`
- `@vendoai/guard`
- `@vendoai/mcp`
- `@vendoai/store`
- `@vendoai/telemetry`
- `@vendoai/ui`
- `@vendoai/vendo`
- `vendoai`

Demos, fixtures, corpus tooling/hosts, the benchmark, and spikes remain
`private: true`. There is no separate sandbox-shims package to publish; the
runtime artifacts needed by consumers are already inside the owning packages'
`dist` directories.

## Publish from a TTY

From the repository root on the reviewed commit, with a clean worktree:

```bash
NPM_CONFIG_MIN_RELEASE_AGE=0 pnpm -r publish --access public --no-git-checks
```

The override is required: `~/.npmrc` has `min-release-age=7`, which otherwise
causes false `ENOVERSIONS` failures while fresh workspace dependencies are
being published.

## Deprecate the pre-v0 package line

Run these after 0.3.0 is visible. The unscoped `vendoai` package is superseded
by `vendoai@0.3.0` and must **not** be deprecated.

```bash
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/cli@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/client@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/components@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/core@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/react@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/runtime@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/server@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/shell@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/stage@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/store@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
NPM_CONFIG_MIN_RELEASE_AGE=0 npm deprecate "@vendoai/telemetry@0.1.0" "Pre-v0 package; use vendoai instead. See https://docs.vendo.run/quickstart."
```

## Registry propagation check

Brand-new scoped packages can return anonymous `404` responses for several
minutes after a successful publish. Wait and retry before treating that as a
failure. Keep the release-age override on every view/install check:

```bash
for package in \
  @vendoai/actions @vendoai/agent @vendoai/apps @vendoai/automations \
  @vendoai/core @vendoai/guard @vendoai/mcp @vendoai/store \
  @vendoai/telemetry @vendoai/ui @vendoai/vendo vendoai
do
  NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "$package@0.3.0" version
done

NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "@vendoai/vendo@0.3.0" readme | sed -n '1,20p'
NPM_CONFIG_MIN_RELEASE_AGE=0 npm view "vendoai@0.3.0" readme | sed -n '1,20p'
```

## Post-publish clean-room verification

Verify each public install name in its own fresh Next.js app. The starter model
module written by init uses the AI SDK v6 Anthropic provider, so install the two
provider packages before building. Use `npx --no-install vendo` only after the
local package install; a global deployment CLI also named `vendo` exists on this
machine and can shadow `npx vendo` when neither Vendo npm package is local.

### Unscoped alias

```bash
alias_root=$(mktemp -d /private/tmp/vendo-registry-alias.XXXXXX)
cd "$alias_root"
NPM_CONFIG_MIN_RELEASE_AGE=0 npx create-next-app@16.2.9 app --ts --tailwind --eslint --app --src-dir --use-npm --yes
cd app
NPM_CONFIG_MIN_RELEASE_AGE=0 npm install vendoai 'ai@^6' '@ai-sdk/anthropic@^3'
npx --no-install vendo --version
npx --no-install vendo init --yes --brief 'Vendo 0.3.0 registry verification.'
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3137 >"$alias_root/dev.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
until curl --fail --silent http://127.0.0.1:3137/api/vendo/status >/dev/null; do sleep 1; done
npx --no-install vendo doctor --url http://127.0.0.1:3137/api/vendo
kill "$server_pid"
wait "$server_pid" || true
trap - EXIT
```

### Scoped umbrella

```bash
scoped_root=$(mktemp -d /private/tmp/vendo-registry-scoped.XXXXXX)
cd "$scoped_root"
NPM_CONFIG_MIN_RELEASE_AGE=0 npx create-next-app@16.2.9 app --ts --tailwind --eslint --app --src-dir --use-npm --yes
cd app
NPM_CONFIG_MIN_RELEASE_AGE=0 npm install @vendoai/vendo 'ai@^6' '@ai-sdk/anthropic@^3'
npx --no-install vendo --version
npx --no-install vendo init --yes --brief 'Vendo 0.3.0 registry verification.'
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3138 >"$scoped_root/dev.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
until curl --fail --silent http://127.0.0.1:3138/api/vendo/status >/dev/null; do sleep 1; done
npx --no-install vendo doctor --url http://127.0.0.1:3138/api/vendo
kill "$server_pid"
wait "$server_pid" || true
trap - EXIT
```

Success means both installs report CLI version `0.3.0`, init writes the complete
`.vendo` contract and Next wiring, the app builds, and doctor reports a live
`/status` round trip with version `0.3.0`.

## Local rehearsal evidence

Rehearsed on 2026-07-14 in
`/private/tmp/vendo-install-dx-wave1.hedhyg`:

- Packed all 12 public workspaces; every tarball was version `0.3.0`, contained
  `README.md`, and had zero remaining `workspace:` references.
- Confirmed `vendoai` packed `@vendoai/vendo` as concrete version `0.3.0`.
- Created a fresh Next.js 16.2.9 app and installed all 12 local tarballs plus
  the documented AI SDK v6 provider pair.
- `npx vendo --version` printed `0.3.0`; `npx vendo init --yes` completed; the
  generated app passed `next build`.
- Both the alias and canonical bin entry points printed `0.3.0`, and all three
  exports (`.`, `./server`, and `./react`) imported through both package names.
- Booted the app on `127.0.0.1:3137`; `npx vendo doctor` exited 0 after a live
  `/status` response reporting `0.3.0` and posture `unconfigured`.

### Friction log

- The local-tarball injector omitted `@vendoai/mcp`, allowing the umbrella's
  dependency to fall through to the unpublished registry package. The injector
  and its pack-once regression test now include MCP.
- `@vendoai/telemetry` was still versioned `0.2.0`; it is now aligned with the
  locked 0.3.0 block set.
- Init intentionally writes a starter model module but does not install its
  provider. Installing the exact pair printed by init (`ai@^6` and
  `@ai-sdk/anthropic@^3`) made the clean app build; credential/model ladder work
  remains Wave 2.
- npm reported two moderate transitive audit findings and allow-scripts notices
  for `sharp` and `unrs-resolver`; neither affected install, build, init, or
  doctor.
- The first dev compilation of `/api/vendo/status` took about 12 seconds;
  doctor waited and passed.
