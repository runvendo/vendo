# @vendoai/agents

## 0.36.2

### Patch Changes

- Updated dependencies [66cf10a]
- Updated dependencies [91595d2]
  - @vendoai/harnesses@0.36.2
  - @vendoai/apps@0.36.2
  - @vendoai/actions@0.36.2
  - @vendoai/mcp@0.36.2
  - @vendoai/store@0.36.2
  - @vendoai/core@0.36.2
  - @vendoai/guard@0.36.2
  - @vendoai/automations@0.36.2

## 0.36.1

### Patch Changes

- Updated dependencies [a9fca38]
  - @vendoai/apps@0.36.1
  - @vendoai/actions@0.36.1
  - @vendoai/harnesses@0.36.1
  - @vendoai/mcp@0.36.1
  - @vendoai/store@0.36.1
  - @vendoai/core@0.36.1
  - @vendoai/guard@0.36.1
  - @vendoai/automations@0.36.1

## 0.36.0

### Patch Changes

- 0108715: A remix follows the page it was forked from. The `<Remixable>` wrapper now
  couriers its wrapped instance's live serializable props to the server — on mount
  and again on every change — and the ported screen is painted on them.

  Until now it was painted on the baseline's `sampleProps`, captured the day
  `vendo sync` ran. Maple's remixed net-worth card read `$54,907.15` — the
  hardcoded declared example in the host's own registry — while the host's card two
  inches away read `$142,929.30`, with a visibly different chart series. A port
  renders FROM its props and a query resolves before the render, so nothing in the
  screen's source could ever have carried them; the capture was the only value the
  floor had.

  `AppSeed.props` records them, `POST /apps/:id/props` (`apps.seed.props`,
  `client.apps.courierProps`) is the door, and the checks floor's props resolver
  prefers them over the capture — which remains the fallback for a remix whose
  wrapper has not couriered yet. Writing props is provenance about the call site,
  not a content edit: it mints no version and replays no wish, so it is safe on
  every render the props really change on.

  The boundary is the captured baseline's own declared prop names, applied at the
  door, so a prop the host component never declared is dropped before it is stored.
  JSON-serializable values only, as before.

  Also removes the client-side splice this replaces. It searched the payload for a
  node named `seedComponentName(slot)` with `source: "generated"`; a remix is a
  ported SCREEN whose tree is whatever rendering produced — nodes marked
  `source: "ported"` — and that name only ever names a seat in
  `document.components`. The find never matched and the merge never ran, which is
  why the numbers were stale in the first place.

- Updated dependencies [f325443]
- Updated dependencies [b2b3cac]
- Updated dependencies [0108715]
- Updated dependencies [0b6bb92]
- Updated dependencies [2c662ac]
  - @vendoai/apps@0.36.0
  - @vendoai/store@0.36.0
  - @vendoai/core@0.36.0
  - @vendoai/harnesses@0.36.0
  - @vendoai/actions@0.36.0
  - @vendoai/mcp@0.36.0
  - @vendoai/automations@0.36.0
  - @vendoai/guard@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [ea60d95]
- Updated dependencies [8d97a32]
- Updated dependencies [ea60d95]
- Updated dependencies [d533ab8]
  - @vendoai/apps@0.35.0
  - @vendoai/store@0.35.0
  - @vendoai/actions@0.35.0
  - @vendoai/harnesses@0.35.0
  - @vendoai/mcp@0.35.0
  - @vendoai/core@0.35.0
  - @vendoai/guard@0.35.0
  - @vendoai/automations@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [f7e0ff4]
- Updated dependencies [f7e0ff4]
- Updated dependencies [3f7740a]
- Updated dependencies [f7e0ff4]
- Updated dependencies [f7e0ff4]
- Updated dependencies [f7e0ff4]
  - @vendoai/apps@0.34.0
  - @vendoai/core@0.34.0
  - @vendoai/mcp@0.34.0
  - @vendoai/actions@0.34.0
  - @vendoai/store@0.34.0
  - @vendoai/harnesses@0.34.0
  - @vendoai/automations@0.34.0
  - @vendoai/guard@0.34.0

## 0.33.0

### Minor Changes

- 8c7b476: Vendo runs on both AI SDK majors. The peer range widens from `ai >=6 <7` to
  `ai >=6 <8`, and the three things that made an `ai@7` host fail are gone: the
  turn loop and the generation engine send their cacheable system block as
  `system` instead of as a system-role message inside `messages` (ai@7 refuses the
  latter with `AI_InvalidPromptError`, and both majors carry the same message form
  — cache breakpoint and all — to the provider unchanged), and the spec-version
  gates on provider failover and the screen agent's per-role seat now admit the
  v4 spec that ai@7-era providers report instead of only v3.

  `vendo doctor` follows: `ai@6` and `ai@7` both pass, a pre-v6 install still
  fails on the peer floor, and E-DEP-001's ceiling moves to majors above the
  supported pair. `vendo init` stops telling an `ai@7` host to downgrade, and the
  "install your provider" line no longer names an `ai` major at all — `ai` is
  already resolved by the time anyone can read it.

  A new `ai-dual` CI lane pins the whole workspace to the ai@7 pairing and runs
  the suites against it, so a peer range that claims two majors is checked rather
  than asserted. This is the compat half of #478, whose short-term half was the
  fail-fast this replaces.

### Patch Changes

