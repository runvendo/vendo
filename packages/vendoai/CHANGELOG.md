# vendoai

## 0.27.0

### Patch Changes

- Updated dependencies [c50597f]
- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [af2d337]
- Updated dependencies [2f79d98]
- Updated dependencies [a6ec9ba]
- Updated dependencies [bfaa06b]
- Updated dependencies [68bb5da]
- Updated dependencies [6f3cbc0]
- Updated dependencies [3fe1146]
- Updated dependencies [d45e0c1]
- Updated dependencies [e09d69a]
- Updated dependencies [c50597f]
- Updated dependencies [3fe1146]
- Updated dependencies [8daeabe]
- Updated dependencies [3fe1146]
  - @vendoai/vendo@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [c369e14]
  - @vendoai/vendo@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [374279e]
- Updated dependencies [6c26bfd]
- Updated dependencies [aa1c8db]
  - @vendoai/vendo@0.25.0

## 0.24.0

### Patch Changes

- @vendoai/vendo@0.24.0

## 0.23.0

### Patch Changes

- @vendoai/vendo@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [90c0de8]
  - @vendoai/vendo@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [46aee4a]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
  - @vendoai/vendo@0.21.0

## 0.20.0

### Patch Changes

- @vendoai/vendo@0.20.0

## 0.19.0

### Patch Changes

- @vendoai/vendo@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/vendo@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [c17d492]
- Updated dependencies [d1de477]
- Updated dependencies [0e29c39]
- Updated dependencies [54309b4]
- Updated dependencies [ea830ec]
- Updated dependencies [c875814]
- Updated dependencies [1865bdd]
- Updated dependencies [408b791]
- Updated dependencies [8ded5cc]
- Updated dependencies [8af9e4c]
  - @vendoai/vendo@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [d529cf8]
  - @vendoai/vendo@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [b57df06]
- Updated dependencies [b324b79]
- Updated dependencies [545416a]
- Updated dependencies [1529978]
- Updated dependencies [8f00291]
  - @vendoai/vendo@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
- Updated dependencies [4346712]
  - @vendoai/vendo@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [62d84ca]
- Updated dependencies [9034bcc]
- Updated dependencies [031195f]
  - @vendoai/vendo@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [abe327f]
  - @vendoai/vendo@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [eeebbee]
- Updated dependencies [a216b68]
- Updated dependencies [fc902aa]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/vendo@0.11.0

## 0.10.0

### Minor Changes

- b0a165c: Remix is a seeded app: the pins subsystem is gone

  An app that was made from one of your components no longer carries a list of
  "pins". It carries a single `seed` — the component it started from and the
  version of that component it started at. A remix is an ordinary app that
  happens to start from something, so it is created, validated, edited and
  versioned through exactly the same doors as every other app.

  **Behaviour change you will notice: updating a remix now replaces it.**
  When the host component changes, the remix reports drift as a warning and
  nothing happens on its own. If you choose to update, you get the pristine new
  component — the edits you made to that component are replaced. The previous
  release replayed your recorded edits on top of the new version; that machinery,
  its preflight and the version trail feeding it are deleted. Drift is a warning,
  and updating is always your choice. The UI says this in the drift banner, and
  the agent tool's description tells the model to say it too.

  **Behaviour change on admission.** Every write path now runs the same document
  validation, seeded and forked apps included. Seeded bundles used to skip the
  island gate entirely, so a capture the jail could never render was accepted
  without complaint. Captures that produce invalid documents will now be refused.

  **Fixed.** A seeded app whose host component had moved on used to open with no
  imports, no sub-modules and no styles — silently. Those furnishings were
  hash-matched against the live baseline at open time, so any drift lost them.
  They now travel inside the stored component bundle. Separately, artifact export
  dropped remix provenance because the interchange field whitelist never listed
  it, so export-permission checks never ran.

  **Renames.**

  - `AppDocument.pins?: Pin[]` → `AppDocument.seed?: AppSeed`
    (`{ component, baseline, slot?, review? }`). `Pin` and `pinSchema` are removed;
    `AppSeed` and `appSeedSchema` replace them. `forkedFrom` is unchanged.
  - `AppsRuntime.pins.{fork,rebase}` → `AppsRuntime.seed.{from,reseed}`, plus
    `seed.drift`. `seed.from({ component, slot?, instruction? })` and
    `seed.reseed({ appId })` both return the `AppDocument`.
  - `pinComponentName` → `seedComponentName`; `PinBaseline`/`pinBaselineSchema` →
    `SeedBaseline`/`seedBaselineSchema`; `AppsConfig.pinBaselines` →
    `seedBaselines`; `detectPinDrift` → `seedDrift` (one seed, so it returns one
    `SeedDrift` or `null`); `ScreenPinDrift` → `ScreenSeedDrift`.
  - `EditResult.driftedPins?: PinDrift[]` → `EditResult.seedDrift?: SeedDrift`;
    the tree payload's `pinDrift` array → a single `seedDrift`.
  - HTTP: `POST /apps/fork-pin` and `POST /apps/:id/fork-pin` → `POST /apps/seed`;
    `POST /apps/:id/rebase-pin` → `POST /apps/:id/reseed`.
  - Client: `apps.forkPin(...)` → `apps.seedFrom({ component, slot?, instruction? })`;
    `apps.rebasePin(id, slot)` → `apps.reseed(id)`.
  - Agent tool `vendo_apps_rebase_pin` (appId + slot) → `vendo_apps_reseed` (appId).
  - `@vendoai/actions` no longer declares its own `CapturedPinBaseline`; the one
    shape lives on `@vendoai/apps/contract` and actions re-exports it as
    `SeedBaseline` / `seedBaselineSchema`.
  - `PinForkInput`, `PinForkResult`, `PinRebaseResult` and `PinDrift` are removed.

  Seeding into an app that already exists is gone: the gesture always mints an
  app, because a seed is the provenance of a whole app rather than a row added to
  one. The generated component name stored inside documents is deliberately
  unchanged, so apps already on disk keep working.

