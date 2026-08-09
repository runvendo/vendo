# `createVendo` — the 33 → 8 migration table

**2026-08-01, wave 2 lane F.** Companion to the embedded-agent architecture
design §10 (the target surface) and the build contract §4/§5 (seats and
packs); both design docs live in the private repo archive.

The design promised a "29→6 migration table — every current `createVendoConfig`
key gets a stated destination; no key vanishes silently". The interface actually
carries **33** keys, and the target shape is **8** named slots. This is that
table, complete.

It is **gated, not aspirational**: `packages/vendo/tests/handler-options.docs.test.ts`
diffs the key column below against `CREATE_VENDO_CONFIG_KEYS`
(`packages/vendo/src/config-keys.ts`), which is in turn asserted equal to
`keyof CreateVendoConfig` in both directions at typecheck. A key added to the
config and not to this table fails a test.

## The target surface (§10)

```ts
createVendo({
  auth:    fromSession(getUser),
  tools:   hostTools,                                  // vendo init / sync
  harness: claudeCode(),                               // default: vendo()
  packs:   [apps(), automations(), complianceReports], // default: apps()
  models:  { default: anthropic("claude-fable-5"), reviewer: openai("gpt-5.6") },
  store:   postgres(env.DATABASE_URL),
  files:   myFilesAdapter,                             // optional; your own FilesAdapter
  sandbox: e2b({ warmPool: 2 }),                       // optional
});
```

Day one is **one key**: `vendo init` writes `.vendo/`, `createVendo({ auth })`
reads it. Everything else defaults or degrades honestly.

## Reading the destination column

- **slot** — one of the eight above. Already top-level; stays exactly as it is.
- **pack option** — belongs to a pack's options (`apps()`), because it configures
  a capability rather than the platform.
- **harness option** — belongs to the thinker's options (`vendo({…})`), because
  it configures how something thinks.
- **adapter family** — an adapter seam §10's example does not picture but the
  design does not kill (§11's Cloud line and the hard BYO rule both depend on
  these staying reachable). Top-level is their home.
- **venue plumbing** — how a composition is *mounted* rather than what it is:
  which directory, which `fetch`, which in-memory bytes. Not a capability; not a
  slot.
- **deprecated** — still works for one more minor, warns once naming the move
  (`warnDeprecatedConfigKeys`).

**Wave 2 moved exactly one thing** (`tools:`, the one genuinely new slot) and
deprecated exactly three spellings. Keys whose destination is a pack or harness
option keep their top-level spelling as the accepted one **for now** — moving
them would break every shipped host to buy nothing today, and additive-first is
the law. The destination column is the commitment; the "wave 2" column is the
truth about the code as it stands.

## The table