- Updated dependencies [8c7b476]
- Updated dependencies [9d3f0af]
  - @vendoai/apps@0.33.0
  - @vendoai/core@0.33.0
  - @vendoai/guard@0.33.0
  - @vendoai/harnesses@0.33.0
  - @vendoai/actions@0.33.0
  - @vendoai/mcp@0.33.0
  - @vendoai/store@0.33.0
  - @vendoai/automations@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [88cf572]
  - @vendoai/apps@0.32.0
  - @vendoai/actions@0.32.0
  - @vendoai/harnesses@0.32.0
  - @vendoai/mcp@0.32.0
  - @vendoai/store@0.32.0
  - @vendoai/core@0.32.0
  - @vendoai/guard@0.32.0
  - @vendoai/automations@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [de24421]
- Updated dependencies [457dfe3]
  - @vendoai/automations@0.31.0
  - @vendoai/core@0.31.0
  - @vendoai/store@0.31.0
  - @vendoai/actions@0.31.0
  - @vendoai/guard@0.31.0
  - @vendoai/apps@0.31.0
  - @vendoai/harnesses@0.31.0
  - @vendoai/mcp@0.31.0

## 0.30.1

### Patch Changes

- Updated dependencies [6bbc8e6]
  - @vendoai/apps@0.30.1
  - @vendoai/actions@0.30.1
  - @vendoai/harnesses@0.30.1
  - @vendoai/mcp@0.30.1
  - @vendoai/store@0.30.1
  - @vendoai/core@0.30.1
  - @vendoai/guard@0.30.1
  - @vendoai/automations@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [b3d92b2]
- Updated dependencies [bd1d016]
- Updated dependencies [56c81b5]
  - @vendoai/apps@0.30.0
  - @vendoai/core@0.30.0
  - @vendoai/actions@0.30.0
  - @vendoai/harnesses@0.30.0
  - @vendoai/mcp@0.30.0
  - @vendoai/store@0.30.0
  - @vendoai/guard@0.30.0

## 0.29.1

### Patch Changes

- @vendoai/core@0.29.1
- @vendoai/store@0.29.1
- @vendoai/actions@0.29.1
- @vendoai/guard@0.29.1
- @vendoai/apps@0.29.1
- @vendoai/harnesses@0.29.1
- @vendoai/mcp@0.29.1

## 0.29.0

### Patch Changes

- Updated dependencies [6bc5cc8]
- Updated dependencies [ebf101a]
- Updated dependencies [ebf101a]
- Updated dependencies [6bc5cc8]
- Updated dependencies [0484a15]
- Updated dependencies [df0b4cb]
- Updated dependencies [7e78031]
- Updated dependencies [ebf101a]
- Updated dependencies [6bc5cc8]
- Updated dependencies [f06b033]
- Updated dependencies [1dce317]
- Updated dependencies [ebf101a]
  - @vendoai/core@0.29.0
  - @vendoai/harnesses@0.29.0
  - @vendoai/actions@0.29.0
  - @vendoai/apps@0.29.0
  - @vendoai/guard@0.29.0
  - @vendoai/store@0.29.0
  - @vendoai/mcp@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [b9392b9]
- Updated dependencies [650e5eb]
- Updated dependencies [0143c4e]
- Updated dependencies [c2805b4]
- Updated dependencies [62c8630]
- Updated dependencies [0143c4e]
  - @vendoai/actions@0.28.0
  - @vendoai/core@0.28.0
  - @vendoai/store@0.28.0
  - @vendoai/apps@0.28.0
  - @vendoai/guard@0.28.0
  - @vendoai/harnesses@0.28.0
  - @vendoai/mcp@0.28.0

## 0.27.1

### Patch Changes

- ebe9ffc: Two ways a host with a full `.vendo/tools.json` still got an agent that could do nothing.

  `api()` promised defaults its own JSDoc and the umbrella already documented — the working directory for `dir`, `VENDO_BASE_URL` for `baseUrl` — and forwarded neither. A backend writing `agent({ tools: [api()] })`, exactly the shape the docs show, handed `createActions` no directory at all, so no `.vendo` file was ever read and the agent booted with zero host tools. Both defaults now apply where the promise was made, in `api()`; `createActions` still defaults nothing, because the doctor probes pass `dir: undefined` on purpose to strip the file reads. The errors a baseUrl-less route or tRPC call throws named `createActions({ baseUrl })`, an internal a backend holding `api()` never calls; they name `VENDO_BASE_URL`, or passing `baseUrl`, now.

  `vendo sync` run through `npx` extracted nothing and blamed the routes for it. Two of the three TypeScript loaders resolved the compiler only from vendo's own install, and under `npx` that directory cannot see the project's `typescript` — so module parsing returned null, every route came back "no supported exported HTTP verb", and the warning pointed at the route files instead of the missing compiler. All three loaders share one ladder now: the project being synced first, this install second. The report's compiler warning covers "no compiler resolved at all" alongside the too-old case it already named.

- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1
  - @vendoai/apps@0.27.1
  - @vendoai/guard@0.27.1
  - @vendoai/harnesses@0.27.1
  - @vendoai/mcp@0.27.1
  - @vendoai/store@0.27.1
  - @vendoai/actions@0.27.1

## 0.27.0

### Minor Changes