### Patch Changes

- Updated dependencies [b0a165c]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [70644e3]
- Updated dependencies [384eb09]
- Updated dependencies [f9aa721]
- Updated dependencies [b642c4d]
- Updated dependencies [7f5d502]
- Updated dependencies [079d7d8]
- Updated dependencies [ed44a58]
  - @vendoai/vendo@0.10.0

## 0.9.0

### Patch Changes

- @vendoai/vendo@0.9.0

## 0.8.1

### Patch Changes

- 2357b22: The setup surface: declared URLs, one join law, a VendoProvider-only surface, and `init` = install + the shared sync flow.

  **Breaking: `VendoRoot` is removed. Use `VendoProvider`.**

  ```diff
  -import { VendoRoot } from "@vendoai/vendo/react";
  -<VendoRoot components={registry}>{children}</VendoRoot>
  +import { VendoProvider } from "@vendoai/vendo/react";
  +<VendoProvider baseUrl="/api/vendo" components={registry}>{children}</VendoProvider>
  ```

  That is the whole migration: the props are identical, and `baseUrl` is the wire
  mount with your deployment's path prefix included (default `/api/vendo`).
  `npx vendo doctor` names the swap and the file if you miss one (`E-WIRE-010`).

  **Breaking: `VENDO_BASE_URL` is the app's FULL public URL, path prefix included.**

  Set it to `https://site.com/maple`, not `https://site.com`. Nothing strips its path
  any more: host tool calls, login redirects and box callbacks all hang off it, each
  attaching the prefix exactly once through one helper in `@vendoai/core`. Two new
  optional overrides: `VENDO_HOST_API_URL` (the host API on another origin) and
  `VENDO_LOGIN_URL` (the login page, which may be on another domain).

  Stored tool paths in `.vendo/tools.json` are now **prefix-free** — run `vendo sync`
  once to regenerate them. This closes #866 (login redirect drops the base path),
  #867 (returnTo double-prefix) and #914 (host tools 404 under a path prefix). When the
  client and the server disagree about where the wire is mounted, the browser now gets
  one loud named error instead of a mysterious 404, and `vendo doctor` catches an
  OpenAPI server mount that disagrees with `VENDO_BASE_URL` (`E-CFG-003`).

  **`vendo init` no longer generates `vendo/registry.tsx` or `vendo/vendo-root.tsx`.**

  It scaffolds the server route handler and prints one paste: `<VendoProvider>` around
  your client root. If you have host components, you write one small `"use client"`
  file yourself — see the quickstart. Existing generated files are untouched; they are
  yours now.

  **`vendo init` ends in the same flow `vendo sync` runs.** One extraction, one theme
  path, one consent question, one report — `init` in full mode (a fresh install has
  judged nothing), `sync` incremental. `init` now reads `.env` as well as `.env.local`,
  so a model key that lives in `.env` is no longer invisible.

