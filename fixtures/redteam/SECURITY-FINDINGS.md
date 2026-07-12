# SECURITY-FINDINGS — v0 red-team wave

Adversarial testing of Vendo's deliberately-unusual security model: **apps never hold authority;
the guard asks the running user in context at call time; grants are per-user + app-bound; artifacts
carry zero authority (import mints a fresh AppId); secrets are handles substituted at the egress
boundary; the app backend always runs in the sandbox.** Both independent clean-room designs chose
declared manifest permissions instead — ours is the novel bet, so it was attacked hard.

Every attack below is now a permanent regression test (130 new tests across block-local suites and a
`fixtures/redteam` mini-umbrella that composes the real store + guard + actions + apps + automations
against a live fixture host app, plus a real-e2b live leg). **Two real fixes landed in
`@vendoai/guard`; everything else was already fail-closed and is now pinned.** No remotely-exploitable
P0 was found.

Root gates green: `build` 10/10, `typecheck` 19/19, `lint` (dependency-guard passes), `test` 21/21
tasks. The wave's own e2e is green, including the live e2b egress leg and a live prompt-injection leg
run against a real model.

## Fixes landed (in the owning block, each with a revert-to-fail regression)

### P1 — away-park bypass via forged `decidedBy` from the policy code hatch  (guard)
`normalizeCodeDecision` preserved whatever `decidedBy` a `PolicyConfig.code` function returned,
including `"grant"`. The away-downgrade gate exempts exactly `decidedBy === "grant"`, so a code hatch
returning `{action:"run", decidedBy:"grant"}` executed an **away** call with no real app-bound
automation grant behind it — subverting the model's central invariant ("away runs hold only
automation grants bound to the running app; everything else parks"). The trust boundary is the
operator-authored policy module (not a remote attacker), so this is ranked P1, not a
remotely-exploitable P0 — but it is the one place the away invariant could be subverted in code, so
it is fixed.
**Fix:** `normalizeCodeDecision` now forces the policy-code stage's provenance to `decidedBy:"rule"`
for all outcomes (mirroring the already-correct handling of code *errors*) and drops any
code-supplied `grantId`. A code-sourced run is now treated like a rule-sourced run: away-downgraded
to a park, and honestly attributed in audit. No frozen contract shape changes; this enforces the
contract's away invariant, which is the higher law.
Regression: `packages/guard/test/security/away-code-hatch.test.ts` (verified: reverting the fix lets
the forged grant-run execute the away call).

### P2 — empty `constrained` grant = silent tool-wide wildcard  (guard)
`scopeMatches` for a `constrained` scope is `constraints.every(...)`, so an **empty** constraints
array matches any args — a tool-wide grant wearing a "constrained" label, while approval previews and
audit imply it is bounded. Reachable only by the approving principal's own client, but a
scope-confusion footgun. **Fix:** empty `constraints` is now rejected at grant-mint
(`VendoError("validation")`) and fails closed in `scopeMatches` (defense-in-depth for any grant that
predates the fix).
Regression: `packages/guard/test/security/empty-constrained.test.ts` (verified: reverting the fix
lets the empty-constrained grant authorize any args).

## Key architectural finding (fail-safe; flagged to apps/composition owners)

### Secret-handle substitution is unwired in the OSS e2b/modal datapath
The contract (06 §4.3) describes an egress proxy that swaps a `vendo-secret:<name>:<nonce>` handle
for the real value toward allowlisted domains. In the OSS implementation, `machine.ts` injects the
handle as the env value, egress is enforced by the **provider-native** network allowlist (E2B
`allowOut` + deny-all; Modal `outboundDomainAllowlist`), and the pure `substituteSecretHandles`
helper is **not invoked anywhere** in the machine/e2b/modal path — `SecretsProvider.get()` is not
even called at machine boot (proven in `packages/apps/src/security/wired-in.test.ts`).

Security consequence: the real secret value is **never present inside the sandbox at all**, so exfil
is impossible *by construction* — strictly stronger than the contract's allowlist-gated
substitution. This was confirmed on **real e2b**: the in-machine `process.env` holds only the handle,
non-allowlisted egress (direct, raw-IP, and a genuine `302`-redirect-to-non-allowlisted hop served
from loopback) is blocked by the network layer, and what the app could transmit is the handle
verbatim, never a value. Functional consequence: handle→value resolution toward allowlisted domains
does not happen in OSS; it is effectively a Cloud-adapter capability. **This is a functionality gap
for the apps/composition owners to reconcile** (wire `substituteSecretHandles` into an egress proxy,
or document handles as Cloud-only) — not a security defect.

## Attacks proven to fail closed (now regression tests)

- **Shared/imported app, dormant privileged calls** — a critical tool always asks with the real
  inputs even with no policy configured; under a realistic ask-on-destructive policy, dormant writes
  park; under bare default posture a dormant write auto-runs but is fully audited with the real
  `inputPreview` and `status()` reports `"unconfigured"`. The model's teeth are the critical tier + a
  configured policy, not the bare default — the tests assert this explicitly rather than pretending
  default posture blocks.
