---
"@vendoai/vendo": major
"@vendoai/guard": major
"@vendoai/agents": minor
---

**BREAKING:** `createVendo`'s config says one thing once. `guard()` is a value,
prose has one name, connectors are one list, and the `agent:` grab-bag is gone.

Four incoherences, one shape each. The guard was constructed invisibly from
three flat keys while `agent()` next door took a guard INSTANCE. `brief` and
`agent.instructions` were the same prose under two names. `connectorApps` was a
modifier of `connectors` that was silently ignored whenever `connectors` was
set. And `agent:` was a bag holding a whole agent OR seven unrelated knobs, half
of which configured a thinker that never saw them.

| Removed | Replacement |
| --- | --- |
| `policy` | `guard: guard({ policy })` |
| `judge` | `guard: guard({ judge })` |
| `approvals` | `guard: guard({ approvals })` |
| `brief` | `instructions` |
| `agent.instructions` | `instructions` |
| `connectorApps: ["gmail"]` | `connectors: ["gmail"]` |
| `agent.toolOutputCap` | `toolOutputCap` |
| `agent.maxInitialTools` | `maxInitialTools` |
| `agent.loadout` | `loadout` |
| `agent.maxSteps` | `harness: vendo({ maxSteps })` |
| `agent.historyWindow` | `harness: vendo({ historyWindow })` |
| `agent.maxOutputTokens` | `harness: vendo({ maxOutputTokens })` |

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