- c50597f: Two doors author an automation now: `agent.on(...)` in your own code, and `vendo_automate` when a person asks in chat.

  `support.on(when, task, options?)` is a DECLARATION, never a store write — it validates where you wrote it and `createVendo` reconciles it at boot. All five `When` shapes:

  ```ts
  support.on("0 9 * * 1", "summarize the week and email ops");
  support.on({ every: "1d" }, "refresh credit scores");
  support.on({ at: "2026-09-01T09:00:00Z" }, "send the launch note");
  support.on({ event: "payment.failed" }, "triage and notify the user");
  support.on({ webhook: "stripe" }, "reconcile the payout");
  support.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
  ```

  A bad cron throws at module load, not at 2am, with what, why, a did-you-mean you can paste and the docs link. The code is the consent, so a redeploy reconciles: new → created, edited → a new identity with the old one disarmed, deleted from your source → disarmed (never deleted, so its run history survives). Identity defaults to `hash(when + task + agent)`, so editing the cron or the words MINTS a new automation — pass `id` to keep one across an edit. A `disable()` a person did stamps `disarmedBy: "user"`, and that kill switch survives every redeploy.

  `@vendoai/agents` newly exports `agentAutomations`, `agentAutomationPlan` and `OnOptions`. The plan is built here and applied only by the engine's own internal reconcile: this package may not import `@vendoai/automations`, so there is no second write path to disagree with the first. Agent names ride through verbatim — two agents claiming one name produce two declarations both claiming that runner name, because collapsing them here would hide a collision the runner map has to throw on at startup.

  `vendo_automate` is the chat door — a schedule with nothing to build. It takes `{ task, when?, agent?, timezone? }` and carries **no app argument of any kind**, because a record has no app slot to fill. `vendo_make` still arms the schedule half of a compound ask ("build me the board and refresh it every Monday") and does it by calling the same one create operation, so the two cannot drift into arming differently. The `vendo.json` manifest fold-in is a reconcile through the same core helper: a changed cron replaces its own record under the same identity, a schedule dropped from the manifest disarms its own, an unchanged manifest touches nothing, and two schedules that collapse to one identity are refused out loud rather than last-wins.

  **Breaking, and the reason your app writes may start failing:** every triggers-in-documents path is gone rather than shimmed — `app-validation`, the edit journal, interchange, persistence, the runtime types and the write surface all lost their trigger halves. An app document that still carries `triggers` no longer arms anything. What an app may hold instead is an optional `automations: string[]`, maintained by this layer alone (the compound flow and the manifest fold-in, nowhere else) and resolved on read. Deleting the app does NOT stop its automation: the automation fires, reaches for the tool its task named, and fails loudly with a `not-found` that becomes a terminal error run row.

  One misuse hole closed on the way past. `vendo_automate`'s `when` now requires exactly one of `every` / `at` / `event` / `webhook` (or a bare cron string) and refuses the rest, naming what it got and where the shapes are written down. An object naming none of them used to become `{ kind: "external", connector: undefined }` — an automation nothing could ever trigger, reported to its owner as armed.

### Patch Changes

- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [a781798]
- Updated dependencies [e09d69a]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [49e1e39]
- Updated dependencies [af2d337]
- Updated dependencies [a507b92]
- Updated dependencies [c50597f]
- Updated dependencies [a6ec9ba]
- Updated dependencies [c50597f]
- Updated dependencies [bfaa06b]
- Updated dependencies [c50597f]
- Updated dependencies [77a6765]
- Updated dependencies [b10d129]
  - @vendoai/core@0.27.0
  - @vendoai/guard@0.27.0
  - @vendoai/apps@0.27.0
  - @vendoai/store@0.27.0
  - @vendoai/actions@0.27.0
  - @vendoai/harnesses@0.27.0
  - @vendoai/mcp@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0
  - @vendoai/harnesses@0.26.0
  - @vendoai/apps@0.26.0
  - @vendoai/actions@0.26.0
  - @vendoai/guard@0.26.0
  - @vendoai/mcp@0.26.0
  - @vendoai/store@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
  - @vendoai/guard@0.25.0
  - @vendoai/harnesses@0.25.0
  - @vendoai/store@0.25.0
  - @vendoai/core@0.25.0
  - @vendoai/actions@0.25.0
  - @vendoai/apps@0.25.0
  - @vendoai/mcp@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [42b2b78]
  - @vendoai/apps@0.24.0
  - @vendoai/actions@0.24.0
  - @vendoai/harnesses@0.24.0
  - @vendoai/mcp@0.24.0
  - @vendoai/store@0.24.0
  - @vendoai/core@0.24.0
  - @vendoai/guard@0.24.0

## 0.23.0

### Minor Changes

- ef66908: A hand-authored tool may declare its result shape, and an MCP server's is no
  longer dropped on the way in.

  `ToolDescriptor.outputSchema` has been read on three prompt surfaces for a while
  — the apps shape brief, the automation planner, the screen agent's tool brief —
  and every one of them prints "result shape unknown — pass the whole output
  through; do not bind to guessed field names" when it is absent. Two producers
  never supplied it, so for their tools that sentence was always the answer:
  `tool()`, where the host knows the shape exactly and had nowhere to say it, and
  the inbound MCP connector, which parsed a server's `tools/list` entry and threw
  the advertised `outputSchema` away. A generated screen over either could not bind
  to a field until something had called the tool once and read the rows back.

  - **`tool({ …, outputSchema })`** (`@vendoai/agents`) takes the shape as JSON
    Schema and puts it on the descriptor. Omitted, the key is absent rather than
    `undefined`, so the unknown-shape sentence still prints.
  - **`mcpConnector`** (`@vendoai/actions`) keeps whatever the server advertised,
    by the same rule its `inputSchema` already follows: an object survives,
    anything else is not a schema and is ignored.

  Advisory in both cases. Nothing validates a result against the declared shape —
  a schema that has drifted from the code makes the model's expectations wrong,
  which is recoverable, where a checked one would fail a tool that works.

### Patch Changes

- Updated dependencies [ef66908]
  - @vendoai/actions@0.23.0
  - @vendoai/core@0.23.0
  - @vendoai/store@0.23.0
  - @vendoai/guard@0.23.0
  - @vendoai/apps@0.23.0
  - @vendoai/harnesses@0.23.0
  - @vendoai/mcp@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [90c0de8]
  - @vendoai/guard@0.22.0
  - @vendoai/harnesses@0.22.0
  - @vendoai/core@0.22.0
  - @vendoai/store@0.22.0
  - @vendoai/actions@0.22.0
  - @vendoai/apps@0.22.0
  - @vendoai/mcp@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [46aee4a]