| Key | Destination | Wave 2 |
| --- | --- | --- |
| `model` | **deprecated** → `models.default` | shim in `resolveModels`; warns once |
| `paint` | **deprecated** → `models.fill` (`disabled` → "compose no separate fast tier") | shim in `resolveModels`; warns once |
| `models` | **slot** `models` | unchanged; five seats (`default`/`reviewer`/`judge`/`fill`/`verifier`), `agent`→`default`, `paint`→`fill`, `knowledgeVerifier`→`verifier` |
| `auth` | **slot** `auth` | unchanged |
| `principal` | **adapter family** (`auth`'s per-seam escape hatch) | unchanged. `auth` is the preset over the `principal`/`actAs`/`oauth` trio, and mixing them is already a boot error; the trio is what a host with an unusual identity story reaches for |
| `tools` | **slot** `tools` — NEW | added. In-memory `ExtractedTool[]`, the same declarations `.vendo/tools.json` carries. Precedence: `tools:` → `profile.tools` (deprecated) → the `profileDir`/cwd file. Since the pack removal the same key also takes executable `ToolDefinition` entries |
| `skills` | **slot** `skills` | added by the pack removal: SKILL.md values mounted at `/host/skills`, where a pack's `skills` slot used to land |
| `catalog` | **pack option** (`apps()`'s `components`, build contract §5) | unchanged. Host components are the apps pack's input, but they also feed `<VendoRoot>` on the client, so the top-level key is what a host writes once and passes both ways |
| `theme` | **adapter family** (deployment identity) | unchanged. Not generation-only — the chrome, the client and the prompt summary all read it |
| `instructions` | **adapter family** (deployment identity) | RENAMED from `brief`, and merged with `agent.instructions` — one prose key. Still the programmatic override for `.vendo/brief.md`, still the prompt's Product section |
| `store` | **slot** `store` | unchanged |
| `files` | **slot** `files` | unchanged, and BYO-only since `s3()` was deleted: pass your own `FilesAdapter` (`{ put, get, delete }`, from `@vendoai/core`). Unset is a documented default, not a gap: blobs live in the store to `FILES_STORE_MAX_BYTES` and the first over-cap write names this key |
| `sandbox` | **slot** `sandbox` | unchanged |
| `harness` | **slot** `harness` | unchanged. Unset now means a composed `vendo()` that actually SERVES the chat route (wave-2 flip), not a door nobody reaches |
| `knowledge` | **adapter family** (`KnowledgeAdapter`) | unchanged. A candidate for a `knowledge()` pack once packs carry adapters; today a pack cannot contribute one |
| `connectors` | **adapter family** (tool sources) | widened to `readonly (string \| Connector)[]`: a string names a Cloud toolkit, an object is a provider, mixed freely. `connectorApps` folded into it and is gone |
| `connections` | **adapter family** (`ConnectionsService`) | unchanged |
| `actAs` | **adapter family** (`auth`'s per-seam escape hatch) | unchanged; see `principal` |
| `serverActions` | **venue plumbing** (the generated wiring file's registration map) | unchanged. Emitted by codegen, not hand-written |
| `guard` | **slot** `guard` | NEW spelling of the guard seam: `guard({ policy, judge, approvals })` or a built `VendoGuard`. `policy`, `judge` and `approvals` folded into it and are gone. The JUDGE MODEL is still `models.judge`; `guard({ judge })` is the judge implementation |
| `secrets` | **adapter family** (`SecretsProvider`) | unchanged |
| `telemetry` | **venue plumbing** | unchanged; a boolean switch on build/dev telemetry |
| `development` | **venue plumbing** (dev-only source capture) | unchanged |
| `profileDir` | **venue plumbing** (which project root `.vendo/` is read under) | unchanged. The `tools:` slot is the in-memory alternative for one piece; this stays the answer for the rest |
| `fetch` | **venue plumbing** (the fetch host tool bindings execute through) | unchanged; the console's hosted try venue injects a synthetic-fixture fetch here (`createSyntheticFetch` from `@vendoai/vendo/try`). There is no `vendo try` CLI command |
| `profile` | **venue plumbing** (the `.vendo/` pieces as in-memory compose inputs) | `profile.tools` **deprecated** → the `tools:` slot; the other pieces (`overrides`, `theme`, `brief`, `catalog`, `policy`, `designRules`) unchanged |
| `mcp` | **adapter family** (the MCP door) | unchanged |
| `oauth` | **adapter family** (`auth`'s per-seam escape hatch) | unchanged; see `principal` |
| `agent` | **slot** `agent` (the composed-agent seam) | narrowed to `ComposedAgent` — the whole agent `agent()` builds. The knobs bag is gone: `instructions` became the top-level key, `toolOutputCap`/`maxInitialTools`/`loadout` became top-level composition keys, and `maxSteps`/`historyWindow`/`maxOutputTokens` became `vendo()` deps (they configure the thinker, and `vendo()` already declares all three) |
| `sessions` | **venue plumbing** (ephemeral session lifecycle) | unchanged |
| `toolOutputCap` | **venue plumbing** (how much of a tool result reaches the model) | moved up from `agent.toolOutputCap`. Composition's, not the thinker's: the same number bounds the agent loop, the harness bridge, and the connector-discovery registry's own search results |
| `maxInitialTools` | **venue plumbing** (the discovery rail's initial-loadout cap) | moved up from `agent.maxInitialTools`. The rail is built here and handed to BOTH thinkers, so the knob stays on the composition |
| `loadout` | **venue plumbing** (the discovery rail's curated loadout) | moved up from `agent.loadout`; same rail, same reason |
| `apps` | **pack option** → `apps({ … })` | unchanged. `designRules`, `fillConcurrency`, `checks`, `pipeline` are generation options; `experimentalMachines` / `experimentalServedApps` are project-level opt-ins. Deliberately NOT given a second spelling in wave 2: `apps: {…}` works, no host asked for `apps({…})`, and two spellings for one thing is the cost, not the feature |
| `automations` | **subsystem switch** | added by the pack removal: `false` unmounts automations (routes, `emit`, and its judgment rule). `packs` is gone with the same change — capability arrives on `tools`, `skills`, `apps.checks` and `catalog` |

## Deleted keys

Wave 2 deleted none. The config-coherence change (2026-08-05) deletes five
top-level keys and one options object, each folded into a key that already had
to exist — no capability is lost, and every one has a stated replacement:

- **brief** → `instructions` (one prose key; `.vendo/brief.md` still backs it)
- **policy** → `guard({ policy })`
- **judge** → `guard({ judge })`
- **approvals** → `guard({ approvals })`
- **connectorApps** → a toolkit string inside `connectors`
- **agent.instructions** → `instructions`
- **agent.toolOutputCap** → `toolOutputCap`
- **agent.maxInitialTools** → `maxInitialTools`
- **agent.loadout** → `loadout`
- **agent.maxSteps / historyWindow / maxOutputTokens** → `harness: vendo({ … })`

`createVendo` refuses to compose against any of them, naming the replacement
(`rejectRemovedConfigKeys`), so a JavaScript host cannot lose its policy
silently.

## What a host has to change

Three warnings appear for hosts on the deprecated spellings:

```
[vendo] `model` is deprecated: use `models: { default }`. …
[vendo] `paint` is deprecated: use `models: { fill }`. …
[vendo] `profile.tools` is deprecated: use the `tools:` slot. …
```

Each names its destination, because a warning that does not say where to go is a
warning a host cannot act on. The deleted keys above throw instead of warning:
they no longer work at all, and a silent drop would change a security posture.
