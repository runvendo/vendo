# @vendoai/agents

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
