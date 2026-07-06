# Release Hardening Inventory — 2026-07-05

The triaged issue inventory for the OSS release, judged against
[the release bar](2026-07-05-release-hardening-bar.md). Sources: a 14-auditor
multi-agent code audit (every finding adversarially verified — Claude 3-vote
panels or a Codex refutation pass), a publish-fidelity install e2e (all 12
packages packed to tarballs, fresh create-next-app, `vendo init`, boot), and
a browser UI bug bash (separate doc: the UI decision queue).

**Totals: 131 confirmed findings — 15 blocker-severity (9 unique root causes),
57 major, 59 minor.** One finding was refuted and dropped.

## Where things stand

### Fixed on `yousefh409/hardening-fixes` (PR forthcoming)

Six commits, each TDD'd with the failure reproduced first:

1. **CLI bin silent no-op under npm** (`cli.ts` entrypoint guard vs. npm's
   .bin symlinks/spaces/Windows) — broke `npx vendo init` and the wired
   `prebuild: vendo sync` on every npm install. pnpm masked it in-repo.
2. **Publish manifest hygiene** — sandbox-shims un-privated (the published
   CLI depends on it at runtime), `files` allowlists everywhere (react was
   shipping `.turbo` logs with absolute paths), `publishConfig.access
   public` on all scoped packages, CLI's duplicate typescript dep dropped.
   New gate: `scripts/check-publish-hygiene.mjs`.
3. **Scheduler firing isolation** (runtime blocker) — one rejecting firing
   handler was an unhandled rejection (process crash on default Node) AND
   silently starved every other due schedule in the consumed window.
4. **pg.Pool error listener** (store blocker) — an idle Postgres connection
   drop crashed the entire host app.
5. **NodeNext dists** — all 11 tsc-built packages now import cleanly under
   plain Node (was: `ERR_MODULE_NOT_FOUND` on every entrypoint; the
   documented Express/node:http flow could not start). New gate:
   `scripts/check-node-esm.mjs`.
6. **Missing provider peer degrades** (server blocker) — OPENAI/GOOGLE
   one-key installs 500ed every route; now degrades like the keyless ladder
   state with the actionable `npm i` hint in the chat 503 and server log.

### Blockers needing YOUSEF'S DECISION (cannot be fixed unilaterally)

1. **fluidkit distribution.** `@vendoai/shell` depends on
   `file:../../vendor/fluidkit-0.5.0-…tgz` — uninstallable off npm; consumer
   installs abort. Options: (a) publish fluidkit to npm from runvendo/fluidkit
   (recommended — honest dep graph, hosts can dedupe), (b) bundle fluidkit
   into shell's dist, (c) inline the tgz into the published package. Blocks
   any npm publish.
2. **License.** No LICENSE file, no `license` field anywhere — the OSS
   release ships legally unlicensed (default: all rights reserved; nobody
   can legally use it). Needs your choice (MIT / Apache-2.0 / other), then a
   mechanical sweep adds the file + fields.

### Remaining majors, themed as the next fix waves

- **Wave: error hygiene (12 findings)** — raw internal errors reach users:
  boot/assembly errors echoed verbatim to unauthenticated callers (server +
  next), run failures streaming provider 401s to the client (runtime), raw
  tool errorText rendered in the DOM (shell ActivityStep/ToolCall, react
  host-tool path, stage bridge). One consistent policy: log the detail
  server-side, show a friendly line, never raw text in the DOM.
- **Wave: policy & approval integrity (7)** — reads-only replay guard fails
  open on unvalidated annotations (next); MCP dynamic-tool approvals bypass
  the consent/audit/grant channel entirely (shell/seams); saved-vendo
  mutations lack CSRF/origin protection under cookie principals (next);
  parked-actions routes skip the single-tenant fail-closed guard (server);
  /action executes server tools with schema-unvalidated payloads (server);
  openApiToHostTools fail-open on GETs contradicts the extractor's
  fail-closed contract (core/seams); HOST_RELATIVE_PATH backslash bypass →
  credentialed cross-origin fetch (core).
- **Wave: install/init correctness (4)** — init wires `prebuild: vendo sync`
  without adding @vendoai/cli to app deps; instrumentation.ts scheduler boot
  silently dead on Next 13/14 (no instrumentationHook flag); generated
  .vendo/components build imports packages init never installs; sync
  local-module vendoring collides on bare specifiers across anchors.
- **Wave: integrations truthfulness (3)** — status reports "active" without
  connecting the toolkit in the store; disconnect silently succeeds on
  server rejection; status poll swallows all Composio errors.
- **Wave: telemetry consent (3)** — collection without disclosure when the
  dev server burns the one-time notice; NODE_ENV-unset fails open;
  explicit opt-out config silently overwritten to opted-in.
- **Wave: sandbox shims completeness (4)** — next/navigation missing
  useParams/redirect/notFound; swr shim missing useSWRConfig/mutate/preload
  and permanent isLoading for conditional keys; dispatch drops the bridge
  promise; Link drops query/hash.
- **Wave: react/runtime state (5)** — conversation wiped when
  hostTools.definitions identity changes (react); VendoStage node={null}
  leaves stale sandbox mounted; render_view ships unresolvable imports but
  reports "rendered"; agent-step idempotency keys collide across runs;
  JSONata timeout can't preempt sync work.
- **UI-adjacent majors** are in the UI decision queue for your review, not
  here (blank-sandbox fallback, approval-card gaps, voice shortcut/mic
  issues, hardcoded 'Maple' string in the voice drawer).

### Minors (59)

Inventoried in the detail section below; none block release by the bar.
Notables worth batching into the waves above: capabilities principal-guard
bypass discloses config; VendoDb.cacheKey carries the raw Postgres password
on an exported handle; telemetry tests write to the real `~/.vendo`.

---

# Full detail (generated from verified findings)

## BLOCKERS (15)

### [cross-package-seams] Published dists are not loadable from plain Node (ESM extensionless/directory imports)
- file: `tsconfig.base.json:5` · kind: publish-hygiene · verified by: codex

All tsc-built packages compile with module:ESNext + moduleResolution:Bundler, so extensionless relative imports (and directory imports like `export * from "./manifest"` in packages/vendo-core/src/index.ts) are emitted verbatim into dist. Plain Node ESM requires explicit file extensions. Verified: `node -e "import('./packages/vendo-core/dist/index.js')"` fails with ERR_MODULE_NOT_FOUND on './schema'; Codex independently verified the same failure for vendo-runtime, vendo-server, vendo-next (incl. /client), vendo-react, vendo-shell, and vendo-store dists. Concrete failure: any non-bundler consumer — including @vendoai/server's own `toNodeHandler` (src/node.ts), whose entire purpose is plain-Node/Express hosting — crashes at import time after `npm i @vendoai/server`. Additionally @vendoai/shell dist executes `import "./styles.css"` at module load (src/index.ts:1), which Node rejects (ERR_UNKNOWN_FILE_EXTENSION) even after extensions are fixed. Known pre-release debt (memory: 'dists need NodeNext before ENG-198') — still unfixed on main.

### [cross-package-seams] @vendoai/shell depends on fluidkit via a local file: tarball — uninstallable from npm
- file: `packages/vendo-shell/package.json:23` · kind: publish-hygiene · verified by: codex

Dependency is "fluidkit": "file:../../vendor/fluidkit-0.5.0-656857b.tgz". When @vendoai/shell is published, that relative path does not exist on consumer machines, so `npm i @vendoai/shell` fails to resolve the dependency. This transitively breaks @vendoai/server (depends on @vendoai/shell, package.json dependencies) and @vendoai/next — i.e., the entire `vendo init` install flow (critical flow 1) is dead on arrival for real users. Fluidkit is not on the npm registry (vendored precisely because it isn't published), and its own peers include a pinned @paper-design/shaders-react@0.0.76 that no Vendo package declares. Fluidkit must be published (or inlined) before any @vendoai package ships.

### [cross-package-seams] @vendoai/cli depends on private @vendoai/sandbox-shims — published CLI is uninstallable and `vendo sync` breaks
- file: `packages/vendo-cli/package.json:14` · kind: publish-hygiene · verified by: codex

packages/vendo-sandbox-shims/package.json sets "private": true, yet @vendoai/cli lists "@vendoai/sandbox-shims": "workspace:*" in dependencies. This is a real runtime dependency, not a bundling leftover: packages/vendo-cli/src/sync/env.ts:190 resolves the installed package at runtime via createRequire(...).resolve("@vendoai/sandbox-shims") to esbuild-bundle framework shims (next/link, swr, ...) into the host's sandbox. On publish, pnpm rewrites workspace:* to a concrete version of a package that can never exist on the registry, so `npm i -g @vendoai/cli` (or npx vendo init) fails outright; even if the dep were dropped, `vendo sync`'s shim vendoring would throw at resolve time. The release bar's scope line says all 12 packages/* are publishable — sandbox-shims' private flag contradicts that. Either unmark it private and publish it, or vendor the shim sources into the CLI package.

### [publish-hygiene] @vendoai/shell depends on a local vendored tarball (fluidkit: file:../../vendor/...tgz) — uninstallable after publish
- file: `packages/vendo-shell/package.json:23` · kind: publish-hygiene · verified by: codex

The dependency "fluidkit": "file:../../vendor/fluidkit-0.5.0-656857b.tgz" is published verbatim (pnpm/npm only rewrite workspace:/link: protocols, not file:). Any consumer running `npm i @vendoai/shell` gets ENOENT resolving a vendor/ path that only exists in the monorepo. Since @vendoai/next depends on @vendoai/shell, the entire `vendo init` install chain (flow 1) fails at npm install. fluidkit must be published to the registry or bundled before release.

### [publish-hygiene] @vendoai/cli has a production dependency on @vendoai/sandbox-shims, which is private:true and can never be published
- file: `packages/vendo-cli/package.json:17` · kind: publish-hygiene · verified by: codex

packages/vendo-sandbox-shims/package.json has "private": true, but @vendoai/cli lists it under dependencies (workspace:*), and it is a real runtime dependency: src/sync/env.ts:190 does createRequire(...).resolve("@vendoai/sandbox-shims") to bundle next/link, next/image, next/navigation and swr shims during `vendo sync`. After publish, `npm i -D @vendoai/cli` 404s on @vendoai/sandbox-shims and the CLI is uninstallable; even if the dep were dropped, `vendo sync` would mark all framework shims absent, silently degrading remix. The shims package must be un-privated and published (its files:["dist"] + exports are otherwise publish-ready).

### [publish-hygiene] 10 of 11 library packages ship dist ESM that plain Node cannot load (extensionless relative imports)
- file: `tsconfig.base.json:4` · kind: publish-hygiene · verified by: codex

tsconfig.base.json uses module ESNext + moduleResolution Bundler, so tsc emits `export * from "./schema"` without .js extensions. Verified by importing every package's dist/index.js in Node: core, server, runtime, store (via runtime), react, shell, components, next, stage, and sandbox-shims all throw ERR_MODULE_NOT_FOUND; only telemetry loads. Concrete failures: any non-bundler consumer (`node -e 'import("@vendoai/core")'`, a Node script driving @vendoai/store migrations, or Next with @vendoai/store in serverExternalPackages — the usual requirement for PGlite) crashes before user code runs; TS consumers on moduleResolution node16/nodenext also fail to resolve the d.ts. This was already flagged internally as "dists need NodeNext before ENG-198" and is unresolved.

### [publish-hygiene] No LICENSE file and no license field anywhere in the repo — the OSS release ships legally unlicensed code
- file: `packages/vendo-core/package.json` · kind: publish-hygiene · verified by: codex

There is no LICENSE file at the repo root or in any of the 12 packages, and none of the 12 package.json manifests has a "license" field. Published packages would show "license: none" on npm; under default copyright law consumers have no right to use, modify, or redistribute the code, and license scanners in consumer CI (e.g. FOSSA, npm audit policies) will reject the packages. For a first OSS release this is a hard blocker: pick a license, add LICENSE at root, copy into each package (or rely on files+root), and add the license field to all 12 manifests.

### [vendo-cli] CLI bin silently no-ops when invoked via npm's .bin symlink, paths with spaces, or Windows
- file: `packages/vendo-cli/src/cli.ts:52` · kind: silent-failure · verified by: codex

The auto-run gate compares `import.meta.url === `file://${process.argv[1]}``. Node realpath-resolves the ESM entry (import.meta.url becomes the resolved dist/cli.js URL, percent-encoded) while argv[1] stays the invoked path. Empirically verified in this session: running the exact pattern through a symlink (how npm links node_modules/.bin/vendo — the documented quickstart is `npm install -D @vendoai/cli` then `npx vendo init .`) or from a directory containing a space prints NOTHING and exits 0 — main() never runs. Windows fails too (`file://C:\...` never equals `file:///C:/...`). Direct `node dist/cli.js` works, and pnpm's shell-shim bins work, which is why monorepo testing never caught it. Consequence: for npm/yarn users the entire install flow (release-bar flow 1) is a silent no-op, and the `prebuild: vendo sync` script wired into every initialized app also silently does nothing (exit 0), so remix capture/env refresh never happens while builds appear green. Fix: use pathToFileURL(process.argv[1]) with realpath, or drop the gate for the bin bundle.

### [vendo-components] Published ESM dist is not loadable in Node — breaks the documented server-safe /descriptors entrypoint
- file: `packages/vendo-components/package.json:7` · kind: bug · verified by: claude-panel

The package is "type": "module" and built with plain tsc under moduleResolution: Bundler, so dist keeps extensionless relative imports (dist/descriptors.js line 1: `import { cardDescriptor } from "./components/Card/descriptor"`). Verified: `node -e "import('./dist/descriptors.js')"` throws ERR_MODULE_NOT_FOUND. The /descriptors entrypoint is explicitly documented as "the one server code may import", and @vendoai/server/src/fetch-handler.ts imports `@vendoai/components/descriptors` at module top level — @vendoai/server is likewise plain-tsc/extensionless. Any host running the framework-agnostic server unbundled (plain `node server.js` with an Express handler — the exact provider-agnostic/non-Next flow in the release bar) crashes at startup. Only bundler-mediated consumers (Next.js) work. Matches the known pre-ENG-198 note "dists need NodeNext" but is unfixed on this branch.

### [vendo-runtime] Scheduler tick has no per-schedule error isolation: one failing fire causes an unhandled rejection (process crash) and silently drops all other due fires
- file: `packages/vendo-runtime/src/automations/in-process-scheduler.ts:84` · kind: silent-failure · verified by: claude-panel

InProcessScheduler.tick() awaits this.handler(firing) inside the loop with no try/catch, and start() invokes it as `void this.tick()` (line 62) with no .catch. The registered handler is createSchedulerFiringHandler -> runner.fire(), which rejects on any store error other than DuplicateRunError (e.g. a transient PGlite/Postgres failure in createRun/get/listRuns on the durable path vendo-server boots via scheduler.start()). Concrete scenario: a durable install with 3 scheduled automations; at tick time the DB hiccups on the first automation's createRun -> handler rejects -> tick() rejects -> unhandled promise rejection, which terminates the Node process under the default ERR_UNHANDLED_REJECTION behavior (Node >= 15). Even if the host registers a global rejection handler, lastTickMs was already advanced at the top of tick(), so the OTHER automations due in that same window are silently skipped forever (their occurrence falls outside every future window). This directly breaks critical flow 4 (automations survive restarts — here a single transient error CAUSES the restart) and is a textbook silent failure on a critical path. Fix shape: wrap each handler invocation in try/catch (log + continue), and/or only advance lastTickMs after a successful pass.

### [vendo-sandbox-shims] Package is private:true but is a runtime dependency of the publishable CLI — published vendo CLI is uninstallable or vendo sync crashes
- file: `packages/vendo-sandbox-shims/package.json:5` · kind: publish-hygiene · verified by: claude-panel

@vendoai/cli declares "@vendoai/sandbox-shims": "workspace:*" in dependencies (packages/vendo-cli/package.json:17) and resolves the package's dist from node_modules at RUNTIME via createRequire(import.meta.url).resolve("@vendoai/sandbox-shims") in packages/vendo-cli/src/sync/env.ts:190 (the CLI's vite bundle cannot inline this — it is a runtime string resolve of on-disk files). Because sandbox-shims is "private": true it will never exist on npm, so publishing @vendoai/cli either fails outright or produces a package whose install 404s on @vendoai/sandbox-shims@0.0.0. Even if installed with the dep skipped, the resolve at env.ts:188-190 sits OUTSIDE the per-specifier try/catch, so `vendo sync` throws for every app whose anchors import next/link/next/image/next/navigation/swr — i.e. essentially every real Next.js host. This breaks critical flow 1 (vendo init/sync) and flow 6 (remix) for all OSS users. The release bar also counts "the 12 publishable packages (packages/*)" and this is one of the 12. Fix: either publish the package (drop private, keep files:["dist"]) or bundle the shim dist files into the CLI's dist/assets like bundle-assets.mjs already does for the react runtime and components bundle.