- Updated dependencies [a7a0fcf]
- Updated dependencies [8af0712]
- Updated dependencies [e092567]
- Updated dependencies [464dce8]
- Updated dependencies [b99147f]
- Updated dependencies [022f789]
- Updated dependencies [53717c4]
- Updated dependencies [d3e7dcd]
- Updated dependencies [9b72f48]
- Updated dependencies [354f231]
- Updated dependencies [d599d23]
- Updated dependencies [38e36a0]
- Updated dependencies [c3b7589]
- Updated dependencies [0d8f419]
- Updated dependencies [5f643c7]
- Updated dependencies [c05d1da]
- Updated dependencies [8792ab9]
- Updated dependencies [d31d2bf]
- Updated dependencies [d24162c]
- Updated dependencies [66d7db5]
- Updated dependencies [18d35bd]
- Updated dependencies [a621123]
- Updated dependencies [2357b22]
- Updated dependencies [9e14651]
  - @vendoai/vendo@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [963d980]
- Updated dependencies [10a2b44]
- Updated dependencies [1572060]
- Updated dependencies [3f98372]
- Updated dependencies [cfacf95]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [05ac24c]
- Updated dependencies [8d623ec]
- Updated dependencies [10a2b44]
- Updated dependencies [56e0cc3]
- Updated dependencies [a004031]
- Updated dependencies [c9df3f7]
- Updated dependencies [7c12970]
- Updated dependencies [6eb8a04]
- Updated dependencies [215bfcc]
- Updated dependencies [6c1273a]
- Updated dependencies [fbf265b]
- Updated dependencies [f7c6da2]
- Updated dependencies [dd1042c]
- Updated dependencies [2ed91b0]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [38dd824]
- Updated dependencies [798b618]
- Updated dependencies [8132329]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [6a3d9e3]
- Updated dependencies [b576ab9]
- Updated dependencies [a0dbfc6]
- Updated dependencies [a004031]
- Updated dependencies [39a7ecc]
  - @vendoai/vendo@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [47c53e9]
- Updated dependencies [c0f43b1]
- Updated dependencies [e56ed30]
- Updated dependencies [3cfde47]
- Updated dependencies [ed1940a]
- Updated dependencies [89b2455]
  - @vendoai/vendo@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [35e7431]
- Updated dependencies [a2bd192]
  - @vendoai/vendo@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
- Updated dependencies [db1915e]
- Updated dependencies [020fc8e]
- Updated dependencies [b14b209]
- Updated dependencies [a9aa714]
- Updated dependencies [23cdb00]
- Updated dependencies [e4d674b]
- Updated dependencies [2f0a421]
- Updated dependencies [c52629b]
- Updated dependencies [a7199db]
  - @vendoai/vendo@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [c7277f6]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [f95feb7]
- Updated dependencies [d1364b6]
- Updated dependencies [b94ac5a]
  - @vendoai/vendo@0.5.0

## 0.4.8

### Patch Changes

- Updated dependencies [9f01a92]
  - @vendoai/vendo@0.4.8

## 0.4.7

### Patch Changes

- Updated dependencies [bb74239]
  - @vendoai/vendo@0.4.7

## 0.4.6

### Patch Changes

- @vendoai/vendo@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [87eadba]
  - @vendoai/vendo@0.4.5

## 0.4.4

### Patch Changes

- Updated dependencies [52c72c2]
- Updated dependencies [835d17a]
- Updated dependencies [70b59db]
- Updated dependencies [0c1fca2]
  - @vendoai/vendo@0.4.4

## 0.4.3

### Patch Changes

- Updated dependencies [7355eed]
- Updated dependencies [a48b1b7]
  - @vendoai/vendo@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [8eaceb5]
  - @vendoai/vendo@0.4.2

## 0.4.1

### Patch Changes

- @vendoai/vendo@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [5d89564]
- Updated dependencies [b6def0f]
- Updated dependencies [fbe4a49]
- Updated dependencies [4b8ac66]
- Updated dependencies [2f67c65]
- Updated dependencies [023b3c0]
- Updated dependencies [ebc72e4]
- Updated dependencies [51f3fc9]
- Updated dependencies [b29f65d]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
  - @vendoai/vendo@0.4.0