- Updated dependencies [83aec51]
- Updated dependencies [01e225c]
- Updated dependencies [d9b7c8d]
- Updated dependencies [5932631]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
- Updated dependencies [730ac8f]
  - @vendoai/apps@0.21.0
  - @vendoai/core@0.21.0
  - @vendoai/actions@0.21.0
  - @vendoai/harnesses@0.21.0
  - @vendoai/mcp@0.21.0
  - @vendoai/store@0.21.0
  - @vendoai/guard@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/store@0.20.0
  - @vendoai/actions@0.20.0
  - @vendoai/apps@0.20.0
  - @vendoai/guard@0.20.0
  - @vendoai/harnesses@0.20.0
  - @vendoai/mcp@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [cb2d68e]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/store@0.19.0
  - @vendoai/actions@0.19.0
  - @vendoai/apps@0.19.0
  - @vendoai/guard@0.19.0
  - @vendoai/harnesses@0.19.0
  - @vendoai/mcp@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [88ec7e6]
- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/store@0.18.0
  - @vendoai/harnesses@0.18.0
  - @vendoai/guard@0.18.0
  - @vendoai/actions@0.18.0
  - @vendoai/apps@0.18.0
  - @vendoai/mcp@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [d1de477]
- Updated dependencies [85fc732]
- Updated dependencies [729dd3e]
- Updated dependencies [9ea21ef]
- Updated dependencies [1865bdd]
- Updated dependencies [c79866f]
- Updated dependencies [8ded5cc]
- Updated dependencies [8af9e4c]
  - @vendoai/core@0.17.0
  - @vendoai/apps@0.17.0
  - @vendoai/guard@0.17.0
  - @vendoai/actions@0.17.0
  - @vendoai/harnesses@0.17.0
  - @vendoai/mcp@0.17.0
  - @vendoai/store@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [d529cf8]
- Updated dependencies [795f8c1]
  - @vendoai/apps@0.16.0
  - @vendoai/actions@0.16.0
  - @vendoai/mcp@0.16.0
  - @vendoai/store@0.16.0
  - @vendoai/core@0.16.0
  - @vendoai/guard@0.16.0
  - @vendoai/harnesses@0.16.0

## 0.15.0

### Minor Changes

