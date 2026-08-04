# `createVendo` — the 33 → 8 migration table

**2026-08-01, wave 2 lane F.** Companion to
`2026-07-30-embedded-agent-architecture-design.md` §10 (the target surface) and
`2026-07-30-build-contract.md` §4/§5 (seats and packs).

The design promised a "29→6 migration table — every current `createVendoConfig`
key gets a stated destination; no key vanishes silently". The interface actually
carries **33** keys, and the target shape is **8** named slots. This is that
table, complete.

It is **gated, not aspirational**: `packages/vendo/src/handler-options.docs.test.ts`
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
  files:   s3(bucket),                                 // optional
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
| `tools` | **slot** `tools` — NEW | added. In-memory `ExtractedTool[]`, the same declarations `.vendo/tools.json` carries. Precedence: `tools:` → `profile.tools` (deprecated) → the `profileDir`/cwd file |
| `catalog` | **pack option** (`apps()`'s `components`, build contract §5) | unchanged. Host components are the apps pack's input, but they also feed `<VendoRoot>` on the client, so the top-level key is what a host writes once and passes both ways |
| `theme` | **adapter family** (deployment identity) | unchanged. Not generation-only — the chrome, the client and the prompt summary all read it |
| `brief` | **adapter family** (deployment identity) | unchanged; the prose `.vendo/brief.md` carries, programmatically |
| `store` | **slot** `store` | unchanged |
| `files` | **slot** `files` | unchanged. Unset is a documented default, not a gap: blobs live in the store to `FILES_STORE_MAX_BYTES` and the first over-cap write names this key |
| `sandbox` | **slot** `sandbox` | unchanged |
| `harness` | **slot** `harness` | unchanged. Unset now means a composed `vendo()` that actually SERVES the chat route (wave-2 flip), not a door nobody reaches |
| `knowledge` | **adapter family** (`KnowledgeAdapter`) | unchanged. A candidate for a `knowledge()` pack once packs carry adapters; today a pack cannot contribute one |
| `connectors` | **adapter family** (tool sources) | unchanged |
| `connectorApps` | **adapter family** (scopes the auto-composed Cloud connector) | unchanged. A modifier of `connectors`, ignored when `connectors`/`connections` is explicit |
| `connections` | **adapter family** (`ConnectionsService`) | unchanged |
| `actAs` | **adapter family** (`auth`'s per-seam escape hatch) | unchanged; see `principal` |
| `serverActions` | **venue plumbing** (the generated wiring file's registration map) | unchanged. Emitted by codegen, not hand-written |
| `policy` | **adapter family** (the guard) | unchanged. The guard is ours, not a pack's, and §14 keeps policy a platform concern |
| `judge` | **adapter family** (the guard's judgment channel) | unchanged. Note: the JUDGE MODEL is `models.judge`; this key is the judge implementation |
| `secrets` | **adapter family** (`SecretsProvider`) | unchanged |
| `telemetry` | **venue plumbing** | unchanged; a boolean switch on build/dev telemetry |
| `development` | **venue plumbing** (dev-only source capture) | unchanged |
| `profileDir` | **venue plumbing** (which project root `.vendo/` is read under) | unchanged. The `tools:` slot is the in-memory alternative for one piece; this stays the answer for the rest |
| `fetch` | **venue plumbing** (the fetch host tool bindings execute through) | unchanged; `npx vendo try` injects a synthetic-fixture fetch here |
| `profile` | **venue plumbing** (the `.vendo/` pieces as in-memory compose inputs) | `profile.tools` **deprecated** → the `tools:` slot; the other pieces (`overrides`, `theme`, `brief`, `catalog`, `policy`, `designRules`) unchanged |
| `mcp` | **adapter family** (the MCP door) | unchanged |
| `oauth` | **adapter family** (`auth`'s per-seam escape hatch) | unchanged; see `principal` |
| `agent` | **harness option** → `vendo({ … })` | unchanged, and NOT movable in wave 2: `instructions`, `toolOutputCap`, `maxOutputTokens`, `historyWindow`, `maxInitialTools`, `loadout`, `maxSearchExpansions`, `maxSteps` are chat-loop knobs, and `vendo()` today declares only `model` and `maxSteps`. Widening its options is a `packages/harnesses/src/vendo.ts` change this lane does not own — see the lane report |
| `sessions` | **venue plumbing** (ephemeral session lifecycle) | unchanged |
| `approvals` | **adapter family** (the guard's approval lifecycle) | unchanged |
| `apps` | **pack option** → `apps({ … })` | unchanged. `designRules`, `fillConcurrency`, `checks`, `pipeline` are generation options; `experimentalMachines` / `experimentalServedApps` are project-level opt-ins. Deliberately NOT given a second spelling in wave 2: `apps: {…}` works, no host asked for `apps({…})`, and two spellings for one thing is the cost, not the feature |
| `packs` | **slot** `packs` | unchanged; unset means `[apps()]` |
| `tours` | **venue plumbing** (tour mode's scripted-turn seam) | unchanged. Plain OSS config, arrived on main after this table was written (#713): an ordered list of `{ prompt, respond }` entries replayed in front of the live agent. It composes the agent's `scripted` hook and nothing else, so it has no slot to move into |

## Deleted keys

**None.** Every one of the 33 has a live consumer, and the contract permits
deletion only with zero consumers stated. Nothing qualified.

## What a host has to change

Nothing, this minor. Three warnings appear for hosts on the old spellings:

```
[vendo] `model` is deprecated: use `models: { default }`. …
[vendo] `paint` is deprecated: use `models: { fill }`. …
[vendo] `profile.tools` is deprecated: use the `tools:` slot. …
```

Each names its destination, because a warning that does not say where to go is a
warning a host cannot act on.