### [vendo-server] OpenAI/Google one-key installs 500 on every route until a manual peer install, while /capabilities claims chat is available
- file: `packages/vendo-server/package.json:35` · kind: api-inconsistency · verified by: codex

@ai-sdk/openai and @ai-sdk/google are optional peerDependencies (package.json:35-42) that neither npm/pnpm nor `vendo init` (next-wiring.ts only adds @vendoai/next) ever install. resolveModel() (src/model.ts:95) dynamically imports the provider at first-request assembly, so a fresh Next.js app with only OPENAI_API_KEY set boots every single route into a 500 ('requires @ai-sdk/openai — run: npm i @ai-sdk/openai') while GET /capabilities — computed from key presence alone (src/capabilities.ts:45) — reports chat:true, so the client shows a chat surface that can never answer. This directly fails release-bar critical flow 9 ('Provider choice: the above works with OpenAI and Google keys, not just Anthropic') combined with flow 1's one-key install promise; the fix belongs either in the CLI (install the matching peer) or in shipping the peers as real deps.

### [vendo-shell] Published package is uninstallable: fluidkit is a local file: tarball dependency
- file: `packages/vendo-shell/package.json:23` · kind: publish-hygiene · verified by: claude-panel

`"fluidkit": "file:../../vendor/fluidkit-0.5.0-656857b.tgz"` ships verbatim in the published manifest — unlike `workspace:*` specs, pnpm publish does NOT rewrite `file:` specs. Failure scenario: any host app runs `npm install @vendoai/shell` (directly or transitively via @vendoai/next) and install fails resolving `../../vendor/fluidkit-0.5.0-656857b.tgz`, which does not exist outside this monorepo. This bricks the entire `vendo init` install flow (critical flow #1) for every OSS consumer. fluidkit must be published to npm (or vendored/inlined) before release.

### [vendo-shell] dist/index.js is not loadable as native ESM: extensionless relative imports
- file: `packages/vendo-shell/package.json:8` · kind: publish-hygiene · verified by: claude-panel

The package is `"type": "module"` with exports pointing at `./dist/index.js`, but tsc (moduleResolution: Bundler) emits extensionless re-exports (`export * from "./theme"`). Verified: `node --input-type=module -e "import('./packages/vendo-shell/dist/index.js')"` fails with ERR_MODULE_NOT_FOUND for `dist/theme`. Failure scenario: any Node ESM/SSR consumer (and webpack's fullySpecified ESM resolution in a stock Next.js app importing the published package) fails at import time. Matches the known pre-ENG-198 note that dists need NodeNext; it is now release-gating. The `import "./styles.css"` at the top of dist/index.js compounds this for non-bundler consumers.

### [vendo-store] pg.Pool created with no 'error' listener — an idle connection drop crashes the entire host app
- file: `packages/vendo-store/src/db.ts:48` · kind: bug · verified by: codex

createVendoDatabase's Postgres path does `drizzlePg(new Pool({ connectionString: conn }))` and never attaches a pool 'error' handler (no other code does either; verified by grep across vendo-store and vendo-server). pg-pool re-emits idle-client errors on the pool (node_modules/pg-pool/index.js:62 `pool.emit('error', err, client)`); an EventEmitter 'error' event with no listener throws and kills the Node process. Concrete scenario: a host sets DATABASE_URL to Supabase/Neon/RDS (exactly what the PGlite serverless guard tells users to do), an idle pooled connection is terminated by the server (routine on hosted Postgres — idle timeouts, restarts, failover) -> the whole Next.js server process crashes, taking the host app down. This directly breaks release-bar flow 4 (durable automations on Postgres) in its recommended production configuration. Fix is one line: `pool.on('error', ...)` that logs.

## MAJORS (57)

### [cross-package-seams] openApiToHostTools fail-open on GETs contradicts the CLI extractor's fail-closed contract — side-effecting GETs run unapproved
- file: `packages/vendo-core/src/host-api.ts:103` · kind: security · verified by: codex

Core's public OpenAPI adapter marks every GET/HEAD readOnlyHint:true, and the runtime's annotationPolicy (packages/vendo-runtime/src/policy/annotation.ts:29) maps readOnlyHint straight to "allow" — no approval, no consent part, no audit ceremony. Meanwhile the CLI extractor for the exact same host APIs deliberately fails closed (packages/vendo-cli/src/tools/manifest.ts: ambiguous GETs become mutating:true, 'HTTP method alone is not evidence'). So the two supported ways to wire host tools apply opposite security postures to the same endpoint. Concrete failure: a host passes its spec through openApiToHostTools into createVendoHandler({ hostTools }); a state-changing GET (e.g. GET /api/integrations/connect, GET /export-and-email — common in real APIs) executes in the user's browser with their cookies, silently auto-allowed, violating the bar's 'fail closed' requirement and diverging from what the same app gets via `vendo init`. The code comments acknowledge the trust assumption, but a documented fail-open is still fail-open, and the inconsistency between the two producers of HostToolAnnotations is the release problem.

### [cross-package-seams] Two incompatible saved-vendo record shapes are persisted to the same saved_vendos.record column by two public stores
- file: `packages/vendo-store/src/vendo-registry.ts:53` · kind: api-inconsistency · verified by: codex

Core seam SavedVendo (uiTree/query/originatingPrompt, store-assigned id, ISO-string timestamps — packages/vendo-core/src/seams/store.ts) vs shell Vendo (node/prompt, caller-assigned id, numeric ms timestamps — packages/vendo-shell/src/seams/store.ts). @vendoai/store publicly exports createDrizzleSavedVendoStore writing core-shaped records into vendo.saved_vendos.record, while the actual production path (@vendoai/server's vendos.ts createDrizzleVendoRegistry, used by @vendoai/next) writes shell-shaped records into the SAME table/column. Reads are unchecked casts (`rows[0].record as SavedVendo`). Concrete failure: a host that wires the documented core Store seam (createDrizzleSavedVendoStore) against the same database as its @vendoai/next handler gets rows whose uiTree/query are undefined and whose timestamps are numbers where the type promises ISO strings — saved-vendo reopen (critical flow 5) silently renders nothing or crashes downstream consumers of `query.toolName`. One of the two contracts should own the table, or they need distinct storage.

### [cross-package-seams] loadVendoDir silently strips the sync-prepared remix baseline (`prepared`) from remix-sources.json
- file: `packages/vendo-server/src/vendo-dir.ts:37` · kind: silent-failure · verified by: codex

The CLI's `vendo sync` writes an optional `prepared` field per captured record (packages/vendo-cli/src/sync/capture.ts:255) — the mechanically pre-transformed sandbox baseline that the remix fast-edits epic ships to make the first pin edit fast. Core's RemixSourceRecord declares it (packages/vendo-core/src/protocol.ts) and the server's source resolver consumes it (packages/vendo-server/src/remix-enrich.ts:93,100). But vendo-dir.ts's local remixSourceRecordSchema omits `prepared`, and zod objects strip unknown keys by default, so every record loaded from .vendo/remix-sources.json loses it before reaching createSourceResolver (fetch-handler.ts:355 passes `captured: loaded.remixSources`). Concrete failure: on every production boot, record.prepared is always undefined — the first remix silently falls back to the slow model-does-the-glue path, regressing the shipped 32s-to-4.4s first-remix speedup with zero errors anywhere (textbook silent failure on critical flow 6). One-line fix: add `prepared: z.string().optional()` to the schema.

### [cross-package-seams] MCP (dynamic-tool) approvals bypass the entire consent/audit/grant channel
- file: `packages/vendo-shell/src/use-vendo-thread.ts:160` · kind: api-inconsistency · verified by: codex

Two-sided seam break. Client side: the dynamic-tool approval branch builds its approval item WITHOUT toolCallId (line 160), even though part.toolCallId exists (the non-approval dynamic branch passes it at line 167), and never consults tierByToolCallId. VendoThread.approve()/decline() guard on `item?.toolCallId` before posting consent, so for every MCP tool approval the consent POST is silently skipped. Server side: even if it were sent, handleConsent's findApprovalPart matches only parts whose type startsWith("tool-") (packages/vendo-runtime/src/consent.ts:167), so a dynamic-tool part 404s. Concrete failures on critical flow 8: (a) approving/declining an MCP tool writes NO consent audit event, contradicting the core seam's contract that the audit trail records every decision (seams/store.ts AuditLog doc); (b) the 'allow once' session grant is never minted, so a byte-identical repeat MCP call re-asks every time; (c) tier/unverified escalation badges never render on MCP approval cards. The runtime memory notes '3 tool-*-only paths fixed' for MCP dynamic parts — these two were missed.

### [publish-hygiene] workspace:* production deps in 9 publishable manifests, all at version 0.0.0, with no publish tooling in the repo
- file: `packages/vendo-next/package.json:28` · kind: publish-hygiene · verified by: codex

cli, components, next, react, runtime, server, shell, stage, and store all have workspace:* production deps. These are only rewritten if published with `pnpm publish` (or changesets); the repo has no release script, changesets config, or .npmrc, so a plain `npm publish` ships workspace:* verbatim and every consumer install fails with EUNSUPPORTEDPROTOCOL. Even via pnpm, workspace:* rewrites to the current version "0.0.0", so all inter-package ranges would be exact 0.0.0 — any later patch release breaks resolution unless every package is version-bumped in lockstep. The release pipeline (ENG-198) must use pnpm/changesets and bump versions before first publish.

### [publish-hygiene] No publishConfig.access for any @vendoai/* scoped package — first publish of all 12 fails with E402
- file: `packages/vendo-cli/package.json` · kind: publish-hygiene · verified by: codex

No package has publishConfig: { access: "public" } and there is no .npmrc setting access. npm/pnpm default scoped packages to restricted, so the very first `npm publish` of every @vendoai/* package errors 402 Payment Required (or publishes private on a paid org, hiding the release). Add publishConfig.access=public to all 12 manifests so publish cannot silently depend on a CLI flag.

### [publish-hygiene] Generated .vendo/components/vite.config.mts imports @vendoai/stage/build plus vite/@vitejs/plugin-react — none installed or declared in the host app
- file: `packages/vendo-cli/src/components/codegen.ts:150` · kind: api-inconsistency · verified by: codex

When `vendo init` extracts host components it writes .vendo/components/vite.config.mts importing vendoHostPreset from "@vendoai/stage/build", whose dist statically imports vite and @vitejs/plugin-react (declared only as optional peers of @vendoai/stage). init adds only @vendoai/next to the host's dependencies and quickstart adds @vendoai/cli; @vendoai/stage is merely a transitive dep (via @vendoai/react), so under pnpm's strict node_modules the import doesn't resolve at all, and in any fresh Next.js app (no vite installed) building the generated config fails with Cannot find module 'vite'. Concrete failure: a pnpm-based host that follows the quickstart and tries to build its host-component sandbox bundle gets an unresolvable import from Vendo-generated code.

### [publish-hygiene] Six packages have no files allowlist — npm pack ships tests, source, .turbo build logs with local machine paths, and multi-MB stray bundles
- file: `packages/vendo-stage/package.json` · kind: publish-hygiene · verified by: codex

cli, components, core, react, runtime, and stage have no "files" field and there is no .npmignore. Verified with npm pack --dry-run: @vendoai/cli ships all of src/ (including tests), scripts/, and .turbo/turbo-*.log files containing /Users/yousefh absolute paths from local builds; @vendoai/components additionally ships the 3.9MB dist-sandbox/ duplicate bundle, bundle/, and vite configs; @vendoai/stage would ship its 604KB tests/browser fixtures (playwright specs, prebuilt runtime bundles) and test-results/. No secrets found in these dirs (grepped), but internal build logs and doubled install size ship on day one. Add files:["dist"] (plus dist/assets for the CLI, schemas for core if needed) to all six.

### [vendo-cli] init wires `prebuild: vendo sync` but never adds @vendoai/cli to the app's dependencies
- file: `packages/vendo-cli/src/next-wiring.ts:323` · kind: bug · verified by: codex

addPrebuildSync writes `vendo sync` into the host package.json scripts, but addDependency only adds `@vendoai/next` (which does not depend on @vendoai/cli — verified in packages/vendo-next/package.json). A user who runs `npx @vendoai/cli init .` (or pnpm dlx) without also installing the CLI locally gets a broken production build: `npm run build` → prebuild → `sh: vendo: command not found` → next build never runs. Under pnpm even a hoisted transitive copy would not expose the bin. The quickstart happens to say `npm install -D @vendoai/cli`, which masks it for doc-followers, but the codemod itself creates a build-breaking script it does not satisfy — it should add @vendoai/cli to devDependencies alongside @vendoai/next.

### [vendo-cli] instrumentation.ts scheduler boot is silently dead on Next.js 13/14 hosts (no instrumentationHook flag, no version check)
- file: `packages/vendo-cli/src/next-wiring.ts:157` · kind: silent-failure · verified by: codex

The codemod writes instrumentation.ts calling startVendoScheduler(), but on Next.js 13.4–14.x the instrumentation file is ignored unless `experimental.instrumentationHook: true` is set in next.config — the codemod neither checks the host's next version, nor edits next.config, nor prints a warning. Verified there is no fallback: vendo-server's fetch-handler only starts the in-process scheduler via startVendoScheduler() from instrumentation (otherwise schedules fire only via POST /tick). Failure scenario: a Next 14 app runs `vendo init`, the user creates and approves a scheduled automation (release-bar flow 4), and it never fires — no error anywhere, the wiring report claims instrumentation was written successfully. Needs a version gate (warn + manual step, or set the experimental flag) or a documented minimum Next version enforced at init time.

### [vendo-cli] vendo sync local-module vendoring collides on bare specifier across anchors — wrong module served to the sandbox
- file: `packages/vendo-cli/src/sync/env.ts:120` · kind: bug · verified by: codex

`localToVendor` is a single Map keyed by the import specifier text (e.g. "./utils") shared across ALL captured anchors, and the flat import map emits one `./utils` → vendor entry. Failure scenario: component A (src/cards/Card.tsx) imports `./utils` (src/cards/utils.ts) and component B (src/tables/Table.tsx) imports `./utils` (src/tables/utils.ts); the second resolution overwrites the first, one bundle is written, and both anchors' sandboxes resolve `./utils` to the same file. Anchor A's remix then imports B's helpers — wrong data/formatting or a runtime crash in the sandbox — while manifest.json still marks the import `real` for both. Relative sibling imports named utils/helpers/constants are ubiquitous, so two wrapped components is all it takes. Breaks release-bar flow 6 (remix edits apply correctly).

### [vendo-cli] sanitizeCss corrupts kept data: URLs whose base64 payload contains `//`
- file: `packages/vendo-cli/src/sync/host-css.ts:71` · kind: bug · verified by: codex

The externalRef catch-all regex `/(?:https?:|\/\/)[^\s'")]+/` runs after the url() pass and matches `//` sequences INSIDE data: URIs that the sanitizer explicitly promises to keep. Reproduced in this session: `.logo { background: url(data:image/png;base64,iVBOR//w0KGgo...) }` becomes `url(data:image/png;base64,iVBOR)` — the payload is truncated at the first `//`, which occurs in virtually any real base64-encoded image or woff2 font. The declaration silently breaks in the sandbox (browser ignores the malformed data URI), and the report line "dropped N fetchable url(s)" mislabels it as a security drop. Hosts that inline logos/fonts as data URIs in globals.css (common with font pipelines) lose brand assets in every generated view. The catch-all should skip matches inside data: URLs (or only scan outside url() tokens already validated).

### [vendo-components] installVendoHost's collision throw (and any bundle eval error) yields a permanently blank sandbox with no user-facing error
- file: `packages/vendo-stage/src/runtime.ts:412` · kind: silent-failure · verified by: codex

installVendoHost (packages/vendo-components/src/sandbox-install.ts:57) deliberately throws at module-eval time when a host component name collides with a catalog name — the documented fail-fast. But the stage runtime's init handler replies { ok: true } and posts init-ack BEFORE rendering, then does `render(m.params).catch(function(err) { console.error(...) })`. A throw during bundle import rejects render(), the error goes only to the iframe console, and the stage stays a blank iframe forever while the host believes init succeeded. Concrete scenario: a host dev registers hostComponent("Card", ...) (nothing upstream stops them — see separate finding), ships, and every user's first render is an empty surface with zero diagnostics. Violates the bar's "errors surface to the user in friendly form ... and fail closed" on critical flow 2 (first render).

### [vendo-components] Actions swallows real dispatch failures whose message happens to contain 'declined' or 'cancelled'
- file: `packages/vendo-components/src/components/Actions/impl.tsx:31` · kind: silent-failure · verified by: codex

The catch block suppresses the error banner whenever `/declined|cancelled/i.test(msg)` matches, intended to keep user declines quiet. But the rejection message is arbitrary text from the host tool / bridge (`ap.error.message` in runtime.ts:475, or a raw server error via postAction). A genuine failure like "card declined by issuer" or "request cancelled by upstream" returns the button silently to idle — the user just clicked (and possibly explicitly approved) an action, and gets no indication it failed. Conversely a host calling cancelAction with a custom reason like "user dismissed" shows a spurious failure banner. The stage already attaches a structured `code` ("abort") on decline rejections (runtime.ts:475), so the discrimination should use the code, not message text.

### [vendo-components] Actions payload schema rejects nested JSON, blanking the entire button row for valid tool payloads
- file: `packages/vendo-components/src/components/Actions/descriptor.ts:13` · kind: api-inconsistency · verified by: codex

The descriptor constrains payload to `z.record(z.string(), jsonPrimitive)` — a flat object of scalars — while the dispatch contract everywhere else (HostImplRuntime.dispatch, runtime.ts tools/call, host OpenAPI tools) accepts `payload?: unknown`. If the agent wires a button to a real host tool whose input needs an array or nested object (e.g. { transactionIds: ["t1","t2"] }), safeParse fails and createPrewiredImpl replaces the WHOLE Actions component with the generic "Invalid component props" fallback — the view loses all its action buttons for one structurally-valid payload. Host OpenAPI tools with array/object params are a core critical flow (flow 3), so this fires on realistic tools, not exotic ones.

### [vendo-components] Publish hygiene: no files field, no license, version 0.0.0 — inconsistent with sibling packages
- file: `packages/vendo-components/package.json:3` · kind: publish-hygiene · verified by: codex

vendo-components has no "files" field (its own .gitignore only excludes dist-sandbox, so npm pack would ship src/, all *.test.* files, vitest configs, and .turbo/*.log build logs containing local machine paths), no "license" field (and there is NO LICENSE file anywhere in the repo — `ls LICENSE*` at root finds nothing, a hard blocker for an OSS release repo-wide), and version 0.0.0. Six sibling packages (vendo-next, vendo-server, vendo-shell, vendo-store, vendo-telemetry, vendo-sandbox-shims) declare files:["dist"] while vendo-components, vendo-core, vendo-react, vendo-runtime, vendo-stage and vendo-cli do not — the 12-package publish surface is incoherent. Publish is stubbed until ENG-198, but the release bar explicitly covers published package output.

### [vendo-core] HOST_RELATIVE_PATH guard bypassable with backslash → credentialed cross-origin fetch
- file: `packages/vendo-core/src/host-api.ts:62` · kind: security · verified by: claude-panel

The guard regex `/^\/(?!\/)\S*$/` (also duplicated in manifest/tool.ts httpBindingSchema line 49) is meant to guarantee a host-tool path 'can never point a client executor at a foreign origin.' It blocks a literal `//authority` but not a backslash. A path like `/\evil.example/steal` passes the regex, and executeHostToolCall builds the URL by string-concat (`${baseUrl}${path}`) and calls fetch with `credentials:"include"`. The browser's WHATWG URL parser normalizes backslashes to forward slashes, so `/\evil.example/steal` becomes protocol-relative `//evil.example/steal` and resolves to `https://evil.example/steal`, sending the user's session cookies to an attacker origin. The module comment explicitly re-checks the guard at execution 'because definitions can arrive from outside the adapter,' so untrusted/compromised OpenAPI specs or published manifests are in the threat model. Verified: `new URL('/\\evil.example/steal','https://host.app').href` === 'https://evil.example/steal'. Fix: reject backslashes (and other URL-significant chars) in the path guard.

### [vendo-core] openApiToHostTools trusts operationId verbatim as the model tool name → provider 400 kills the whole turn
- file: `packages/vendo-core/src/host-api.ts:143` · kind: api-inconsistency · verified by: claude-panel

`const name = op.operationId ?? deriveName(...)`. When operationId is present it is used verbatim as the tool key in hostToolset (runtime/host-toolset.ts registers `tools[def.name]`). Anthropic/OpenAI/Google require tool names to match `^[a-zA-Z0-9_-]{1,64}$`. An OpenAPI spec with `operationId: "Get Account Balance"` (contains spaces) or any unicode/>64-char id produces a tool name the model API rejects with a 400, failing the entire chat turn with a raw provider error rather than a friendly message. Only the derived-name fallback (deriveName) sanitizes; the MCP client path explicitly validates+skips bad names (per mcp-client-design §69), but this host-tool path does not. Even deriveName can exceed 64 chars for long paths (verified: a 6-segment path yields a 170-char name). This breaks critical flow #3 (host OpenAPI tools) for any spec whose operationIds aren't already provider-safe. Fix: validate/normalize `name` against the provider charset+length and warn/skip or slugify.

### [vendo-core] Published dist uses extensionless relative ESM imports → import fails under Node ESM resolution
- file: `packages/vendo-core/package.json:18` · kind: publish-hygiene · verified by: claude-panel

tsconfig extends tsconfig.base.json which sets `module: ESNext` + `moduleResolution: Bundler`, so tsc emits `export * from "./schema"` (no `.js`) while package.json declares `"type": "module"`. Node's ESM loader requires explicit file extensions, so importing the published package in plain Node throws. Verified: `node -e "import('.../dist/index.js')"` fails with `Cannot find module '.../dist/schema'`. This works today only because bundlers (Next webpack/turbopack) rewrite extensionless imports, but @vendoai/core is a publishable OSS package; any consumer importing it under Node16/NodeNext resolution (or a non-bundled Node server) crashes at import. Matches the known 'dists need NodeNext before ENG-198' gap. Fix: emit extensioned imports (moduleResolution NodeNext / add `.js`).

### [vendo-next] Reads-only replay guard fails open on unvalidated tool annotations
- file: `packages/vendo-next/src/client/run-query.ts:24` · kind: security · verified by: codex

createRunQuery is the SOLE guard for saved-view reopen replay (host tools are client-executed via executeHostToolCall, never through the server /action policy). It filters replayable tools with `!t.annotations.mutating`, so `mutating: undefined` is treated as read-only. The client never schema-validates the `tools` prop: parseManifestTools in vendo-root.tsx:77 just casts `tools as ManifestTool[]`, unlike the server's loadVendoDir which validates via toolsManifestSchema. A hand-edited/malformed .vendo/tools.json entry with `annotations: {}` (or a POST tool whose mutating flag got dropped) becomes silently replayable, executing a mutating host API on reopen with no approval. If annotations is entirely absent it instead throws a TypeError that crashes VendoRoot render.

### [vendo-next] Boot/assembly errors returned verbatim to unauthenticated callers
- file: `packages/vendo-server/src/fetch-handler.ts:651` · kind: security · verified by: codex

bootError() returns `{ error: err.message }` for any failure of assembleVendoState(), and GET /capabilities runs with NO principal guard (the capabilities case returns before resolvePrincipal). In production a bad DATABASE_URL, PGlite dataDir path, missing provider peer, or model-resolution failure throws from resolveStorage/resolveModel with internal detail (DB host/port/user/db name, filesystem paths, provider internals) embedded in the message, and that string is handed to any anonymous client that hits /api/vendo/capabilities. Violates the release bar's 'no internal URLs / friendly errors' rule.

### [vendo-next] Host tool execute() throw produces an HTML 500 and a raw SyntaxError in the sandbox
- file: `packages/vendo-server/src/action.ts:152` · kind: silent-failure · verified by: codex

handleAction awaits `tool.execute(payload, ...)` with no try/catch, and vendoFetchHandler wraps only state() (not GET/POST), so a throwing host server tool propagates out as an unhandled rejection -> Next returns its default HTML 500 page. On the client, postAction in sandbox-stage.tsx:116 does `await res.json()` BEFORE checking res.ok, so parsing the HTML body throws a raw SyntaxError. Net: a gated sandbox action whose backing tool fails surfaces an opaque SyntaxError/raw failure to the generated UI instead of a stable friendly `{ error }`. Breaks the host-tools-with-approvals critical flow error handling.

### [vendo-next] Integrations status reports 'active' without connecting the toolkit in the store
- file: `packages/vendo-server/src/integrations.ts:70` · kind: silent-failure · verified by: codex

GET /integrations?status returns the raw Composio `status` (e.g. 'active') but only calls store.setConnectedAccount/marks the toolkit connected when BOTH status==='active' AND hasActiveConnection(userId,id) is true. When Composio reports the account active but hasActiveConnection is false, the response is still {status:'active'}. connect-flow.ts:71 sees 'active', closes the popup, and VendoConnectNode marks the integration connected and tells the agent to continue — but the store gate never flipped, so the agent never actually gains the toolkit. User sees success; the next agent turn still lacks the tool.

### [vendo-next] Saved-vendo mutations have no CSRF/origin protection under cookie-based principals
- file: `packages/vendo-next/src/client/server-store.ts:43` · kind: security · verified by: codex

The docs steer hosts to gate production with a cookie-based `principal` resolver, but no route checks Origin/Sec-Fetch or a CSRF token. remove() POSTs to /vendos/<id>/delete with no body and no headers, making it a CORS 'simple request' (no preflight). A malicious page a logged-in user visits can auto-submit that POST and delete their saved views; the same applies to other state-changing POSTs (save, integrations disconnect). Real for any host that adopts the recommended cookie auth.

### [vendo-react] VendoStage node={null} leaves the previous sandbox tree mounted and actionable
- file: `packages/vendo-react/src/stage-adapter.tsx:113` · kind: bug · verified by: claude-panel

The node effect does `if (!c || !node) return;` — transitioning from a rendered node to `null` performs no teardown, so the previously initialized iframe tree stays visible and its action capabilities remain live (buttons still dispatch through onAction). The package README explicitly promises "Pass null to render nothing." Concrete failure: a host clears the current view (e.g. closes a saved vendo or resets the surface) by passing node={null}; the stale generated UI — potentially bound to now-invalid data — remains on screen and clickable. API behavior contradicts documented contract on the first-render/saved-vendos critical flows.

### [vendo-react] Published tarball ships .turbo logs with local absolute paths, tests, and src; no license field or LICENSE file
- file: `packages/vendo-react/package.json:1` · kind: publish-hygiene · verified by: claude-panel

Verified with `npm pack --dry-run`: the @vendoai/react tarball includes .turbo/turbo-build.log, turbo-test.log, turbo-typecheck.log (containing absolute local paths like /Users/yousefh/orca/workspaces/flowlet/...), all src/*.test.* files, tsconfig.json and vitest.config.ts — because package.json has no `files` allowlist, unlike sibling packages (vendo-next, vendo-server, vendo-shell, vendo-store, vendo-telemetry all declare files:["dist"]). vendo-core/stage/components/runtime/cli share the gap. Additionally there is no `license` field in any package.json and no LICENSE file anywhere in the repo — legally the packages default to all-rights-reserved, which blocks an OSS release. Directly violates the release bar's "No secrets, keys, or internal URLs in published package output."

### [vendo-react] README documents an API that does not exist (InMemoryChatTransport, send()); example code cannot compile
- file: `packages/vendo-react/README.md:39` · kind: api-inconsistency · verified by: claude-panel

The README — the package's npm front page — shows `import { ..., InMemoryChatTransport } from "@vendoai/react"` and `new InMemoryChatTransport()`, but no such export exists (the actual export is `createLocalTransport(agent)`). The example also omits the required `components` prop on VendoProvider (a TS error and the provider throws if neither agent nor transport... components is required in VendoProviderProps), and claims `useVendoChat` returns `{ messages, send, status }` when the real helper is `sendMessage`. `hostTools` and `VendoStage`'s `env`/`componentTheme` props are undocumented. A first-time OSS user copying the quickstart gets immediate compile errors. Violates the release bar: "Public API surface ... is coherent across packages and matches the docs."

### [vendo-react] Host-tool execution failures put raw error text into the DOM via the shell
- file: `packages/vendo-react/src/provider.tsx:158` · kind: ui-consistency · verified by: claude-panel

HostToolRunner's catch does `errorText: err instanceof Error ? err.message : String(err)`, and @vendoai/shell renders errorText verbatim (ActivityStep.tsx:57 `<span className="fl-act-sub fl-act-err">{step.errorText}</span>`, ToolCall.tsx:29 same). Concrete failure: a host API fetch rejects (CORS failure, network error, or `executeHostToolCall`'s own throw like `host tool "x": missing required input "body"`) → the raw message, including internal tool/parameter names, is rendered in the host page DOM. The release bar requires errors to "surface to the user in friendly form, never raw in the DOM." (Codex also flagged non-2xx response bodies flowing raw into model context via host-api.ts, but that is documented intent — "HTTP errors are data" — so only the DOM path is reported.)

### [vendo-react] Missing onAction fails open: sandbox actions silently 'succeed' with null
- file: `packages/vendo-react/src/stage-adapter.tsx:94` · kind: silent-failure · verified by: claude-panel

When the optional `onAction` prop is omitted, connectStage is wired with a default handler `async () => ({ result: null })`. Every action dispatched by generated UI resolves successfully with a null result instead of failing. Concrete failure: a host renders VendoStage without onAction; a generated "Send reminder" or "Delete invoice" button runs its success path (in-sandbox code sees a resolved dispatch) while nothing actually happened — no error state, no console signal. The release bar requires critical-path failures to fail closed. The default should reject (e.g. `{ error: { code: "no_handler" } }`) so the sandbox surfaces the failure.

### [vendo-react] Entire conversation wiped when hostTools.definitions array identity changes
- file: `packages/vendo-react/src/provider.tsx:84` · kind: bug · verified by: codex

The shared Chat is memoized on `hostToolNames`, which is memoized on the `definitions` ARRAY identity (provider.tsx:73-95). The guard comment/test only covers an unstable hostTools config object with a stable inner array. Any direct @vendoai/react consumer that computes definitions during render — e.g. `hostTools={{ definitions: openApiToHostTools(spec) }}` or an inline array literal — produces a new Set every render, which recreates `new Chat(...)` and silently drops all messages and any pending approval mid-turn. Concrete failure: host app re-renders on a keystroke → thread resets to empty; an approval card the user is about to click vanishes. The blessed vendo-next path memoizes, but nothing warns direct SDK users, and the same hazard applies to inline `transport`/`agent` props via the `local` memo. Fix: key on a stable digest (e.g. sorted names join) instead of array identity.

### [vendo-runtime] render_view ships components with unresolvable sandbox imports and tells the model "rendered" — user sees a dead view, model never gets a correctable error
- file: `packages/vendo-runtime/src/render-view-tool.ts:97` · kind: bug · verified by: claude-panel

edit_view gates every patched source through STAGE_IMPORTS/sandboxImports and returns a correctable `edit_view error (imports): ...` before streaming (edit-view-tool.ts step 3, added after a browser-verification finding). render_view has no equivalent: materializeView -> core validateGeneratedPayload checks only shape/size (confirmed: no import policy in vendo-core/src/genui/format.ts), so a generated component importing anything but react (e.g. `import { Button } from "@/components/ui"` — exactly what the model tends to emit on the legacy remix path, where sourceSection instructs it to produce an 'edited variant' of captured host source that still contains host imports) streams to the stage, fails at module load ("component failed to load"), while execute() has already returned "rendered" — the model reports success over a broken view and never self-repairs. Codex independently traced the stage loader and confirmed the browser outcome. Breaks critical flows 2 (first render) and 6 (remix) with a user-visible dead state. Fix shape: run the same importSpecifiers gate in materializeView/render_view and return a correctable tool error.

### [vendo-runtime] Agent-step tool calls mint non-run-scoped idempotency keys (`agent/<tool>/<n>`) that collide across every run and automation
- file: `packages/vendo-runtime/src/automations/agent-step.ts:56` · kind: api-inconsistency · verified by: claude-panel

Direct tool steps use `${runId}/${step.id}/${attempt}` and parked resolutions use `${runId}/${stepId}/parked-${id}` — globally unique per logical call, and runner.ts explicitly documents that "an executor that dedupes by key cannot double-fire across retries", i.e. key-based dedup is the seam contract. createAgentStepRunner instead mints `agent/${name}/${++callCounter}` with a per-request counter: the first send_email call of EVERY agent-mode run of EVERY automation gets the key `agent/send_email/1`. Concrete scenario: a host implements the Executor seam with idempotency-key dedup (the contract's stated purpose); a daily agent-mode automation sends a summary email — day 1 works, day 2's send_email arrives with the identical key and is silently swallowed as a duplicate. Silent data loss, no error anywhere. Fix shape: thread runId/stepId into AgentStepRequest and key as `${runId}/${stepId}/agent/${name}/${n}`.

### [vendo-runtime] Expression evaluation timeout cannot preempt synchronous JSONata work — a pathological expression blocks the host event loop despite the 250ms cap
- file: `packages/vendo-runtime/src/automations/expressions.ts:191` · kind: bug · verified by: claude-panel

The safe profile rejects regex precisely because "synchronous evaluation defeats the time cap", but the same holds for other allowed constructs: the Promise.race timer only fires after the synchronous evaluation returns. Concrete scenario: an automation guard `$sum([1..10000000]) > 0` (range + $sum are both allowed; jsonata permits ranges up to 1e7 entries) passes validateExpression, and every firing then synchronously builds a 10M-element array and sums it — seconds of blocked event loop per evaluation on the host's server, repeatable per firing/tick, with the output-size cap only applying afterward. The 250ms ExpressionError never fires because nothing yields. Fix shape: cap range/array sizes at validation time (AST scan for large range literals) or evaluate in a worker.

### [vendo-runtime] Run failures stream raw internal error messages to the client (provider 401s, Composio/network errors) instead of a friendly message
- file: `packages/vendo-runtime/src/engine.ts:760` · kind: silent-failure · verified by: codex

createUIMessageStream's onError returns `error.message` verbatim for any Error, and that string becomes the stream's error part shown to the end user. Concrete scenario: a host with a mistyped ANTHROPIC_API_KEY — every chat turn surfaces the raw provider error (`401 ... invalid x-api-key ...`, request IDs, endpoint URLs) in the product UI; likewise a Composio ingestion failure (composioCache rethrows) or an MCP SDK error puts infrastructure detail in front of the host's end user. The release bar explicitly requires "errors surface to the user in friendly form, never raw in the DOM". The generic fallback ("The agent run failed.") already exists for non-Errors — the Error branch should be the one that gets the friendly copy (with the raw message going to the console.error that is already there on line 759).

### [vendo-sandbox-shims] next/navigation shim missing useParams (and redirect/notFound/useSelectedLayoutSegment*) — remixed components using them fail at module link time
- file: `packages/vendo-sandbox-shims/src/next-navigation.ts:8` · kind: api-inconsistency · verified by: claude-panel

The shim exports only useRouter, usePathname, useSearchParams, but the import map points the bare specifier "next/navigation" at it, and ESM named imports are validated at link time. Any captured/remixed component that does `import { useParams } from "next/navigation"` fails to instantiate with "does not provide an export named 'useParams'" and renders the generic "component failed to load" notice (runtime.ts:277). useParams is ubiquitous in App Router detail views — this repo's own demo does it: apps/demo-bank/src/app/accounts/[id]/page.tsx:3. The env manifest tells the model next/navigation is "shimmed" (identical-API note in classify.ts:14), so the model has no reason to avoid the import; the sync pipeline has no rewrite for it either (grep for useParams in vendo-cli/src finds nothing). Breaks critical flows 2/6 for any anchor under a dynamic route segment. Fix: export a useParams that reads params injected alongside __vendoAnchorData (or at minimum a stub returning {}), plus no-op redirect/notFound.

### [vendo-sandbox-shims] swr shim missing useSWRConfig/mutate/SWRConfig/preload named exports — components importing them fail to load
- file: `packages/vendo-sandbox-shims/src/swr.ts:40` · kind: api-inconsistency · verified by: claude-panel

Real swr 2.4.2 (installed in this repo) exports { mutate, preload, useSWRConfig, SWRConfig, unstable_serialize } plus default; the shim exports only default and useSWR. A remixed component with `import useSWR, { useSWRConfig } from "swr"` — exactly what apps/demo-accounting/src/components/clients/message-thread.tsx:5 does today — fails ESM instantiation in the sandbox ("does not provide an export named 'useSWRConfig'") and the whole component dies with "component failed to load". The manifest advertises swr as shimmed with an identical API (classify.ts:15), so the model will keep the import when remixing. Fix: export no-op mutate/preload, a passthrough SWRConfig, and a useSWRConfig returning { mutate: async () => undefined }.

### [vendo-sandbox-shims] dispatch() drops the bridge promise — blocked navigation is a dead click with an unhandled rejection and zero user feedback
- file: `packages/vendo-sandbox-shims/src/dispatch.ts:16` · kind: silent-failure · verified by: claude-panel

The stage runtime's window.__vendoDispatch (vendo-stage/src/runtime.ts:360) returns a Promise that REJECTS on bridge error replies, and SandboxStage replies with { error: { code: "unsafe_navigation" } } for any href that fails isSafeAppPath (vendo-next/src/client/sandbox-stage.tsx:183-192). The shim's dispatch() calls fn({action,payload}) and discards the return value with no .catch. Concrete failure: a remixed component containing `<Link href="https://docs.example.com">` (external links are common in real host components), or an object href with no pathname (navigate("")), preventDefaults the click, dispatches, the host rejects — result is an unhandledrejection in the sandbox iframe and a click that visibly does nothing. Violates the bar's "errors surface to the user in friendly form" on critical flow 2. Fix: Promise.resolve(fn(...)).catch(...) with at least a console.warn, ideally a visible affordance.

### [vendo-sandbox-shims] useSWR shim reports isLoading:true forever for null/conditional and function keys — permanent skeleton states
- file: `packages/vendo-sandbox-shims/src/swr.ts:34` · kind: bug · verified by: claude-panel

Real swr semantics: a falsy key (`useSWR(user ? `/api/user/${user.id}` : null)`) means "don't fetch" and isLoading is false; a function key is invoked to derive the key. The shim returns isLoading: data === undefined and never invokes function keys (resolveKey returns undefined for them), so both cases yield { data: undefined, isLoading: true } forever. Any remixed component using the very common conditional-fetch pattern and rendering `if (isLoading) return <Skeleton/>` shows an infinite skeleton with no error and no way out — a silent failure on flows 2/6 that violates the "loading states look intentional" bar. Same for any anchor-data key the host didn't inject: permanently loading rather than settling to empty. Fix: treat null/undefined/false keys as settled (isLoading:false), invoke function keys inside try/catch (safe — the fetcher still never runs), and consider settling unbacked keys after injection.

### [vendo-server] parked-actions routes skip the single-tenant fail-closed guard that /deliveries and /resume enforce — any authenticated user can approve another user's parked automation actions
- file: `packages/vendo-server/src/fetch-handler.ts:700` · kind: security · verified by: codex

GET /deliveries (fetch-handler.ts:690) and POST /resume (fetch-handler.ts:826) explicitly 403 any principal whose userId != worldScope.subject, citing a prior Codex review ('fail closed rather than leak run summaries across users'). GET /parked-actions (fetch-handler.ts:700-705) and POST /parked-actions/resolve (fetch-handler.ts:879-884) do not: they pass any resolved principal through, and parked-actions.ts:32/44 then reads and RESOLVES rows under the world's fixed scope regardless of caller. Concrete failure: a host wires a multi-user `principal` resolver; user B POSTs /parked-actions/resolve {actionId, decision:"yes"} and approves a parked automation action that belongs to the world's default subject — the action then executes unattended. Listing also leaks other users' pending action details. Same asymmetry (read-only) exists in listGrantsRoute's automation section (trust.ts:66), which serves the shared world's automation grants to every principal.

### [vendo-server] Boot/assembly errors are echoed verbatim to unauthenticated callers (file paths, DB connection details)
- file: `packages/vendo-server/src/fetch-handler.ts:651` · kind: security · verified by: codex

bootError() returns `err.message` raw in a 500 JSON body, and state assembly runs BEFORE resolvePrincipal on every request — no auth needed to trigger or read it. Assembly failures include: PGlite dataDir absolute paths ('data directory ".../.vendo/data" is not writable — ... Cause: EACCES ...'), Postgres/migration failures whose Cause carries connection errors like 'connect ECONNREFUSED <internal-host>:5432' (store db.ts wraps but preserves err.message), and .vendo/*.json schema errors with absolute file paths (vendo-dir.ts:68). Concrete failure: production deploy with a briefly-unreachable DATABASE_URL → every request, from anyone on the internet, returns the internal DB host/port in the response body, and VendoRoot can surface it in the DOM. Violates the quality bar's 'errors surface in friendly form, never raw' and 'no internal URLs in output'.

### [vendo-server] No route-level error boundary: any thrown route error escapes as a framework-level 500 (HTML/plain text), breaking the JSON contract on critical flows
- file: `packages/vendo-server/src/fetch-handler.ts:910` · kind: bug · verified by: codex

vendoFetchHandler only try/catches state assembly; exceptions inside GET()/POST() reject the returned promise. Concrete instances all reachable today: (a) POST /action where a host server tool's execute() throws (action.ts:152 — the normal failure mode for real business tools) → Next.js renders its own 500 page / toNodeHandler returns text 'Internal Server Error', so the sandbox dispatch gets non-JSON and the approval/stage flow (critical flow 3) shows a broken state; (b) GET /audit?sinceMs=abc → `new Date(NaN).toISOString()` throws RangeError (trust.ts:124) — a user-controllable query param 500s the Trust screen; (c) GET /threads/%E0 or /vendos/%E0 → decodeURIComponent throws URIError (fetch-handler.ts:742, vendos.ts:209); (d) any store blip in threads.list/runner.resume. Every handler should fail closed with the JSON error shape the clients parse.

### [vendo-server] /action executes server tools with a raw, schema-unvalidated payload
- file: `packages/vendo-server/src/action.ts:152` · kind: security · verified by: codex

handleAction calls `tool.execute(payload, ...)` directly with whatever JSON body the sandbox (or any authorized caller) sent — it never validates against the tool's declared inputSchema, unlike the agent path where the ai SDK parses input through the zod schema before execute. Host tool authors write execute() assuming validated input. Concrete failure: a server tool declared `z.object({ amount: z.number().positive() })` receives `{ amount: -1 }` or `{ amount: "1e9" }` from a generated-UI dispatch; the policy layer may still evaluate to allow (reads) or the user approves a card rendered from the same unvalidated payload, and execute() runs with input the tool's own contract forbids — wrong writes instead of a 400.

### [vendo-server] No license field in any publishable package.json and no LICENSE file in the repo
- file: `packages/vendo-server/package.json:1` · kind: publish-hygiene · verified by: codex

@vendoai/server (and every other packages/* package — `grep '"license"' packages/*/package.json` matches nothing, and no LICENSE file exists at the repo root) ships with no license metadata. npm will flag the published package as UNLICENSED; legally nobody can use, modify, or redistribute it, which defeats the entire first-OSS-release purpose and fails the publish-hygiene bar. Repo-wide, but it must be fixed before `npm publish` of this package.

### [vendo-shell] VendoPage cannot render generated UI — no renderNode prop or wiring
- file: `packages/vendo-shell/src/elements/VendoPage.tsx:58` · kind: bug · verified by: claude-panel

VendoPage (a public exported surface, the tabbed-page shell element) mounts VendoShellProvider without `renderNode` and exposes no prop to supply one, so every generated `data-ui` node falls into the provider's non-production fallback and renders the literal placeholder text "[generated UI — rendered in the F3 sandbox]". Failure scenario: a host renders <VendoPage agent components/>, the user asks for a view, the agent streams a generated node, and the user sees placeholder text instead of the sandboxed view — critical flow #2 (first render) is broken on this surface with no way to fix it from the public API.

### [vendo-shell] Raw tool errorText rendered verbatim in the DOM (ActivityStep and ToolCall)
- file: `packages/vendo-shell/src/components/ActivityStep.tsx:57` · kind: silent-failure · verified by: claude-panel

ActivityStep renders `{step.errorText}` directly (`fl-act-err`), and the exported ToolCall primitive does the same at ToolCall.tsx:29. errorText is the raw error: client-executed host tools set it to `err.message` (vendo-react provider.tsx:158, e.g. fetch/TypeError text or `host tool "x": missing required input`), and server/MCP tool failures stream whatever the tool threw — stack fragments, SQL errors, internal URLs. Failure scenario: a host OpenAPI tool 500s or throws; the user expands the activity panel and sees the raw error text on screen. Directly violates the release bar's "errors surface in friendly form, never raw in the DOM" — chat-level errors are funneled through friendlyError() but tool-step errors bypass it entirely.

### [vendo-shell] Cmd+Shift+K voice shortcut also toggles the overlay closed, killing the session
- file: `packages/vendo-shell/src/elements/VendoOverlay.tsx:34` · kind: bug · verified by: claude-panel

VendoOverlay's shortcut check `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === shortcutKey` does not exclude shiftKey, so Cmd+Shift+K (VendoThread's documented voice toggle, which requires shift) matches the overlay's Cmd+K listener too — `"K".toLowerCase() === "k"`. Failure scenario: host uses VendoOverlay with a voice driver; user opens the overlay, presses Cmd+Shift+K to start voice — both window listeners fire: voice starts AND the overlay toggles closed, unmounting VendoThread, whose useVoiceSession unmount effect immediately hard-stops the session. Voice can never be started by keyboard inside the overlay (critical flow #7), and the overlay unexpectedly closes. Fix: require `!e.shiftKey` in the overlay handler.

### [vendo-shell] Failed voice startup leaves the microphone live after showing the error
- file: `packages/vendo-shell/src/voice/realtime-driver.ts:546` · kind: bug · verified by: claude-panel

init() acquires getUserMedia, the RTCPeerConnection, audio element, and AudioContext before the SDP exchange; the catch block (line 546) only logs and emits an error status — it never calls the existing teardown() (line 443) that stops mic tracks. Failure scenario: the host's session mint returns an expired ephemeral token or the calls endpoint 500s after the user grants mic permission; the stage shows "Voice couldn't start", but the mic track stays live (browser tab shows the recording indicator) until the component unmounts. Same gap on the `connectionState === "failed"` path (line 487), which emits an error but leaves the mic and amplitude timer running. Privacy-sensitive on a critical flow.

### [vendo-shell] MCP (dynamic-tool) approvals drop toolCallId — consent/audit channel silently skipped
- file: `packages/vendo-shell/src/use-vendo-thread.ts:160` · kind: api-inconsistency · verified by: claude-panel

The dynamic-tool branch pushes approval items WITHOUT `toolCallId` (line 160), while the static `tool-*` branch includes it (line 181), even though dynamic parts carry `part.toolCallId` too. VendoThread's approve()/decline() guard `if (!item?.toolCallId) return;` before posting to the consent channel, so every MCP-tool approval/decline resumes the SDK but never reaches sendConsent. Failure scenario: user approves an external MCP server's write tool (critical flow #8); the action runs, but the server-side grant/audit trail records nothing and fade proposals ("stop asking") can never trigger for MCP tools — an invisible asymmetry versus host tools with identical UX.

### [vendo-shell] Hardcoded 'Maple' brand string in the voice transcript drawer
- file: `packages/vendo-shell/src/voice/VoiceStage.tsx:451` · kind: ui-consistency · verified by: claude-panel

The transcript drawer labels every agent line with the literal string "Maple" — the demo-bank host's assistant name — in a package whose own docs (context.tsx productName seam) promise "the shell package itself ships ZERO brand strings". Failure scenario: any OSS host opens the voice transcript drawer and sees their agent called "Maple". Should read from the `productName` context seam (with a neutral fallback like "Assistant"). Related: AutomationCard.tsx:161 hardcodes "Let Vendo handle the task" as an outcome line, also bypassing productName.

### [vendo-stage] ui/initialize reports success before rendering; render failures are swallowed (blank stage looks like success)
- file: `packages/vendo-stage/src/runtime.ts:410` · kind: silent-failure · verified by: claude-panel

The runtime's ui/initialize handler posts `{ ok: true }` and `init-ack` to the host BEFORE calling render(), and render() failures are only `console.error`'d inside the iframe (`render(m.params).catch(...)`, runtime.ts:412). loadBundle/loadGeneratedComponents/createRoot errors never reach the host. Concrete scenario: a host passes a bundleSource that throws at eval time (or an externalized bundle without reactSource, so window.__React/__createRoot are undefined) — `controller.initialize()` resolves successfully, the host shows no error state, and the user gets a permanently blank sandbox. This is a silent failure on critical flow #2 (first render); neither VendoStage nor vendo-next's SandboxStage can render an error state because no error crosses the bridge. Fix direction: reply to ui/initialize only after render() settles (or post an error notification the host surfaces).

### [vendo-stage] connectStage.update() silently drops anchorData — live-refresh of swr-fed generated views never reaches the sandbox
- file: `packages/vendo-stage/src/stage-host.ts:472` · kind: bug · verified by: claude-panel

StageUpdatePayload declares `anchorData` and the runtime's ui/update handler applies it to `window.__vendoAnchorData` (runtime.ts:436-439), but connectStage.update() builds the RPC payload from only theme/state/replace — anchorData is never forwarded. The vendo-react adapter relies on this exact path: on a same-structure data refresh it calls `c.update({ anchorData: freshAnchor })` (packages/vendo-react/src/stage-adapter.tsx:179). Concrete scenario: a voice-refreshed view or saved-vendo live refresh delivers new anchor data with unchanged structure; bound-prop nodes update via replace, but any generated component reading through the swr shim keeps rendering stale data forever, while the host believes the update succeeded (runtime replies ok). Breaks critical flows #5 (live refresh), #6 (remix fast edits), #7 (voice refreshed views). One-line fix: `if (update.anchorData) payload.anchorData = update.anchorData;`.

### [vendo-stage] Approval-pending API is unusable: the minted actionId is never given to the host app, so resolveAction/cancelAction can never be called
- file: `packages/vendo-stage/src/stage-host.ts:447` · kind: api-inconsistency · verified by: claude-panel

When onAction returns `{ pending: true }`, connectStage mints an actionId AFTER onAction has already resolved, adds it to an internal set, and returns it only to the sandbox runtime. Nothing exposes it to the host app — onAction receives no actionId, and there is no callback or requestId→actionId mapping. Yet `resolveAction(actionId, ...)`/`cancelAction(actionId)` are the documented public approval API (README.md lines 41-42, 27). Concrete scenario: an OSS host follows the README, returns `{ pending: true }` from onAction, then has no way to obtain the actionId; the in-sandbox dispatch promise parks forever (README says there is deliberately no wall-clock expiry) and the generated component hangs until the stage is disposed. Zero in-repo consumers use this path (vendo-next's SandboxStage works around it by never returning pending), confirming it is dead-on-arrival API. Either surface the actionId (e.g. pass a pre-minted id in the ActionRequest or return it from onAction's pending branch) or remove the pending path from the public surface before release.

### [vendo-stage] No "files" field (and no license): npm publish ships src/, ~400KB test bundles, and .turbo logs containing local machine paths
- file: `packages/vendo-stage/package.json:1` · kind: publish-hygiene · verified by: claude-panel

Unlike sibling packages (vendo-next, vendo-server, vendo-shell, vendo-store, vendo-telemetry all declare `"files": ["dist"]`), @vendoai/stage's package.json has no `files` field and no `.npmignore` (repo has none either). `npm publish` would include src/, tests/browser (host-bundle.js + vendo-react-runtime.js ≈ 400KB of test fixtures), test-results/, and .turbo/*.log — which contain absolute local paths like `/Users/yousefh/orca/workspaces/flowlet/vendo-rename/...`. This directly violates the release bar's publish-hygiene item ("No secrets, keys, or internal URLs in published package output"). Also missing a `license` field, which OSS consumers and license scanners will flag. Same gap exists in @vendoai/core (checked as the direct dependency).

### [vendo-stage] Raw host error messages cross the bridge into the sandbox and can be rendered in the DOM by generated code
- file: `packages/vendo-stage/src/bridge.ts:48` · kind: silent-failure · verified by: claude-panel

makeRpc's onRequest catch serializes `err.message` verbatim into the RpcError sent to the sandbox, and the runtime rejects the component's dispatch promise with that exact text (runtime.ts:372). Concrete scenario: a host's onAction throws with an internal error (e.g. a fetch failure exposing an internal service URL, a DB error, or the raw body of a failed /action response — vendo-next's postAction throws `json.error` from the server verbatim); LLM-generated component code catches the dispatch rejection and renders `err.message` into the sandbox DOM, putting raw internal error text in front of the end user. The release bar requires errors to surface "in friendly form, never raw in the DOM". The bridge is the right chokepoint to map errors to a generic message (or an error code the sandbox translates).

### [vendo-telemetry] Dev server silently burns the one-time telemetry notice, so it can collect without disclosure ever being shown
- file: `packages/vendo-server/src/telemetry-dev.ts:20` · kind: silent-failure · verified by: codex

devTelemetry() passes log: () => {} into initTelemetry, but maybeShowNotice (packages/vendo-telemetry/src/notice.ts:15-21) still sets noticeShown=true and saves it to ~/.vendo/telemetry.json. Failure scenario: a user wires @vendoai/server by hand (the docs explicitly allow manual steps; non-Next hosts use the fetch handler directly) and never runs `vendo init`. Their first Vendo touchpoint is the dev server, which sends agent_run/error_class events while the disclosure notice is swallowed by the noop logger — and because noticeShown is now persisted, a later `vendo` CLI run will never show it either. Result: opt-out telemetry collected from a user who was never notified, which is exactly the OSS-launch backlash scenario the notice exists to prevent.

### [vendo-telemetry] Production-runtime telemetry guard fails open when NODE_ENV is unset
- file: `packages/vendo-telemetry/src/consent.ts:24` · kind: silent-failure · verified by: codex

The runtime block is `if (runtime && env.NODE_ENV === "production")` — it only suppresses when NODE_ENV is exactly "production". TELEMETRY.md promises product telemetry "never fires from a deployed production app." Failure scenario: a host deploys a custom Node server (e.g. Express + the fetch handler) without setting NODE_ENV — common outside `next start` — and every chat request and handler error emits agent_run/error_class events from the production box (the mirror guards in vendo-server/src/chat.ts:151 and fetch-handler.ts:659 have the same fail-open shape: `NODE_ENV !== "production"`), plus writes ~/.vendo/telemetry.json on the prod server. The guard should fail closed (send only when NODE_ENV === "development" or unset-and-CLI), matching the release bar's fail-closed requirement and the public privacy claim.

### [vendo-telemetry] An explicit opt-out config without anonymousId is silently overwritten to optedOut:false (fail-open opt-out)
- file: `packages/vendo-telemetry/src/config.ts:25` · kind: silent-failure · verified by: codex

loadConfig only honors the stored config when anonymousId is a non-empty string; otherwise it falls through and OVERWRITES the file with a fresh {optedOut: false} config. Failure scenario: an admin or dotfiles repo preprovisions ~/.vendo/telemetry.json as {"optedOut": true} (the natural way to opt out fleet-wide), or a previously-disabled config gets truncated/corrupted — the next `vendo init` or dev-server run regenerates it as enabled and starts sending events. An explicit opt-out record must be preserved (regenerate only the id) or the load must fail closed; today opting out via file is silently reversible by the tool itself.

## MINORS (59)

### [cross-package-seams] Six publishable packages have no "files" allowlist — npm pack ships src, tests, and browser fixtures
- file: `packages/vendo-stage/package.json:1` · kind: publish-hygiene · verified by: codex

vendo-core, vendo-components, vendo-react, vendo-runtime, vendo-cli, and vendo-stage lack a "files" field (next/server/shell/store/telemetry/sandbox-shims have it). `npm publish` would ship the full source tree: vendo-stage includes tests/browser with playwright configs, prebuilt bundles and an e2e LLM test harness; vendo-cli ships test fixtures; vendo-runtime ships .live.test files. No secrets found in these trees, but it bloats installs, exposes internal test scaffolding as public API surface, and for vendo-cli risks the published bin resolving stale non-dist files. Fails the 'no internal URLs/junk in published package output' hygiene bar; trivially fixed by adding files:["dist"] (plus dist/assets for the CLI).

### [publish-hygiene] No repository/description metadata in any package; 7 of 12 packages have no README
- file: `packages/vendo-server/package.json` · kind: publish-hygiene · verified by: codex

All 12 manifests lack repository, description, homepage, and keywords; components, next, server, shell, store, telemetry, and sandbox-shims have no README.md. npm package pages for the primary entry points of the quickstart (@vendoai/next, @vendoai/server) would render completely blank with no link back to github.com/runvendo, and provenance-based publishing (npm --provenance) requires the repository field. Not install-breaking, but a bad first impression on every package page of a launch.

### [publish-hygiene] typescript listed in both dependencies (^5.9.0) and devDependencies (^5.6.0) of @vendoai/cli with conflicting ranges
- file: `packages/vendo-cli/package.json:24` · kind: publish-hygiene · verified by: codex

The same package appears in dependencies and devDependencies with different ranges. Installers use the dependencies entry, so this mostly works, but pnpm warns on it and the two ranges can drift silently (the CLI genuinely needs typescript at runtime for the extractor, so the devDependencies entry should be deleted). Cosmetic-to-confusing, not install-breaking.

### [vendo-cli] Capture refusal check compares unresolved paths — symlinks inside the app defeat the server-code containment rules
- file: `packages/vendo-cli/src/sync/capture.ts:104` · kind: security · verified by: codex

refusalReason evaluates `path.relative(sourceRoot, file)` on the path as walked/resolved, and walk/resolveModuleFile use statSync (follows symlinks) without realpathSync — unlike env.ts, which explicitly realpaths both sides for the same check (the asymmetry shows the omission). Failure scenario: a symlink under src/ pointing at server code (e.g. src/components/shared -> ../../server/lib, a real pattern in monorepos) makes a `"use server"`-free server module appear inside the source root; a VendoRemix wrapper importing through it gets that file captured verbatim into .vendo/remix-sources.json and fed to the model as a remix baseline, bypassing the documented threat-model refusals (server/, api/, outside-root). Self-inflicted-ish (developer's own symlink), but the refusal layer exists precisely to fail closed here; capture.ts should realpath file and sourceRoot like env.ts does.

### [vendo-cli] Component scan misses the standard shadcn export shape — zero candidates on the most common Next.js UI stack
- file: `packages/vendo-cli/src/components/scan.ts:17` · kind: dx · verified by: codex

EXPORT_RE only matches inline `export function Name` / `export const Name`. shadcn/ui files (the dominant components/ui/ convention the scanner explicitly prioritizes) declare `function Button(...) {...}` and end with `export { Button, buttonVariants }` — no inline export, so the file is silently skipped and `vendo init` reports 0/0 candidates wrapped on a stock shadcn app. No error, no hint; the LLM component-extraction feature just appears broken on exactly the apps it targets. exportNames (the codegen import universe) has the same blind spot. Needs a second regex for `export { ... }` lists / `export default Name`.

### [vendo-cli] Generated .vendo/components build imports packages init never installs (@vendoai/stage, @vendoai/core, zod)
- file: `packages/vendo-cli/src/components/codegen.ts:150` · kind: api-inconsistency · verified by: codex

Generated descriptor.ts imports `zod` and `@vendoai/core`; the generated vite.config.mts imports `@vendoai/stage/build`. The codemod only adds `@vendoai/next` to the host's dependencies, and none of these are re-exported through it. Failure scenario: developer follows the generated README, runs vite on .vendo/components/vite.config.mts — under pnpm (strict node_modules) or Yarn PnP the build fails with unresolved `@vendoai/stage`; even `@vendoai/core`/`zod` resolution depends on hoisting luck. Also: descriptor.ts/impl.tsx sit inside the Next app tree, so `next build` type-checks them — missing @vendoai/core types can fail the host's OWN build right after init. Init should add the needed packages when it writes components/, or the generated files should import only through @vendoai/next.

### [vendo-cli] Re-running init after a mid-run failure hard-fails on the first already-written artifact; recovery clobbers user edits
- file: `packages/vendo-cli/src/init.ts:106` · kind: dx · verified by: codex

runInit's extraction steps write artifacts sequentially via writeGenerated, which throws on any existing file without --force. Failure scenario: first run writes .vendo/theme.json, then the route-scan LLM call fails (network blip, rate limit) → exit 1. The natural retry `vendo init .` now dies immediately at the theme step with "theme.json already exists — re-run with --force" and never reaches tools extraction or Next wiring at all; the only forward path is --force, which silently overwrites any hand edits to ALL previously generated files (the README explicitly invites editing them). A skip-if-identical or per-artifact skip-and-continue would make the documented retry path safe. This turns any transient LLM failure during flow 1 into a manual-recovery situation.

### [vendo-cli] Publish hygiene: no files allowlist, hardcoded --version 0.0.0, typescript pinned in both deps and devDeps with conflicting ranges
- file: `packages/vendo-cli/package.json:1` · kind: publish-hygiene · verified by: codex

Three pre-publish issues in one: (1) package.json has no `files` field, so `npm publish` ships src/, test fixtures, scripts/, and vite configs alongside dist — bloat and internal-detail leakage in the published tarball (the release bar calls out published package output hygiene). (2) `vendo --version` (cli.ts:43) and the telemetry version prop (init.ts:39, 'version: "0.0.0"') are hardcoded to 0.0.0 rather than read from package.json — every published release will misreport its version in both the CLI and telemetry, making support/telemetry segmentation useless. (3) `typescript` appears in dependencies (^5.9.0) AND devDependencies (^5.6.0); the conflicting duplicate is an npm-publish wart and makes it ambiguous which range consumers install.

### [vendo-components] hostComponent() rejects reserved primitive names but not catalog names — collision surfaces only as a runtime sandbox boot failure
- file: `packages/vendo-components/src/host-component.ts:41` · kind: dx · verified by: codex

hostComponent validates PascalCase and RESERVED_COMPONENT_NAMES (Stack/Row/...) at module load, per its own doc: "a bad registration should break the build, not a render at runtime". But the 22 prewired catalog names (Card, Table, Chart, ...) are not checked, even though they are statically known in the same package. A host registering hostComponent("Card", ...) passes registration, typecheck, and build; the failure is deferred to installVendoHost's throw inside the sandbox bundle at first render — which, combined with the stage's swallowed render rejection, is a blank stage with console-only error. The registration-time guard is trivially available (descriptors list) and would make the failure a build failure as designed.

### [vendo-components] Image/ImageGallery/Carousel schemas accept any string URL but impls silently render blank for non-data: sources
- file: `packages/vendo-components/src/components/Image/impl.tsx:9` · kind: silent-failure · verified by: codex

Descriptors validate src/imageUrl as z.string() (with only a .describe() hint about data:image), while the impls drop anything that is not an allowlisted data:image URI and render an empty placeholder div (Image), an empty gallery div (ImageGallery), or omit the img (Carousel). Concrete scenario: the agent emits an https:// image URL (models do this despite the hint, especially when tool results contain image URLs) — server-side validation accepts the view, and the sandbox shows a blank region with no fallback text or EmptyState. The CSP rejection is correct; the silent blank violates the "loading/error/empty states exist and look intentional" bar. Either reject at the schema (so the agent gets a validation error and can self-correct) or render a visible "image unavailable" state.

### [vendo-components] bindHostImpl validates runtime-injected keys against the host's schema — a .strict() host schema always renders the invalid-props fallback
- file: `packages/vendo-components/src/bind-host-impl.tsx:41` · kind: api-inconsistency · verified by: codex

The stage injects `vendo` and `__nodeId` into every node's props (runtime.ts:300-307) before the component renders, and bindHostImpl runs `descriptor.propsSchema.safeParse(raw)` on the raw props including those injected keys. A host developer who defines their props schema with z.object({...}).strict() — a natural instinct for a security-oriented registration API — gets a component that ALWAYS renders "Invalid component props" inside the stage while working fine in tests/stub renderers (no injection there). Nothing in hostComponent() or the docs forbids strict schemas. Fix: strip the runtime keys before validation (they are already extracted separately) or document/reject strict schemas at registration.

### [vendo-components] Unbounded collection schemas on several catalog components (List, Tabs, Accordion, Steps, Tags, Form, Carousel)
- file: `packages/vendo-components/src/components/List/descriptor.ts:5` · kind: security · verified by: codex

Table (max 1000 rows), Chart (max 2000), Sankey (80/200), Donut (10), ImageGallery (60) and KeyValue (30) all cap model-controlled arrays as DoS defense, but List items, Tabs, Accordion items, Steps, Tags, Form fields/options and Carousel items have z.array(...).min(1) with no max. A malformed or adversarial generated/saved view with 100k list items passes validation and maps straight into React elements; the sandbox iframe is typically same-process with the host page, so this can lock the host's main thread. Inconsistent application of the package's own stated defense pattern.

### [vendo-components] componentPromptCatalog emits no props hint for ZodEffects schemas — Sankey loses its field hint
- file: `packages/vendo-components/src/prompt-catalog.ts:7` · kind: dx · verified by: codex

fieldHint duck-types `.shape`, which exists on ZodObject but not on ZodEffects. sankeySchema uses .superRefine(), so it is a ZodEffects and the agent's system-prompt line for Sankey carries no `props: { ... }` hint — the exact mechanism the comment says exists so "the model uses exact prop names". Any future catalog/host schema that adds .refine()/.superRefine()/.transform() silently loses its hint too. Result: more invalid-props fallbacks for Sankey views (the component whose nodes/links shape is hardest to guess). Unwrap `._def.schema` / use zod's innerType to reach the object shape.

### [vendo-components] OpenUI dev-console warns 10x that the chart palette theme keys 'will be ignored' in every host dev session
- file: `packages/vendo-components/src/theme/map-brand-to-theme.ts:61` · kind: ui-consistency · verified by: codex

mapBrandToTheme sets defaultChartPalette/barChartPalette/lineChartPalette/areaChartPalette/pieChartPalette, which are not in OpenUI 0.12.1's _knownThemeKeys, so every dev-mode render prints 10 `[OpenUI] lightTheme/darkTheme contains unknown key ... It will be ignored` warnings (reproduced in this package's own test run). Verified the warning is factually wrong for this version — ThemeProvider spreads user keys into the merged theme and useChartPalette reads theme[themePaletteName], so brand palettes DO apply — but every OSS adopter's first dev session shows a wall of warnings claiming the brand theming is broken, and a future OpenUI version that actually filters unknown keys would silently drop brand chart colors. Suppress via OpenUI's supported mechanism (createTheme or a version with these keys registered).

### [vendo-core] No `files` allowlist → npm publishes src, tests, and .turbo logs containing internal absolute paths
- file: `packages/vendo-core/package.json:1` · kind: publish-hygiene · verified by: claude-panel

Unlike sibling packages (@vendoai/next, @vendoai/server, @vendoai/store all set `"files": ["dist"]`), vendo-core has no `files` field, so `npm pack` includes the entire src/ (with all *.test.ts), scripts/, and .turbo/*.log. The release bar forbids 'internal URLs in published package output'; .turbo/turbo-build.log embeds an internal absolute filesystem path (`/Users/yousefh/orca/workspaces/flowlet/vendo-rename/packages/vendo-core`) from another worktree. Verified via `npm pack --dry-run`. Fix: add `"files": ["dist", "schemas"]` (schemas are the only non-dist runtime asset).

### [vendo-core] capToolOutput base64 heuristic can silently delete legitimate long strings from tool results
- file: `packages/vendo-core/src/prompt/cap-tool-output.ts:39` · kind: silent-failure · verified by: claude-panel

looksLikeBase64 flags any string >512 chars matching `^[A-Za-z0-9+/=\r\n]+$` that also mixes case+digits, replacing it with '[binary data omitted]' before the result enters the model context. A long opaque token, a long alphanumeric id list, or a base64-ish-but-meaningful field (e.g. a JWT-like access reference, a signed URL query blob, or a long hex+alnum log) that happens to contain only those chars is destroyed with no way for the model to recover it, and the 'truncated' note only says 'binary blob(s) omitted'. On the host-tool/voice/remix ingestion paths this can make the model reason over data that was silently removed. This is a heuristic tradeoff but on critical flows it produces wrong answers with no user-visible signal that real content (not binary) was dropped.

### [vendo-next] Integrations disconnect silently succeeds even when the server rejects it
- file: `packages/vendo-next/src/client/integrations.ts:48` · kind: silent-failure · verified by: codex

createServerIntegrations.disconnect() POSTs to /integrations and returns `{...find(id), connected:false}` regardless of res.ok — only the cache update is gated on ok. If the request 403s (expired session under a custom principal) or 500s, the UI shows the integration disconnected while the server-side connection (and agent ingestion) remains active. Inconsistent with the same file's connect() path and server-store.ts, both of which throw loudly on failure; the release bar requires persistence failures to fail closed/loud.

### [vendo-next] Capabilities fetch failure leaves chat UI optimistically enabled forever
- file: `packages/vendo-next/src/client/vendo-root.tsx:203` · kind: silent-failure · verified by: codex

The capabilities fetch swallows all errors (catch -> stays null) and chatEnabled = `capabilities === null || capabilities.chat`, which is documented as intentional only for the brief pre-fetch window. But a persistent failure (host mounted the route somewhere other than the default /api/vendo basePath, or the handler boot 500s) leaves capabilities null indefinitely, so the 'Ask' launcher and overlay render as if working; the user only discovers chat is broken when /chat fails at send time. No surfaced error, no closed state.

### [vendo-next] VendoRoot never wires onNavigate, contradicting the documented router integration
- file: `packages/vendo-next/src/client/sandbox-stage.tsx:133` · kind: api-inconsistency · verified by: codex

SandboxStageProps.onNavigate documents 'VendoRoot wires useRouter().push' so generated-UI navigation stays client-side. But vendo-root.tsx renders `<SandboxStage node brand components basePath />` with no onNavigate, so the reserved vendo.navigate action falls through to the default `location.assign(href)` — a full document reload instead of a Next client-side transition. Behavior contradicts the API docstring and degrades in-app navigation from remixed views.

### [vendo-react] Approved host tool never executes when chat status is 'error' — silent deadlock
- file: `packages/vendo-react/src/provider.tsx:133` · kind: bug · verified by: claude-panel

HostToolRunner's effect bails unless `status === "ready"`. If a stream delivers a host tool call plus its approval request and then errors before finishing cleanly (mid-stream disconnect → status "error"), the approval card is already in the message list. The user clicks Approve → `addToolApprovalResponse` updates messages, but the runner refuses to execute (status is "error") and `hostAwareSendAutomaticallyWhen` blocks resubmission because the approved host tool owes an output. Result: the thread hangs with no feedback and no retry path until the user sends a new message. The gate should also accept the error state (or approvals should be disabled once status is error).

### [vendo-react] Theme/state changes arriving before stage-ready are silently dropped; stage initializes with stale values
- file: `packages/vendo-react/src/stage-adapter.tsx:222` · kind: bug · verified by: claude-panel

The node effect (deps `[node]`) captures theme/state/componentTheme in its closure and initializes inside `c.ready.then(...)`; the separate theme/state effects skip updates while `initedRef.current` is false. Concrete failure: host renders VendoStage with node set and theme={} on first paint, then brand tokens load and theme updates on the next render while the iframe is still booting (ready unresolved) and node identity is unchanged — initialization uses the stale empty theme, the newer theme was skipped, and the sandbox stays unbranded until some later theme change or node change. Violates the brand-native UI bar for standalone VendoStage users (the vendo-next path passes a static theme so it escapes this).

### [vendo-react] Stale anchorData kept when a same-structure generated payload omits its anchor
- file: `packages/vendo-react/src/stage-adapter.tsx:179` · kind: bug · verified by: codex

On the data-delta path the adapter does `if (freshAnchor) c.update({ anchorData: freshAnchor })` — when a refreshed payload with identical structure has `data.anchor` absent/null (e.g. a live-refresh where the upstream anchor fetch failed or the model dropped the key), the sandbox keeps the previous `window.__vendoAnchorData`, so swr-shim-driven generated components keep displaying the old account/customer data with no indication it is stale. Should explicitly clear/replace anchor data when absent rather than skipping the update.

### [vendo-react] Raw generated-payload validation error rendered into the sandbox DOM
- file: `packages/vendo-react/src/stage-adapter.tsx:143` · kind: ui-consistency · verified by: codex

When createGenUISession rejects a payload, the adapter renders `"Failed to render generated UI: " + result.error.message` as a Text node in the stage. The message is the internal validation/provision error (e.g. unsupported formatVersion string, resolver throw text echoing payload internals) shown verbatim to the end user. Concrete failure: the model emits a payload with a bad formatVersion → the user sees internal schema wording instead of a friendly "couldn't render this view" message. The release bar says errors must never appear raw in the DOM; log the detail to console (already done) and render a friendly message.

### [vendo-runtime] resume_automation re-enables a spent/expired one-shot into an enabled-forever zombie that never fires
- file: `packages/vendo-runtime/src/automations/tools.ts:413` · kind: bug · verified by: claude-panel

resumeAutomation sets status "enabled" and syncSchedule re-registers the trigger, but for a schedule trigger with `at` in the past the scheduler's dueOccurrence (`atMs > windowStartMs`) can never match, so the automation shows enabled and simply never runs — the exact zombie state vendo-server's boot rehydration explicitly parks ("spent/expired one-shots must not zombie"). Concrete scenario: user pauses a one-shot scheduled for 5pm, asks to resume it at 6pm (or resumes an automation the runner parked with disabledReason "completed_one_shot"): the model reports `{ ok: true }`, the library shows it enabled, nothing ever fires, and only the next server restart parks it. Fix shape: in resume (or syncSchedule), detect a past `at` and either refuse with a model-correctable error or park it as completed_one_shot like boot does.

### [vendo-runtime] Client-tool audit dedupe marks toolCallId as seen BEFORE policy.onExecuted succeeds — a transient audit failure permanently drops that call's trail and breaker count
- file: `packages/vendo-runtime/src/engine.ts:646` · kind: silent-failure · verified by: codex

alreadyAuditedClientCall() adds the id to the FIFO as a side effect of the check, and auditClientExecutedTools then swallows any onExecuted error (engine.ts:592-596, logged only). If the composed policy's onExecuted fails transiently (e.g. the host's AuditLog append hits a momentary DB error — note auditPolicy itself swallows, but a host-composed layer or volumeBreaker's inner chain can throw), the toolCallId is already marked seen, so every future re-scan of the same settled history skips it: the tool_execution audit event for that client-executed host-API call is lost forever and volumeBreaker never counts it. Concrete scenario: client-executed transfer_funds succeeds in the browser; on the next turn the audit append races a Postgres failover — the audit trail permanently has no record of the execution. Fix shape: mark seen only after onExecuted resolves (or unmark on failure).

### [vendo-runtime] Per-turn threadId fallback (`thread-<runCounter>`) fragments a threadId-less conversation, silently breaking session grants and consent lookups
- file: `packages/vendo-runtime/src/engine.ts:740` · kind: dx · verified by: codex

When RunInput.threadId is absent, each run() mints a NEW fallback id from the incrementing runCounter — so turn 1 of a conversation persists (onSettled) and evaluates policy under "thread-1", turn 2 under "thread-2". Consequences for a host that drives the engine directly without wiring threadIds (the config surface allows it): (a) "allow once" session grants minted by handleConsent with contextKey=threadId never match on the next turn (grantMatches fails closed), so the user is re-asked for a byte-identical call every single turn — the retired-rememberDecisions regression the consent path was built to fix; (b) onSettled persistence scatters one conversation across N store threads, so handleConsent's getMessages(threadId) can 404 a legitimately pending approval. Everything fails closed (no security issue), but the degradation is silent and undocumented. Fix shape: document threadId as required for grants/consent, or derive a stable fallback per conversation rather than per turn.

### [vendo-sandbox-shims] Link shim drops query/hash from UrlObject hrefs — host navigates to the wrong URL
- file: `packages/vendo-sandbox-shims/src/next-link.tsx:20` · kind: api-inconsistency · verified by: claude-panel

hrefString() reads only href.pathname. A remixed component using Next's object form, e.g. `href={{ pathname: "/invoices", query: { status: "overdue" } }}`, renders an anchor href="/invoices" and navigates the host to /invoices with the filter silently dropped — wrong page state with no error. An object with only query/hash yields navigate(""), which the host receiver rejects (compounding finding 4's dead click). Fix: serialize pathname + query + hash like Next's format-url does.

### [vendo-sandbox-shims] usePathname()/useSearchParams() return empty values instead of the anchor's real route state — route-dependent UI silently wrong
- file: `packages/vendo-sandbox-shims/src/next-navigation.ts:27` · kind: api-inconsistency · verified by: claude-panel

Real next/navigation never returns "" from usePathname. Captured components branching on route state misrender silently: apps/demo-accounting/src/components/shell/sidebar.tsx:59 never marks the active route, and client-table.tsx:163 ignores `?q=` filters, when those components are remixed. The host knows its pathname/search at render time and already injects anchorData through the same channel, so this is fixable (inject location into the init payload and have the shims read it); today it is a silent wrong-UI degradation rather than an error.

### [vendo-sandbox-shims] Link ignores event.defaultPrevented and modified clicks — user onClick cannot cancel navigation
- file: `packages/vendo-sandbox-shims/src/next-link.tsx:31` · kind: api-inconsistency · verified by: claude-panel

Real next/link calls the user's onClick and returns without navigating if event.defaultPrevented is set, and skips client navigation for cmd/ctrl/shift/alt/middle clicks. The shim calls onClick?.(event) then unconditionally navigate(target). Concrete failure: a captured component with `<Link href="/danger" onClick={(e) => { if (!confirm("Sure?")) e.preventDefault(); }}>` navigates the host even when the user cancels the confirm. Fix: check event.defaultPrevented (and modifier keys) before dispatching.

### [vendo-sandbox-shims] Built dist is not Node-ESM loadable: extensionless relative imports ("./dispatch") in emitted JS
- file: `packages/vendo-sandbox-shims/src/index.ts:6` · kind: publish-hygiene · verified by: claude-panel

tsc emits `export ... from "./dispatch"` without the .js extension (verified in dist/index.js and dist/next-link.js). Node ESM requires explicit extensions, so importing the package's root export ("exports": "./dist/index.js") fails with ERR_MODULE_NOT_FOUND. Today this is latent — the only consumer (vendo-cli env.ts) bundles individual dist files with esbuild, which resolves extensionless — but once the package is published (required by finding 1) any direct consumer or a future non-esbuild path breaks at import time. Same class of issue as the known "dists need NodeNext before ENG-198" item; this package should be included in that fix (moduleResolution NodeNext + .js specifiers).

### [vendo-sandbox-shims] router.back()/forward() throw synchronously inside event handlers — uncaught exception, dead button, not a 'contained' error
- file: `packages/vendo-sandbox-shims/src/next-navigation.ts:12` · kind: bug · verified by: claude-panel

The shim throws "[vendo] router.back() is not available..." intending a descriptive contained error, but back/forward are almost always called from click handlers, and React error boundaries do NOT catch event-handler throws. A remixed component with a Back button (`onClick={() => router.back()}`) yields an uncaught exception in the sandbox console and a button that silently does nothing — no friendly surface, violating the no-raw-errors/fail-friendly bar. Fix: console.warn + no-op (matching refresh/prefetch), or dispatch a host-visible notice.

### [vendo-server] .vendo read failures (EACCES/ENOTDIR/EIO) are silently treated as 'file absent', wiping host tools/theme/MCP config with no signal
- file: `packages/vendo-server/src/vendo-dir.ts:61` · kind: silent-failure · verified by: codex

readJson's first catch swallows EVERY readFileSync error and returns undefined ('absent → caller defaults'), not just ENOENT. The module's own contract says a PRESENT-but-broken file must fail loud, but a present-and-unreadable file fails silent. Concrete failure: a deployed container ships .vendo/ with wrong permissions (root-owned from a Docker COPY) — tools.json/theme.json/mcp.json all read as absent, so the agent silently loses every host API tool, brand tokens, and MCP server; chat still 'works' and nothing logs why the product suddenly has no capabilities (critical flows 2/3/8 degrade invisibly).

### [vendo-server] Client-owned thread ids that equal reserved route segments make GET /threads/<id> misroute (vendos are validated, threads are not)
- file: `packages/vendo-server/src/threads.ts:42` · kind: bug · verified by: codex

The ThreadIndex adopts the client-supplied threadId verbatim as the store thread id (restart-safe rework), and routeTail scans right-to-left for the FIRST_SEGMENTS set — its own Boundary note assumes 'ids here are UUIDs', which no longer holds for threads. vendos.ts rejects reserved ids at save time for exactly this reason; thread ids get no such check. Concrete failure: a host passes VendoRoot threadId="chat" (a perfectly natural name) — POST /chat persists fine, but GET /threads/chat resolves tail "chat" → 404, so reopening the conversation silently fails; threadId="vendos" is worse — GET /threads/vendos returns the saved-vendos LIST (wrong endpoint, wrong shape) to the thread client.

### [vendo-server] POST /vendos accepts an unvalidated draft; a non-numeric updatedAt/createdAt throws RangeError → 500 on the durable path
- file: `packages/vendo-server/src/vendos.ts:172` · kind: bug · verified by: codex

handleVendosPost only validates `id`; the rest of the draft is spread verbatim into the record. On the Drizzle path, `new Date(updatedAt).toISOString()` (vendos.ts:172/176) throws 'RangeError: Invalid time value' for any non-numeric client value. Concrete failure: POST /vendos with {"id":"x","updatedAt":"yesterday"} → uncaught RangeError → framework 500 instead of a 400; on the in-memory path the same draft silently corrupts list() ordering (NaN comparisons). Saved-vendos is critical flow 5.

### [vendo-server] Integration status poll swallows all Composio errors with no server log and reports a terminal 'failed' — a transient blip loses webhook routing
- file: `packages/vendo-server/src/integrations.ts:80` · kind: silent-failure · verified by: codex

The GET ?status branch's bare `catch { return { status: "failed" } }` logs nothing (the connect path right below logs before answering), so a failed connect is undiagnosable server-side. Worse: if OAuth actually succeeded but the poll hit one transient network/Composio error, the client treats 'failed' as terminal — setConnectedAccount never runs, so the toolkit never flips connected and the Composio connected-account → principal mapping used by webhook routing (findByConnectedAccount) is never recorded; inbound triggers for that account are skipped until the user redoes OAuth.

### [vendo-server] VENDO_MODEL=<provider>/<model> is not credential-matched: capabilities advertise chat while the selected provider has no key
- file: `packages/vendo-server/src/model-choice.ts:60` · kind: api-inconsistency · verified by: codex

resolveModelChoice honors an explicit `openai/...` override regardless of which keys exist, while detectCapabilities reports chat:true if ANY big-3 key is present (capabilities.ts:45). Concrete failure: deploy sets ANTHROPIC_API_KEY plus VENDO_MODEL=openai/gpt-5.5 (peer installed) — /capabilities says chat works, the client shows the surface, and every turn fails at the provider call with a missing-OPENAI_API_KEY error mid-stream instead of the clean 503 the no-key path gets.

### [vendo-server] GET /capabilities bypasses the principal guard entirely, disclosing configuration to unauthenticated callers even in fail-closed production
- file: `packages/vendo-server/src/fetch-handler.ts:670` · kind: security · verified by: codex

Every other data-bearing route runs resolvePrincipal, and production without a `principal` resolver fails closed (guard.ts) — but the capabilities case returns immediately with no guard. Any anonymous internet caller on a deployed app learns which provider/Composio/voice keys are configured, whether MCP servers are declared, and whether durable storage is wired ({chat, integrations, voice, mcp, storage}). Reconnaissance-grade info only, but it contradicts the handler's own fail-closed production posture.

### [vendo-shell] Parked-action approve/decline and trust revoke fail silently with no error handling
- file: `packages/vendo-shell/src/use-parked-actions.ts:27` · kind: silent-failure · verified by: claude-panel

`parkedActions.resolve(actionId, "yes").then(refresh)` has no catch — same for decline, useTrustData's revoke/revokeRule, and all four unguarded `.then(set...)` poll calls in useTrustData.refresh. Failure scenario: the host's parked-actions route 401s/500s; the user clicks Approve on a parked (possibly critical-tier) action in the WaitingList, nothing happens, no error is shown, and an unhandled promise rejection is thrown; the row just stays. The 30s polls also emit unhandled rejections continuously when the seam errors. Violates the "no silent failures on critical paths" bar for the automations approval flow (critical flow #4).

### [vendo-shell] Consent-channel POST failures fail open with no developer-visible signal
- file: `packages/vendo-shell/src/VendoThread.tsx:230` · kind: silent-failure · verified by: claude-panel

postConsent swallows every sendConsent rejection (`.catch(() => undefined)`) while the SDK approval resumes immediately, so a misconfigured/401ing consent endpoint means mutating tools run while the grant/audit/fade signal is silently lost — not even a console.warn. The "best-effort, never blocking" posture is deliberate (ENG-193 §4.5), but zero logging makes the broken-audit-trail state undiscoverable for a host developer. At minimum log the failure; worth an explicit release decision on whether audit-less approvals are acceptable fail-open behavior.

### [vendo-shell] Default seam instances recreated on any provider re-render with unstable props
- file: `packages/vendo-shell/src/context.tsx:203` · kind: bug · verified by: claude-panel

The useMemo builds `store ?? createLocalStore()` (and local integrations/remixes/notifications) inside the memo, keyed on 15 deps including `cssVars`, `theme`, and `impls`. Failure scenario: a host that omits `store` and passes `cssVars={{...}}` inline (new object identity every render) gets a brand-new in-memory store on every parent re-render — saved vendos and remix pins vanish mid-session, not just "on remount" as the dev warning claims. Hoist the defaults into useState/useRef so they are stable per provider instance.

### [vendo-shell] Integration connect failures swallowed — row silently returns to '+'
- file: `packages/vendo-shell/src/components/IntegrationsPicker.tsx:49` · kind: silent-failure · verified by: claude-panel

connect() wraps onConnect with `.catch(() => undefined)`; on failure the connecting spinner just reverts to the + button after 120ms with no error copy anywhere (VendoThread's onConnect chain `integrations.connect(id).then(list).then(setTools)` adds no handling either). Failure scenario: the OAuth/connect route fails (network error, 500); the user clicks +, sees a brief spinner, then the untouched + again — no explanation, indistinguishable from nothing having happened. Similar gap: VendoThread's applyRemix only console.warns when pinning fails, so "Apply to page" clicks can silently do nothing.

### [vendo-shell] Voice transcript can duplicate a caption line when its final event arrives after promotion
- file: `packages/vendo-shell/src/voice/voice-session.ts:102` · kind: bug · verified by: claude-panel

reduceVoice promotes an un-finalized live caption into the transcript when a different utterance id takes the slot (the "never lose words" rule), but keeps no record of the promotion; if the original utterance's `completed` event then arrives (out-of-order transcription is exactly why the two-slot design exists), the final line is appended again with the same id — a duplicated line in the stage transcript, a duplicate React key in VoiceStage's drawer (`key={line.id}`), and duplicated text in the thread record voiceSessionMessages lands. Failure scenario: user speaks two quick utterances; the first's transcription completes late; the transcript shows the first utterance twice (partial + full).

### [vendo-stage] dispose() leaves in-flight promises pending forever (rpc calls, controller.ready, and in-sandbox phase-1 dispatches)
- file: `packages/vendo-stage/src/bridge.ts:81` · kind: bug · verified by: claude-panel

rpc.dispose() runs each pending call's cleanup() but never rejects them, and connectStage.dispose() clears the ready timer without settling the `ready` promise. Concrete scenario: a host does `await controller.initialize(...)` (or `await controller.ready`) and the component unmounts/disposes before the iframe replies — the awaited promise never settles, so any host cleanup flow, queue, or Suspense-like state machine chained on it hangs silently. Mirror image in the sandbox: ui/teardown rejects only phase-2 __pendingActions; a dispatch still awaiting its initial tools/call reply is never settled, leaving the generated component stuck in its loading state if the iframe isn't also removed. dispose should reject all pending rpc calls and the unsettled ready promise with an abort-coded error.

### [vendo-stage] ui/update before initialize RESOLVES with { ok:false } instead of rejecting — inconsistent with every other update failure
- file: `packages/vendo-stage/src/runtime.ts:419` · kind: api-inconsistency · verified by: claude-panel

When ui/update arrives before ui/initialize, the runtime replies with `result: { ok: false, error: "not initialized" }` — a successful RPC result — while a partial replace or unknown nodeId replies with `error: {...}` and rejects the host promise. Concrete scenario: a standalone host calls `await controller.update({ state })` before initialize; the promise resolves, try/catch sees success, and the host proceeds believing state was applied when nothing happened. Callers must special-case inspecting `result.ok`, which no consumer does (the vendo-react adapter ignores update results entirely). Make the not-initialized path reply with an RpcError like the other failure paths.

### [vendo-stage] applyDataPatch mutates the data model, then swallows resolve failures as [] — UI silently diverges from getData()
- file: `packages/vendo-stage/src/genui-host.ts:164` · kind: silent-failure · verified by: claude-panel

applyDataPatch applies the pointer patch to `data` first, then resolves affected subtrees inside a try/catch whose catch returns []. Concrete scenario: a registered host component's propsSchema validator throws (not returns issues) for a patched value — the session's data model now holds the new value (getData() reflects it) but zero replacements are returned, so the sandbox keeps rendering the pre-patch props and the host gets no error signal. Subsequent patches to other pointers keep working, so the divergence persists unnoticed. Either surface the error to the caller or roll back the data mutation on failure.

### [vendo-stage] README documents the wrong CSP and an incomplete createStage return shape
- file: `packages/vendo-stage/README.md:10` · kind: publish-hygiene · verified by: claude-panel

The README's security-model section states the sandbox CSP is `script-src 'unsafe-inline' blob:`, but buildSrcdoc actually emits `script-src 'nonce-<random>' blob:` (deliberately hardened, per the in-code comment rejecting 'strict-dynamic'). Publishing a security README that overstates laxness ('unsafe-inline') will draw incorrect security reports and fails the release bar's "public API surface … matches the docs" item. Same doc also says createStage returns `{ iframe, endpoints }`, omitting the required `dispose` handle whose absence leaks the window resize listener (the code comment explicitly warns the listener does NOT die with the iframe). Docs-only fix.

### [vendo-stage] Duplicate node ids silently collapse capability provenance to the last-minted token
- file: `packages/vendo-stage/src/stage-host.ts:352` · kind: bug · verified by: codex

attachCapabilities (host) and buildCapabilityMap (runtime) both key by node.id with last-write-wins and no duplicate detection. Concrete scenario: a tree passed directly to controller.initialize contains two action-bearing nodes with the same id "pay" (LLM payloads are validated for id uniqueness upstream in genui, but direct StageInitPayload trees are not); both nodes dispatch as originNodeId "pay" carrying the last-minted token, so host-side auditing cannot distinguish which control fired, and the first node's token would be rejected if components captured tokens per-node. Since the code itself documents originNodeId as bookkeeping rather than a trust boundary, this is a correctness/auditability gap, not a sandbox escape — worth a cheap duplicate-id rejection at initialize.

### [vendo-store] upsertMessages([]) early-returns before the auto-create path, breaking the seam contract ThreadIndex.resolve depends on
- file: `packages/vendo-store/src/thread-store.ts:179` · kind: api-inconsistency · verified by: codex

Drizzle upsertMessages does `if (messages.length === 0) return;` BEFORE the unknown-thread insert, while InMemoryThreadStore creates the thread row even for an empty array. packages/vendo-server/src/threads.ts:42 explicitly relies on `upsertMessages(scope, clientId, [])` to mint the thread row ('empty upsert = auto-create', the restart-safety design), then memoizes success. With durable storage the row is silently never minted at resolve time; it only appears at the first non-empty write. Concrete divergence: durable mode, client thread id resolved, then GET threads/<id> (or threads.get from any other path) before the first message write returns not-found where the in-memory store returns a record; the resolve-time mint the restart-safe mapping design documents simply doesn't happen. Low user-visible impact today because chat.ts upserts the last user message immediately after resolve, but it is a confirmed contract break between the two store implementations on the persistence seam.

### [vendo-store] finalizeRun reads automation counters without FOR UPDATE — concurrent finalizations lose counter updates on real Postgres
- file: `packages/vendo-store/src/automation-store.ts:592` · kind: bug · verified by: codex

finalizeRun's transaction SELECTs the automations row plainly (no `.for("update")`, unlike update() at line 378 which added the lock for exactly this race), computes counters in JS, then UPDATEs. Two runs of the same automation finishing concurrently (scheduler tick + run-now, or two webhook firings) under READ COMMITTED both read the same counters and the second overwrite loses an increment: totalRuns/totalFailures undercount and, worse, consecutiveFailures can miss a failure — the park-after-5-consecutive-failures safety threshold (verified by the runner-integration test) can be dodged under concurrency, which is likeliest precisely when an automation is failing repeatedly. PGlite is immune (single-connection serialization); real Postgres is not.

### [vendo-store] Durable connect() resurrects the old connectedAccountId's webhook routing after a disconnect, diverging from the in-memory store
- file: `packages/vendo-store/src/connections-store.ts:87` · kind: api-inconsistency · verified by: codex

disconnect() keeps connectedAccountId on the row (only flips status), and connect()'s onConflictDoUpdate sets `{ status: CONNECTED }` only — so a disconnect -> connect cycle (the fast path at packages/vendo-server/src/integrations.ts:122, which never calls setConnectedAccount) silently re-enables findByConnectedAccount routing for the previously-stored account. The in-memory store deletes routing on disconnect and plain connect() does not restore it, so the two 'drop-in compatible' stores behave differently: with durable storage, Composio webhooks for an account the user disconnected resume firing automations after a fast-path reconnect without a fresh OAuth-verified account tie (the stored id may be an older account than the currently-active one hasActiveConnection saw). Mitigated by the hasActiveConnection guard, but the routing tie is stale/unverified.

### [vendo-store] findByConnectedAccount fails open on ambiguous connectedAccountId (non-unique index, arbitrary rows[0])
- file: `packages/vendo-store/src/connections-store.ts:143` · kind: security · verified by: codex

The schema puts only a non-unique index on connected_account_id (schema.ts:117) and findByConnectedAccount returns rows[0] of all CONNECTED matches. If two rows ever share an account id (e.g. the same Composio connected account recorded under two subjects once multi-tenant principals are in play, or under two toolkits), webhook routing silently picks an arbitrary principal/toolkit and can fire automations under the wrong scope. Should be unique at the schema level or fail closed (return undefined / error) on >1 match. Low likelihood in v1 (the server wires this store with a single WORLD_SCOPE), but it is a fail-open on the webhook->principal trust boundary.

### [vendo-store] VendoDb.cacheKey carries the raw Postgres connection string (including password) on the exported handle
- file: `packages/vendo-store/src/db.ts:18` · kind: security · verified by: codex

For the pg kind, cacheKey IS the connection string (db.ts:43) and it is a plain enumerable field on the exported VendoDb type that gets passed through vendo-server wiring. Any host-side debug log, error reporter breadcrumb, or JSON dump of the handle/state object leaks `postgres://user:password@host/db`. migrateVendoDatabase depends on cacheKey being the conn string (db.ts:91), so the fix needs an opaque cache key plus a private/non-enumerable slot for the connection string. Defense-in-depth against the release bar's no-secrets-in-output requirement; Vendo's own code never logs it today.

### [vendo-store] parkedActions table is the only schema table not re-exported from the package entry point
- file: `packages/vendo-store/src/index.ts:10` · kind: api-inconsistency · verified by: codex

index.ts re-exports every other table (automations, automationRuns, threads, savedVendos, connections, meta, ...) specifically because consumers must build Drizzle queries against THIS package's drizzle-orm instance (the header comment explains the pnpm peer-hash nominal-typing break), and package.json exposes only the '.' entry. parkedActions (schema.ts:58) is omitted, so a consumer needing out-of-band/admin queries over parked actions cannot get the table object without hitting the exact cross-instance type break the re-exports exist to prevent. Server routes go through DrizzleAutomationStore methods today, so nothing is broken in-repo — this is a public-API-coherence gap for the OSS surface.

### [vendo-telemetry] Env-level opt-out (DO_NOT_TRACK / VENDO_TELEMETRY_DISABLED / CI) still writes a tracking UUID and prints the collection notice
- file: `packages/vendo-telemetry/src/index.ts:29` · kind: silent-failure · verified by: codex

initTelemetry runs loadConfig (which creates ~/.vendo/telemetry.json with a fresh anonymousId on first run) and maybeShowNotice BEFORE any consent resolution — consent is only checked inside track(). Failure scenario: a user with DO_NOT_TRACK=1 set globally runs `vendo init`; no events are sent, but Vendo creates a dotfile containing a tracking UUID and prints "Vendo collects anonymous, opt-out usage telemetry..." — telling a user who has already opted out that they are being tracked. Bad optics and a privacy side effect under explicit opt-out; short-circuit env/CI opt-outs before creating or saving config.

### [vendo-telemetry] loadConfig's fresh-file save is outside the try/catch and can throw, crashing `vendo telemetry status` with a raw stack
- file: `packages/vendo-telemetry/src/config.ts:37` · kind: bug · verified by: codex

The corrupt-file path is caught, but the fresh-config path calls saveConfig unguarded — mkdirSync/writeFileSync throw on a read-only or nonexistent HOME (containers running as nobody, HOME unset/misset). initTelemetry therefore throws, violating the package's own "telemetry must never break a build or dev server" contract (in-repo callers in vendo-cli/init.ts and vendo-server compensate with their own try/catch). The unguarded path that actually reaches users: `vendo telemetry status|enable|disable` (packages/vendo-cli/src/telemetry-cmd.ts:11 calls loadConfig with no guard) crashes with a raw EACCES/ENOENT stack trace — the very command a user runs to disable telemetry in a locked-down environment.

### [vendo-telemetry] vendoVersion is hardcoded to "0.0.0" at both call sites, making the version property permanently meaningless
- file: `packages/vendo-server/src/telemetry-dev.ts:14` · kind: api-inconsistency · verified by: codex

devTelemetry passes version: "0.0.0" (and vendo-cli/src/init.ts:39 does the same) instead of reading the package's real version. Failure scenario: after release, every telemetry event forever reports vendoVersion "0.0.0", so the reliability-by-version analysis TELEMETRY.md advertises (and the base-prop exists for) can never work, and there is no way to correlate error_class spikes with a release. Needs to read the published package version at both seams before the first real version ships.

### [vendo-telemetry] Publish hygiene: no license/repository metadata, and the notice points to a TELEMETRY.md that npm users cannot reach
- file: `packages/vendo-telemetry/package.json:1` · kind: publish-hygiene · verified by: codex

@vendoai/telemetry has no license, repository, or description field (and no LICENSE file exists anywhere in the repo — this affects all 12 publishable packages, so publishing ships proprietary-by-default code as "OSS"). Additionally the first-run notice (src/notice.ts) and `vendo telemetry status` tell users "Details and opt-out: TELEMETRY.md", but files:["dist"] excludes it from the tarball and no URL is given — an npm-installed user has no way to find the disclosure document the consent notice depends on. Ship the file in the package or print a full URL.

### [vendo-telemetry] Allowlist filters property keys only — values are serialized unvalidated, so an allowed key can carry arbitrary data
- file: `packages/vendo-telemetry/src/client.ts:30` · kind: security · verified by: codex

filterToAllowlist drops unknown keys but sends whatever value sits under an allowed key; track() is typed Record<string, unknown>. Failure scenario: any JS caller or future internal call site passes an object under an allowed key (e.g. framework: { name, cwd, apiKey }) and the whole object is serialized to PostHog, breaking TELEMETRY.md's "never collects file paths / keys / error messages" guarantee. Current in-repo callers pass safe primitives, so this is defense-in-depth rather than an active leak — but the guarantee is public and enforcement is one unaudited call site away; value-shape validation (primitives only, length caps) closes it cheaply.

### [vendo-telemetry] telemetry-dev tests write to the real ~/.vendo of whoever runs pnpm test
- file: `packages/vendo-server/src/telemetry-dev.test.ts:7` · kind: dx · verified by: codex

Both tests call devTelemetry({ home: undefined, ... }), which resolves to the real homedir(): running `pnpm test` creates/overwrites ~/.vendo/telemetry.json on contributor and CI machines and silently sets noticeShown=true (log is noop), so a contributor's first-run notice is consumed by the test suite. Also makes the suite fail on read-only-HOME CI runners. Tests should pass a temp home like the telemetry package's own tests do.