- b324b79: **Breaking.** Third-party provider keys no longer select adapters. Pass the
  adapter explicitly (`vendo init` now writes it for you) or set `VENDO_API_KEY`.

  Env keys are credentials; config selects. A key lying around in the environment
  used to choose which sandbox a deployment ran on, which provider it billed, and
  which account every app machine's inference went to — decided by nothing anyone
  wrote down. `VENDO_API_KEY` is now the only environment variable that fills an
  adapter slot you left unset. Every ladder reads the same way: explicit config,
  then `VENDO_API_KEY`, then an honest failure that names both ways out.

  - **Sandbox.** `E2B_API_KEY` no longer selects the e2b venue. It is the
    credential an explicit `sandbox: e2bSandbox()` reads when you pass no inline
    `apiKey`, and `e2bSandbox()` now refuses at boot — rather than at the first
    box build — when the optional `e2b` package does not resolve from the project.
    An unset `sandbox` slot composes the Cloud sandbox with `VENDO_API_KEY`, or
    nothing. `selectSandbox` drops its e2b rung and its `e2bSpecifier` parameter;
    the `"e2b"` venue string stays in the `/status` union for older wires, but an
    explicit adapter reports `"custom"` like any other.
  - **Agent model.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
    `GOOGLE_GENERATIVE_AI_API_KEY` select nothing. They are read by the
    `@ai-sdk/*` provider you construct and pass in `models`. With no `models` and
    no `VENDO_API_KEY`, the first turn says exactly that instead of quietly riding
    a key you set for something else.
  - **Box inference.** The `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair wins
    as a pair — both halves or neither — then `VENDO_API_KEY` rides the Cloud
    gateway, then the box gets no inference door. The `ANTHROPIC_API_KEY` rung is
    gone from both `boxInference()` and the Claude Code harness's
    `inferenceEnv()`: a provider key in the deployment's environment used to point
    every box at `api.anthropic.com` and bill that account.
  - **Doctor.** `E-LIVE-007` is retired — with no key-selected venue there is no
    such thing as a venue the operator did not ask for, and the boot refusal is
    earlier and louder than a probe. The code stays in the append-only registry
    and keeps its verify-page anchor. `E-LIVE-004` now names the two ways out.

  `VENDO_DEV_CREDENTIAL` still pins a credential rung, and is now the only way to
  reach an `env-key` rung at all — but it is internal, Vendo's own E2E rung matrix
  and escape hatch, not a host knob, and it can change without notice. Your app's
  model belongs in `models`.

### Patch Changes

- Updated dependencies [9e0ed9a]
- Updated dependencies [b57df06]
- Updated dependencies [b324b79]
- Updated dependencies [545416a]
- Updated dependencies [1529978]
- Updated dependencies [8f00291]
- Updated dependencies [bb15cda]
  - @vendoai/apps@0.15.0
  - @vendoai/core@0.15.0
  - @vendoai/harnesses@0.15.0
  - @vendoai/store@0.15.0
  - @vendoai/mcp@0.15.0
  - @vendoai/actions@0.15.0
  - @vendoai/guard@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/store@0.14.0
  - @vendoai/actions@0.14.0
  - @vendoai/apps@0.14.0
  - @vendoai/guard@0.14.0
  - @vendoai/harnesses@0.14.0
  - @vendoai/mcp@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [9034bcc]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0
  - @vendoai/guard@0.13.0
  - @vendoai/store@0.13.0
  - @vendoai/actions@0.13.0
  - @vendoai/apps@0.13.0
  - @vendoai/harnesses@0.13.0
  - @vendoai/mcp@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [0d67885]
  - @vendoai/apps@0.12.0
  - @vendoai/store@0.12.0
  - @vendoai/actions@0.12.0
  - @vendoai/mcp@0.12.0
  - @vendoai/core@0.12.0
  - @vendoai/guard@0.12.0
  - @vendoai/harnesses@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [5c8043d]
- Updated dependencies [eeebbee]
- Updated dependencies [402e7ad]
- Updated dependencies [a216b68]
- Updated dependencies [aeb1bae]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0
  - @vendoai/store@0.11.0
  - @vendoai/apps@0.11.0
  - @vendoai/actions@0.11.0
  - @vendoai/guard@0.11.0
  - @vendoai/harnesses@0.11.0
  - @vendoai/mcp@0.11.0

## 0.10.0

### Minor Changes

- 0f46e44: Dead features and their public surface are gone. Every removal below had zero
  callers in this repo, the console, or the examples; nothing changed behavior for
  a caller that was using a live path.

  **`@vendoai/core` (breaking).** `AppDocument.placements` is gone from the
  interface and the schema, and the validator no longer checks it. There has been
  no writer since the placements-as-rows split; "show this app in that slot" is a
  placement ROW (`@vendoai/apps` `placements.ts`, `GET /apps/placements`), which
  is unchanged and is the live feature. Also removed: `PlanIsland` and the
  `AppPlan.island` field, because the plan-level `<Island name purpose/>`
  declaration no longer parses; and `PackSkill`, the deprecated alias for `Skill`.
  `Pin`, `pinSchema` and `AppDocument.pins` are untouched — fork provenance is
  still live.

  **`@vendoai/apps` (breaking).** `PinShipRequest`, `PinApproval`,
  `pinShipRequestSchema` and `pinApprovalSchema` never ran; `ShipDiffPin` and
  `inClientApprovalSchema` are the live path and stay. `bindingKindCheck` is gone
  — it had no callers; the `bindingKindIssues` walker it wrapped is still used by
  the validate path. The plan compiler no longer accepts a plan-level
  `<Island name purpose/>` element (an inline `<Island>` inside an app file is a
  different, live feature and is unchanged). `GenerationPromptSection["id"]`
  narrows to `"theme" | "design-rules"`; the other five ids had no producer.

  **`@vendoai/store` (breaking).** The `stateStore` and `approvalStore` helpers
  are gone. Both were test-only wrappers over the routed `records("vendo_state")`
  and approval write paths, which are unchanged and are what production uses.
  `ApprovalRow` is unaffected — it is exported from `helpers/types.ts` as before.

  **`@vendoai/agents` (breaking).** The `./harnesses` subpath export is gone.
  Import the harness factories from their own package instead:
  `import { claudeCode } from "@vendoai/harnesses/claude-code"` and
  `import { vendo } from "@vendoai/harnesses"`.

  **`@vendoai/knowledge`.** `knowledgeIndexSummary` and `parseKnowledgeConfig` are
  no longer exported from the package root. Both functions stay and are still used
  internally by `knowledgeIndexResolver`, which remains exported.

  **`@vendoai/actions`.** `DEFAULT_CAPTURE_BUDGET_BYTES` is no longer exported.
  The constant and the 256 KB default it sets are unchanged.

  **`@vendoai/ui`.** The unexported, unreferenced `TakeoverPortal` component is
  deleted.

- 0e46cd5: `agent({ system })` — the host's last word on the per-turn system prompt. It is called once per turn with the ctx and this package's own assembly (`{ assembled, directions }`); return a string and it is the prompt VERBATIM, return `undefined` and the default assembly stands. One hook covers both venues — `ctx.venue` says whether this is a chat turn or an away firing — so a deployment cannot drift into two agents wearing one name, and `undefined` meaning "the default" is what stops a conditional that falls through from silently stripping the base rules. `awayRunner({ system })` now takes the same two-argument shape and, where a hook returning `undefined` previously meant NO system prompt reached the runtime, it now means the default assembly: an away run is never promptless. Existing one-argument implementations are unchanged and still assignable. `assemblePrompt` and `PromptInput` are exported so a host replacing the prompt can rebuild the parts it wants to keep.

  Also removed: `PromptInput.sourceNotes`, which had no callers and rendered a section nothing produced.

### Patch Changes

- Updated dependencies [e2128aa]
- Updated dependencies [e1032f9]
- Updated dependencies [079d7d8]
- Updated dependencies [0e51585]
- Updated dependencies [e87a765]
- Updated dependencies [8105ade]
- Updated dependencies [361f9b9]
- Updated dependencies [b0a165c]
- Updated dependencies [1549f90]
- Updated dependencies [591ea46]
- Updated dependencies [e87a765]
- Updated dependencies [79d7088]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [0f46e44]
- Updated dependencies [70644e3]
- Updated dependencies [d9ae728]
- Updated dependencies [61b75bd]
- Updated dependencies [384eb09]
- Updated dependencies [ed44a58]
  - @vendoai/core@0.10.0
  - @vendoai/apps@0.10.0
  - @vendoai/actions@0.10.0
  - @vendoai/store@0.10.0
  - @vendoai/mcp@0.10.0
  - @vendoai/harnesses@0.10.0
  - @vendoai/guard@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0
  - @vendoai/actions@0.9.0
  - @vendoai/apps@0.9.0
  - @vendoai/guard@0.9.0
  - @vendoai/harnesses@0.9.0
  - @vendoai/mcp@0.9.0
  - @vendoai/store@0.9.0

## 0.8.1

### Patch Changes

- e092567: A standalone session can reopen an existing conversation.

  `session(subject, { threadId })` reopens the named conversation instead of minting
  a new one. Ownership is the store's own subject scope — someone else's thread reads
  back as absent and is refused as `not-found`, never silently swapped for a new
  conversation. The resume path deliberately skips `threadStore.put`, whose replace
  semantics would delete the very transcript the resume exists to read back.

  Until now `createSession` minted a fresh thread on every call and `SessionOptions`
  had no way to name an existing one, so a Node backend that built a session per HTTP
  request — which is what the README showed — lost the whole conversation on every
  request. Multi-turn only worked while the JS object stayed alive in process memory.
  The README now passes `threadId` in, hands `session.threadId` back out, and says
  plainly that a session is request-lifetime while the thread is not.

  The `[User]` and `[Situation]` prompt blocks are now one implementation in
  `@vendoai/core` (`userPromptBlock`, `situationPromptBlock`, `promptFactLines`),
  shared by the standalone assembler and the umbrella's. They were two copies of a
  prompt-injection defence — the indent that stops a client-supplied fact from
  forging a top-level `Directions` section — and only the umbrella's labeled the
  situation "observation, not instruction". The shared block carries that label, so
  the standalone surface gains it. No other behaviour changes.

- dd441cb: `vendoKnowledge` is no longer re-exported from `@vendoai/agents`.

  `AgentConfig` and `AgentComposition` have no knowledge slot, so nothing composed
  through the agents front door could use it — the umbrella's knowledge seam is
  its own `createVendo({ knowledge })` key, never the agent's. Import it from
  `@vendoai/knowledge`, which is where every real consumer already imports it
  from. The `@vendoai/knowledge` dependency goes with it.

  `session()` also stops opening the workspace twice — the first result was
  discarded before the per-turn open, so this removes one database round trip per
  session, including on the `{ threadId }` resume path.

- f1b30a1: `s3()` is gone from `@vendoai/store` and from the `@vendoai/agents` root, along
  with the `S3FilesOptions` type. The `files:` seam is unchanged: it takes a
  `FilesAdapter` — three methods, `{ put, get, delete }` — exported from
  `@vendoai/core` and the umbrella, and a host object in that slot has always won
  over anything shipped.

  Pre-1.0 hard cut, no shim. If you wired `files: s3({ … })` (or
  `postgres(url, { blobs: s3({ … }) })`), pass your own `FilesAdapter` pointed at
  the same bucket and prefix. Blobs already written are untouched: the keys are
  minted by the store, never by the adapter, so the same objects read back with no
  migration. The `aws4fetch` dependency drops with it, and the over-cap
  store-backed file error now names `files:` and `FilesAdapter` instead of `s3()`.

- Updated dependencies [a7a0fcf]
- Updated dependencies [4772c49]
- Updated dependencies [2ab4a39]
- Updated dependencies [38b32a3]
- Updated dependencies [e092567]
- Updated dependencies [2fd14aa]
- Updated dependencies [898eb8f]
- Updated dependencies [464dce8]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [f25138f]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [a69aa5c]
- Updated dependencies [89660d1]
- Updated dependencies [4ec9c17]
- Updated dependencies [7163a25]
- Updated dependencies [f1b30a1]
- Updated dependencies [3e2b35e]
- Updated dependencies [1022b2f]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [ca3a9dc]
- Updated dependencies [12a344c]
- Updated dependencies [b99147f]
- Updated dependencies [d4a2d4c]
- Updated dependencies [5e8a141]
- Updated dependencies [0f6455a]
- Updated dependencies [dd441cb]
- Updated dependencies [8f3d23a]
- Updated dependencies [5e584c8]
- Updated dependencies [be9f3e9]
- Updated dependencies [2b49b64]
- Updated dependencies [2b49b64]
- Updated dependencies [6fb568a]
- Updated dependencies [a621123]
- Updated dependencies [2357b22]
  - @vendoai/mcp@0.8.1
  - @vendoai/core@0.8.1
  - @vendoai/actions@0.8.1
  - @vendoai/guard@0.8.1
  - @vendoai/apps@0.8.1
  - @vendoai/store@0.8.1
  - @vendoai/harnesses@0.8.1

## 0.8.0

### Minor Changes

- 10a2b44: `agent()` mounts the tool door its harness has always required.

  `claudeCode()` declares `requires: { toolDoor: true }` on both legs — a box and
  a local subprocess each reach the host's tools over remote MCP — and
  `@vendoai/agents` never filled the slot. A boxed agent therefore booted with the
  model's own hands (Bash, Read, Write) and NONE of the host's tools: no `api()`,
  no `tool({ … })`, no `mcp:` servers. It was silent, because the harness's warning
  is itself gated on a door existing.

  `agent()` gains one optional key, **`door: { baseUrl }`** — the publicly
  reachable origin the thinker dials back to. Unset it falls back to
  `VENDO_BASE_URL`; an explicit value always wins. A `machine: "local"` thinker
  that resolves neither gets a loopback listener this package serves itself — a
  subprocess can always dial 127.0.0.1, so zero-config development loses
  nothing. A SANDBOXED harness that resolves neither is a BOOT error naming both
  ways out, never a turn that dies in front of a user: loopback is not reachable
  from a box.

  A library cannot add a route to the host's server, so the door's fetch handler
  comes back out: mount `agent.door` at the exported `DOOR_PATH`
  (`/api/vendo/mcp`, the same mount `createVendo` uses). It is
  `createMcpDoor({ internal: true })` — no authorization server, no discovery, no
  consent page, and no listing for anyone but a live turn. The door's hostname
  joins the box's egress allowlist, and the runtime's `liveTurn` seam is wired, so
  a credential the harness mints resolves to the turn that minted it and to
  nothing between turns.

  `@vendoai/agents` now depends on `@vendoai/mcp`, which widens a standalone
  install with `@modelcontextprotocol/sdk` and `jose`.

  `createTurnCredentials` — the turn-credential registry — moves from
  `@vendoai/vendo` down into `@vendoai/mcp`, beside the `LiveTurn` /
  `TurnCredentialPort` types it speaks, so the umbrella and the standalone runtime
  share ONE implementation instead of each growing their own. No behaviour change
  for `createVendo`.

- 21c8b10: One brain, one scheduler, and consent that is per trigger — everywhere outside
  `@vendoai/automations` that has to agree with it.

  A fire-time call now carries WHICH trigger fired (`TriggerRef.id`) and WHICH
  firing it belongs to (`TriggerRef.lineageId`), so the guard matches an away grant
  on (app, trigger) instead of app-wide — arming one trigger no longer authorizes
  its siblings — and keys effect receipts on the firing, so re-running a run that
  failed loudly cannot repeat the work the first attempt already completed. The
  store carries that dimension too: grant and run rows index the trigger, so an
  adapter that trusts its own refs narrows exactly as far as the engine does
  instead of handing back a sibling trigger's grant. An agentic firing runs through
  the same away runner the rest of Vendo uses, seeing only the connector dispatcher
  it was actually granted. A machine app's `vendo.json` schedules are folded into
  its document triggers when the manifest syncs, so there is exactly one scheduler
  in the deployment (the automations engine) and one tick that drives it. The panel
  and the wire follow: per-trigger enable, disable, dry-run and adopt doors, a
  `POST /runs/:runId/rerun` door, and a run that stopped for a missing permission
  showing "Failed" with the consent card and Grant & re-run right on the row.

- 05ac24c: **BREAKING:** `createVendo`'s config says one thing once. `guard()` is a value,
  prose has one name, connectors are one list, and the `agent:` grab-bag is gone.

  Four incoherences, one shape each. The guard was constructed invisibly from
  three flat keys while `agent()` next door took a guard INSTANCE. `brief` and
  `agent.instructions` were the same prose under two names. `connectorApps` was a
  modifier of `connectors` that was silently ignored whenever `connectors` was
  set. And `agent:` was a bag holding a whole agent OR seven unrelated knobs, half
  of which configured a thinker that never saw them.

  | Removed                    | Replacement                           |
  | -------------------------- | ------------------------------------- |
  | `policy`                   | `guard: guard({ policy })`            |
  | `judge`                    | `guard: guard({ judge })`             |
  | `approvals`                | `guard: guard({ approvals })`         |
  | `brief`                    | `instructions`                        |
  | `agent.instructions`       | `instructions`                        |
  | `connectorApps: ["gmail"]` | `connectors: ["gmail"]`               |
  | `agent.toolOutputCap`      | `toolOutputCap`                       |
  | `agent.maxInitialTools`    | `maxInitialTools`                     |
  | `agent.loadout`            | `loadout`                             |
  | `agent.maxSteps`           | `harness: vendo({ maxSteps })`        |
  | `agent.historyWindow`      | `harness: vendo({ historyWindow })`   |
  | `agent.maxOutputTokens`    | `harness: vendo({ maxOutputTokens })` |

  - **`guard` is one slot with two arms.** `guard({ policy, judge, approvals })`
    from `@vendoai/guard` (re-exported by `@vendoai/vendo/server`) declares the
    host's RULES and lets composition finish them with the plumbing only a venue
    has — the store, the app/service risk resolver, the org-policy layer, the
    cloud policy fallback. A built `VendoGuard` is taken verbatim instead
    (adapter rule). `agent({ guard })` in `@vendoai/agents` accepts the same
    union. `createGuard` is still the one constructor both arms end at; the
    guard's runtime behaviour is untouched, and its own suites pass unmodified.
    `CreateGuardConfig` now also takes `approvals.parkedCallTtlMs` and the guard
    exposes the resolved value at `guard.approvals.parkedCallTtlMs`, so a host
    that brings its own instance keeps the knob instead of losing it.
  - **One prose story.** `instructions` is what this product is, who uses it, and
    the house voice, placed in the assembled prompt's Product section every turn
    — the programmatic override for `.vendo/brief.md`, which `vendo init` still
    writes and still feeds this key. THE ONE BEHAVIOUR DIFFERENCE: prose that
    used to arrive through `agent.instructions` was appended as the LAST section
    of the system prompt, after the guard's directions and the component catalog;
    it now rides the Product section near the top, where `brief` always did.
    Every deployment whose prose came from `brief`/`.vendo/brief.md` — which is
    every deployment `vendo init` scaffolded — gets a byte-identical prompt.
  - **Connectors are one list.** `connectors?: readonly (string | Connector)[]`.
    A string names a Vendo Cloud toolkit and scopes the composed
    cloudTools/cloudConnections pair to exactly that set; an object is an
    explicit provider, used verbatim; mix freely. Strings with no `VENDO_API_KEY`
    mount nothing and the connect surface refuses by naming both fixes — the old
    key's silent-ignore trap cannot survive, because there is no longer a second
    list to ignore.
  - **The knobs split by owner.** What the deployment curates is composition's
    and sits at the top level (`toolOutputCap`, `maxInitialTools`, `loadout` —
    the bridge and the discovery rail are built here and handed to BOTH
    thinkers). What the thinker decides rides the thinker (`maxSteps`,
    `historyWindow`, `maxOutputTokens` — already `vendo()` deps).
    `agent?: ComposedAgent` now means exactly one thing: the agent `agent()`
    built, adopted whole. `instructions` joins `harness`/`store`/`files`/`sandbox`
    as a slot the adopted agent owns, so filling it twice is a boot error.

  `createVendo` REFUSES to compose against a removed key, naming its replacement.
  TypeScript already rejects every one of them; the boot error is for the
  JavaScript host, where a dropped `policy` would mean an unconfigured guard
  running wide open.

- 10a2b44: `createVendo({ agent })` accepts a whole `@vendoai/agents` agent, and the sandbox
  ladder has one implementation.

  `createVendo`'s `agent` key is now a union: either the chat-context knobs it has
  always taken (now exported as `AgentOptions`) or the value `agent()` from
  `@vendoai/agents` returned. Handed an agent, the deployment adopts what that
  agent already composed — its harness, its store and blob adapter, its
  egress-skinned sandbox, and its `instructions` — so the embed's turns run on the
  same brain, the same transcript and the same box as `session.stream`. Passing any
  of `harness`, `store`, `files` or `sandbox` alongside an agent is a boot error
  naming each conflict, instead of one side silently losing.

  The guard and the host tool surface stay the deployment's: the embed's choke
  point carries org policy and app-tool risk grading, and its tools come from
  `.vendo/tools.json`. The agent's own guard and tools keep serving its `session()`
  calls.

  `VENDO_API_KEY` now fills an `agent()` sandbox slot the host left unset with the
  managed Cloud pool — importing `@vendoai/vendo` registers the Cloud rung the
  standalone runtime leaves open. An explicitly passed adapter still wins. The
  Cloud STORE rung stays open pending the tenant-store design, so an unset `store:`
  with only a Vendo key still refuses and names `store: postgres(url)`.

  `@vendoai/apps` gains the `./sandbox-ladder` subpath: `selectSandbox(configured,
cloudRung)` is now the ONE implementation of the adapter rule's sandbox ladder
  (explicit → `E2B_API_KEY` → the Cloud rung → nothing), shared by the umbrella and
  the standalone agent runtime. `SandboxVenue` moves there with it.

- a0dbfc6: The agent can now be told who the user is and what they are looking at.

  Two seams, both optional, both merged into one `[Situation]` block on every
  message the user sends:

  - **User facts.** The `user` resolver on the `authJs()` and `jwt()` auth presets
    may now return a `facts` object alongside the principal, and those facts reach
    the prompt. The session is decoded once per request for both the principal and
    the facts. An anonymous request resolves no facts.
  - **Live screen context.** `useVendoContext(data)` publishes structured host data
    for as long as the component is mounted, and retires it on unmount. Several
    mounted callers coexist and merge. `VendoProvider` also takes `captureScreen`
    (default `true`) to control the screen snapshot that rides the same channel.

  **BREAKING (`@vendoai/ui`, `@vendoai/vendo/react`): `useVendoContext` is now
  `useVendoProvider`.** The name `useVendoContext` previously belonged to the
  zero-argument hook that read everything `VendoProvider` supplies; it now belongs
  to the host-facing hook above, which takes data and returns nothing. Both names
  still exist, so the compiler is the thing that catches this:

  ```diff
  - const { client } = useVendoContext();
  + const { client } = useVendoProvider();
  ```

  Because both names still exist, the compiler catches this rather than the
  runtime: an existing zero-argument call now fails with `TS2554: Expected 1