- **Artifact-borne authority** — `importApp` mints a fresh `AppId` before validation and strips
  `id`/`server`/`forkedFrom`; empty data; the AppDocument format has no grants/permissions field;
  imported triggers land disarmed (`enabled:false`). Forged ids, injected server/egress/secrets/pins,
  and `forkedFrom` lineage (including tampered `.vendoapp` bytes) transfer no authority. Grants never
  move: they key on `(subject, tool)` + the *original* app's id, so a fresh-id copy never rides the
  original's grants.
- **Away-run authority** — chat/batch grants (`source:"chat"|"batch"`) never authorize away runs
  (`presenceMatches` requires `source:"automation"` + `appId` match); a revoked grant parks the next
  run; an approved critical away call executes exactly once (single-use approval, not replayable);
  descriptor drift lapses the grant (`descriptorHash` mismatch → park).
- **Prompt injection** — a fully-compromised judge (returns `run` for everything) still cannot unlock
  the critical tier, the away downgrade, or the deterministic breakers. Live leg: a real agent
  steered by a poisoned data/tool-output payload toward a destructive critical call — even while
  holding a standing app-bound automation grant for it — still parked instead of sending.
- **Run-token abuse** — HMAC-SHA256 (WebCrypto) over the payload with a 256-bit per-process CSPRNG
  secret; forged/cross-secret/expired/tampered tokens all reject; the proxy derives RunContext
  entirely from the signed token (appId/subject/presence cannot be flipped by the request body);
  `owns()` re-check; cross-app reuse impossible; privilege escalation via the tool proxy fails.
- **Egress/secret exfil (unit + live e2b)** — allowlist matching is exact / `*.`-suffix only
  (`evil-allowed.com` ≠ `allowed.com`, apex ≠ wildcard, userinfo `@evil.com` resolves to evil and is
  denied); handles in query strings / binary bodies / toward non-allowlisted hosts are never
  substituted. Live on real e2b: non-allowlisted egress, raw-IP, and redirect-to-non-allowlisted hops
  are all blocked by the provider network layer.
- **Webhook** — constant-time HMAC verify, dual body-size cap (Content-Length 413 + streamed 1 MiB
  cutoff), ±5-minute timestamp window enforced pre-dispatch, delivery-id dedupe (no replay
  double-fire), principal resolved only after verification; forged/missing signatures and skewed
  timestamps reject with no run and no principal resolution.
- **descriptorHash / JCS / crypto / store** — `descriptorHash` covers exactly
  `{name,description,inputSchema,risk,critical?}`, RFC-8785 canonical, deterministic, ignores junk
  fields; `vendo_secrets` is AES-256-GCM (fresh per-call IV, auth-tag integrity) in a physically
  separate table; all SQL parameterized; `app:<id>:<name>` namespacing can't be escaped
  (server-minted CSPRNG appId); emit/tick are cross-principal isolated with no backfill.

## Delegated boundaries (outside this wave's blocks — flagged to composition/wave-5)

- **`AppsRuntime.history(appId)` takes no `RunContext`** — ownership scoping is delegated to the
  umbrella wire route `/apps/:id/history`. Cross-user read/undo risk *iff* that route ever fails to
  resolve + verify the principal. The umbrella isn't in this repo yet (wave-5); the signature is
  frozen, so this must be enforced at the wire route.
- **Egress cross-hop enforcement** (redirect-follow / DNS-rebinding) lives in the provider network
  adapter, not in `@vendoai/apps`; the live e2b suite probes it end-to-end and it holds.
- **Tree `data`/`props` size** is not bounded by `validateTree` (component-source caps only); the DoS
  bound is delegated to an upstream request-body limit. By-contract; recorded for visibility.
- **Reserved-collection writes trust their caller** (`store.records("vendo_grants").put`); isolation
  depends on app/sandbox code never receiving a `StoreAdapter` (structural — app code reaches the
  host only through the guard-bound tool proxy). Characterization-tested.

## Test inventory

| Suite | Location | Count |
| --- | --- | --- |
| guard fixes + regressions | `packages/guard/test/security/` | 18 (+ 2 source fixes) |
| core (descriptorHash/JCS/tree-DoS/id) | `packages/core/src/security/` | 33 |
| store (AES-GCM/isolation/injection) | `packages/store/src/security/` | 18 |
| apps (run-token/proxy/egress/interchange/app-data) | `packages/apps/src/security/` | 29 |
| actions (no self-auth) | `packages/actions/src/security/` | 5 |
| automations (webhook/emit/tick) | `packages/automations/src/security/` | 12 |
| cross-block e2e (dormant/artifact/away/injection) | `fixtures/redteam/src/` | 15 |
| live e2b egress/exfil | `fixtures/redteam/src/live-egress.e2e.test.ts` | (in the 15) |

A note on harness completeness: the deterministic prompt-injection leg composes the guard directly
(real store/actions/`guard.bind`) rather than through `createStack`, because `StackOptions` exposes
no `judge`/`breakers` seam. Adding `judge?`/`breakers?` passthroughs to `StackOptions` would let those
attacks be expressed through the standard harness entry — a small, additive follow-up.