arguments, but got 0`. Rename the call and you are done — nothing else about the
  provider value changed.

### Patch Changes

- 10a2b44: An approval now reaches ONLY the conversation that parked it.

  Every `agent().session()` subscribed to the shared guard's
  `onApprovalRequested` unscoped, so a guarded action parked in one
  conversation surfaced in every other session's `on("approval")` handler —
  another user's pending action, preview included, with live approve/deny
  closures. The subscription was also never released, so a dead session's
  callback outlived it on the guard.

  The guard has always recorded the parking conversation
  (`ApprovalRecordData.sessionId`, from `RunContext.sessionId`); that identity
  now rides the emitted request too (`ApprovalRequest.ctx.sessionId`, optional
  only for rows persisted before it existed). Sessions deliver a request to
  their handlers only when it names their own thread — an ownerless request
  matches none, failing closed — and the guard subscription is taken on the
  first `on()` handler and released with the last. Deciding an approval was
  and remains owner-scoped: a foreign principal's decide is `not-found`.

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [b022eb3]
- Updated dependencies [10a2b44]
- Updated dependencies [1572060]
- Updated dependencies [a004031]
- Updated dependencies [21c8b10]
- Updated dependencies [3f98372]
- Updated dependencies [cfacf95]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [05ac24c]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [10a2b44]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [d6f5e28]
- Updated dependencies [56e0cc3]
- Updated dependencies [a004031]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [215bfcc]
- Updated dependencies [dcc08ab]
- Updated dependencies [fbf265b]
- Updated dependencies [f7c6da2]
- Updated dependencies [ce98c54]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [ab5d181]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [2819bcc]
- Updated dependencies [38dd824]
- Updated dependencies [798b618]
- Updated dependencies [8132329]
- Updated dependencies [10a2b44]
- Updated dependencies [d1ff923]
- Updated dependencies [98eba22]
- Updated dependencies [10a2b44]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [6a3d9e3]
- Updated dependencies [b576ab9]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
- Updated dependencies [39a7ecc]
  - @vendoai/core@0.8.0
  - @vendoai/apps@0.8.0
  - @vendoai/mcp@0.8.0
  - @vendoai/guard@0.8.0
  - @vendoai/harnesses@0.8.0
  - @vendoai/actions@0.8.0
  - @vendoai/store@0.8.0
  - @vendoai/knowledge@0.8.0
