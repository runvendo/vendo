# @vendoai/vendo

## 0.7.0

### Minor Changes

- 47c53e9: `vendo init` only ever creates files in your source tree.

  **The last two rewrites are gone.** Init used to regenerate
  `app/api/vendo/[...vendo]/vendo-actions.ts` whenever the detected `"use server"`
  surface moved, and to wire `serverActions` into an existing
  `app/api/vendo/[...vendo]/route.ts`. It still creates both — once, on the run
  where they do not exist yet — but a file you already have is never written
  again. When init finds a change it will not make, it prints it in the same
  framed block as the layout mount (naming the file and the exact lines),
  carries it in `--agent` as an `edits[]` array of `{file, lines, why}` alongside
  `mount`, and lists it in `manualSteps` and the agent tail.

  **The map is yours from creation on.** An existing registration map is compared
  only by the keys it registers, never byte-for-byte, so your formatting, your
  comments, your aliases and your own extra entries all survive — and a reworded
  comment in a Vendo release can never nag every existing install. A missing
  action prints just the entries to add, with aliases that continue your file's
  own `actionN` numbering. A route that passes a `serverActions` map it composes
  itself is left alone entirely, and no generated map is created beside it.

  **`vendo doctor` catches what you skip.** New `E-WIRE-009`: the host has live
  `"use server"` actions, but the registration map is missing entries or the route
  never passes `serverActions` **inside** its `createVendo({ … })` call. Nothing
  else went red for that before — the tools simply failed closed at execution
  time. Init and doctor resolve the wiring, the required action set and the map's
  completeness through the same shared helpers, so they cannot disagree; both
  honor `.vendo/overrides.json` and judgments, because a disabled tool is one the
  runtime never dispatches.

  `package.json` hooks are unchanged: that is Vendo-owned config, not your source.

- c0f43b1: `vendo init` never edits your source, and `vendo sync` owns the whole scan.

  **Init stops rewriting `app/layout.tsx`.** The auto-wire that wrapped
  `{children}` in `<VendoRoot>` is gone. Every file init writes is new and
  Vendo-owned (plus its own `package.json` hooks); mounting the visible surface
  is your paste, and the run ends with one framed block naming the exact file and
  lines. It also rides `--agent` as a `mount` object and the head of
  `manualSteps`, and `vendo doctor`'s `E-WIRE-004` now prints the same paste
  instead of describing it.

  **One AI rule, one flag pair, on both commands.** `--ai` forces the judgment
  pass on and `--no-ai` forces it off, on `init` and `sync` alike. With neither
  flag, an interactive run **asks every time** — no consent is persisted anywhere
  — and a non-interactive run skips, so CI stays deterministic and never spends.
  `--yes` and `--json` count as non-interactive; `--json` still emits exactly one
  object and never prompts. `--ai-polish` and `--no-watermark` keep working. The
  hooks init installs now carry the flag explicitly (`predev: vendo sync --no-ai`,
  `prebuild: vendo sync --strict --no-ai`), and re-running init upgrades the
  hookless entries an older init wrote without touching a `vendo sync` call you
  wrote yourself.

  **Sync re-extracts your theme.** `.vendo/theme.json` was init-only, so a
  rebrand never reached the agent. Sync now re-runs the deterministic scan and
  reconciles it, using a sibling merge base, `.vendo/theme.extracted.json` (what
  the scan produced last time — commit it alongside `theme.json`). A slot is
  machine-owned only with recorded proof, so anything you hand-edited — or that
  predates the base — is left alone and reported with both values; derived slots
  like `accentText` follow their source rather than the app's. `--theme-refresh`
  takes your app's values anyway.

  **Pin baselines reach Vendo Cloud.** With a key set, a normal sync (no
  `--report` needed) reconciles `.vendo/remixable/` with the `vendo_pin_baselines`
  collection the console's Remix reviews screen reads — pushing new and changed
  slots, deleting slots pruned locally. The captured component **source** crosses
  the wire, which is what makes a fork's diff reviewable. Keyless and BYO make no
  request at all, and a Cloud failure is a warning, never a failed build.

- 3cfde47: Seven self-serve fixes across the CLI: the install path stops lying, and the JS
  scaffolds run.

  **Plain-JavaScript hosts boot again.** The generated `vendo/server.mjs` carried
  two pieces of TypeScript — `kind: "user" as const` in the principal line and a
  `as Headers & { … }` cast around `getSetCookie` — so every Express, bare-Node
  and `--framework custom` host on a JS codebase died with `SyntaxError:
Unexpected identifier 'as'` on its first `node server.js`. Both expressions now
  follow the host's language, and Node's own parser gates them in CI.

  **`vendo doctor` names a stale install.** npm release-cooldown configs
  (`min-release-age`) silently resolve an old `@vendoai/vendo`, and nothing ever
  said so. Doctor now checks npm's `latest` and prints `warning: installed
@vendoai/vendo X is behind latest Y` with the upgrade command. Fail-soft: an
  offline, blocked or slow registry says nothing at all and never changes the
  exit code.

  **Two silent CI failures are loud.** `vendo mcp server-json` with missing flags
  used to fall into a readline prompt even on a piped stdin — a script or agent
  hung forever; it now exits 1 naming `--domain` and `--url`. `vendo sync
--report` without a Cloud key used to complain and exit 0, so a reporting lane
  stayed green while never reporting; it now exits 1.

  **`vendo try` is unlisted.** The command still runs for anyone invoking it, but
  help no longer advertises it (nor do the retired `playground`/`refine`
  notices): the pre-install `npx vendo try` pitch it fronted resolves no npm
  package.

  **Init's ending puts the paste last.** The run's final line is the outstanding
  paste, on interactive and non-interactive runs alike, instead of the star ask
  or the agent tail; the "start your dev server — the agent is live in your app"
  line is withheld while a paste is still pending (it contradicted the frame
  right above it); and the keyless Cloud pitch is three lines, since `vendo
login` narrates its own ceremony.

  **Quieter dev-server logs.** The hosted-store automations notice is latched per
  process — a Next dev server recomposes on nearly every request, and the
  paragraph was landing in the host's log dozens of times per session.

- 89b2455: Add tour mode: deterministic scripted responses in front of the live agent.

  Every company that adopts Vendo has to demo it — to its own executives, to a
  prospect, to a new user on day one — and a live agent is the wrong thing to put
  in front of an audience. It is slow, it is different every time, and the one
  run that matters is the run where it improvises. So every host builds the same
  cache by hand, badly. This is that cache, supported.

  `createVendo({ tours })` takes an ordered list of `{ prompt, respond }`
  entries. `respond` is prose, a recorded app document, or a sequence of both,
  replayed at a live turn's cadence. Everything a tour does not own — every
  improvised question, every follow-up about what is on screen — reaches the real
  agent untouched.

  Two rules keep a tour from swallowing the demo it carries. An entry fires only
  on a close variant of its own frozen prompt: matching is a normalized
  similarity score over token sets and edit distance, not keyword presence, so a
  typo still lands the entry while a different ask about the same subject does
  not. And an entry fires at most once per thread, reconstructed from the
  thread's own transcript rather than stored, so it survives the live turns in
  between. Both rules exist because keyword matching cannot tell "ask for this"
  from "change the thing you just made" — it replayed the recording on top of the
  app the audience had just watched arrive, pin and all.

  An app part is a real app: the recorded document is imported as an owned copy,
  so it opens, pins, survives a reload, and can be edited by the next turn, which
  is the live agent's. Pacing is measured against real turns and drawn from a
  stream seeded by the entry's own prompt — uneven like a live provider, and the
  same unevenness on every rehearsal. Nothing in a tour calls `Math.random`.

  Plain OSS config with no Cloud dependency and no key-conditional branch: a tour
  behaves identically with and without `VENDO_API_KEY`. A host that configures no
  tours composes no seam at all.

  `@vendoai/agent` gains the scripted-turn seam this rides on: an optional
  `scripted` hook consulted after the thread resolves and before any model work.
  It lives there because everything a scripted turn must share with a live one
  lives there — the resolved thread, the persistence, the response contract — and
  a seam in the wire route could only approximate all three. The umbrella owns
  what a play is, because matching and replay need the apps runtime.

### Patch Changes

- e56ed30: Cloud-audit small fixes: five places where the runtime and what it claims had
  drifted apart.

  **The hosted session sweep now rides the authenticated tick.** Both existing
  cadences are unreachable on a serverless host — the unref'd interval timer
  never fires, and the amortized on-request sweep is gated by a per-process
  `lastSweepAt` that a per-request process re-seeds every invocation. A
  deployment on the hosted store leaked idle anonymous sessions forever.
  `POST /api/vendo/tick` now runs the same sweep the other two cadences call
  (hosted stores only; a local composition already has both). Two cadences
  firing at once is safe — the claim leg is a single-winner election
  server-side.

  **`E2B_API_KEY` without the `e2b` package is now a loud misconfig.**
  `createVendo` used to silently demote a half-configured BYO sandbox to Cloud,
  or to the dark venue with no key at all, so the operator found out at the
  first server-app build. It now throws with the exact fix. An explicitly
  passed `sandbox:` adapter still wins before any env check.

  **`fn:` steps deferred to Cloud now warn.** Enabling an automation whose
  schedule or external trigger fires on Cloud, with `fn:` steps in it, warns
  once naming the app: `fn:` runs in the app's own sandbox machine, which the
  Cloud runner may not be able to wake or reach in v1. The docs claimed this
  warning existed and described `fn:` as a callback into the host process —
  both wrong, both fixed.

  **Two honesty fixes to operator copy.** `vendo doctor` no longer offers a
  "managed MCP broker" no code path wires from a key; it names the adapter slots
  a key actually defaults. And the hosted-session-doors warning no longer blames
  a vendo-web commit for a surface the console restored on 2026-07-20 — it
  reports what the client observed (a bare 404) instead.

- ed1940a: The theme extractor now resolves `next/font` CSS variables on hosts without a
  resolvable `typescript`. The standard Next.js pattern — `--font-sans:
var(--font-inter)` in CSS, `Inter({ variable: "--font-inter" })` in the root
  layout — is read through a real TypeScript program, and `typescript` is an
  optional resolution: a JS-only Next app, a strict pnpm tree, or an npx-run CLI
  simply doesn't have one. When it was missing, every next/font derivation went
  dark at once and `vendo init` fell all the way through to "No host evidence for
  fontFamily — neutral defaults used" on an app whose font was sitting right
  there in its layout.

  Without a compiler the extractor now text-scans the layout's next/font and
  geist loader calls for the family each CSS variable names. The scan reports
  those fonts as un-applied, because text cannot prove a font reaches the markup:
  every derivation that needs that proof still fails closed to the model pass,
  and only var() resolution — where the host's own CSS is the authority on what
  the body font is — gains an answer. `next/font/local` stays unresolvable by
  design; its loader declares a variable but no family name.

- Updated dependencies [e56ed30]
- Updated dependencies [dd73974]
- Updated dependencies [ea3cb0b]
- Updated dependencies [37ec12a]
- Updated dependencies [923cf59]
- Updated dependencies [89b2455]
- Updated dependencies [bcf8699]
- Updated dependencies [8f5a7c0]
  - @vendoai/automations@0.7.0
  - @vendoai/ui@0.7.0
  - @vendoai/telemetry@0.3.3
  - @vendoai/agent@0.7.0
  - @vendoai/core@0.7.0
  - @vendoai/actions@0.7.0
  - @vendoai/apps@0.7.0
  - @vendoai/guard@0.7.0
  - @vendoai/knowledge@0.7.0
  - @vendoai/mcp@0.7.0
  - @vendoai/store@0.7.0

## 0.6.1

### Patch Changes

- 35e7431: The plain-http anonymous-session cookie is now `Path=/`, matching the secure
  `__Host-` form (#693). The cold-load race fix has hosts mint the pointer on
  their document response, mint-unless-present — but a `Path=/api/vendo` cookie
  never rides a document/page request, so on plain-http localhost such a host
  re-minted on every page load and status poll, overwriting the cookie's one jar
  slot and moving the visitor onto a fresh `anonymous_<id>` subject: list
  endpoints answered `[]` and the second message on any thread failed with
  `threadId is already in use`. https was never affected because `__Host-`
  requires `Path=/`. Existing `Path=/api/vendo` cookies keep working — the wire
  reads the pointer by name and honors it as-is.
- a2bd192: A Claude 5 model pinned through the model ladder can generate again (#692).

  `vendoModel()`'s lazy wrapper reports its family id (`"vendo-env"`) by design,
  so model-params' Claude 5 allowlist never saw the resolved rung's real id: the
  engine's `temperature: 0` rode through the ladder and a pinned Claude 5 model
  (`VENDO_MODEL=claude-sonnet-5` with `ANTHROPIC_API_KEY`) rejected every call
  with 400 "`temperature` is deprecated for this model". Sampling support is now
  re-decided at call time against the RESOLVED rung — the one moment the real id
  is known — dropping the sampling params such a rung rejects and setting the
  explicit output cap that guards against a sampling-era provider's silent 4096
  truncation. Sampling-era Claude and non-Claude rungs pass through untouched.
  `@vendoai/apps` exports the capability rule (`acceptsSamplingParams`,
  `UNKNOWN_MODEL_MAX_OUTPUT_TOKENS`) so the umbrella rides the engine's one
  allowlist instead of a copy.

- Updated dependencies [a2bd192]
  - @vendoai/apps@0.6.1
  - @vendoai/automations@0.6.1
  - @vendoai/core@0.6.1
  - @vendoai/store@0.6.1
  - @vendoai/agent@0.6.1
  - @vendoai/actions@0.6.1
  - @vendoai/guard@0.6.1
  - @vendoai/ui@0.6.1
  - @vendoai/mcp@0.6.1
  - @vendoai/knowledge@0.6.1

## 0.6.0

### Minor Changes

- 89153f8: Delete the pre-v3 `.vendo` format layer and the semantics dev-server pass.

  `.vendo/` is now one format, not two. The `vendo/tools@1` / `vendo/overrides@1`
  schemas, `vendo/capabilities@1`, `vendo/semantics@1`, `vendoFileVersion`, and
  every dual-format reader and in-memory migration fold are gone; the surviving
  `@3` names lost their `V3` suffix (`toolsFileSchema`, `overridesFileSchema`,
  `ExtractedTool`, `OverridesFile`, `VENDO_TOOLS_FORMAT`, `VENDO_OVERRIDES_FORMAT`
  — now exported from `@vendoai/actions`, and the persisted tag strings
  `"vendo/tools@3"` / `"vendo/overrides@3"` are unchanged).

  `vendo sync` also no longer calls a running dev server to infer field
  semantics: the `POST /sync/semantics` route and its CLI pass are deleted, so a
  sync never executes host endpoints as a side effect. The per-tool `semantics`
  field itself is untouched — sync's AI enrichment proposes it and
  `overrides.json → tools[name].semantics` still wins forever.

  Removed public types: `CapabilitiesFile`, `SemanticsFile`, `OverridesFileV3`
  (use `OverridesFile`). Removed config: `createActions({ capabilities })`,
  `createVendo({ profile: { capabilities, semantics } })` — compounds and briefs
  live in `overrides.json`.

- 3ae3d13: Delete template tool descriptions and the domains manifest.

  `vendo sync` no longer invents a description for a tool your API does not
  describe. The deterministic `"Use this to …"` generator is gone: an
  undescribed tool carries `""` in `.vendo/tools.json`, which is the honest
  keyless state. Sync's AI enrichment pass proposes real descriptions when a
  model credential is present, and `overrides.json → tools[name].description`
  still wins forever.

  The domains manifest is gone end to end. Generation already receives the full
  tool list, so a derived summary of tool nouns told the model nothing new — and
  a finite `hasNot` can never enumerate what a host lacks. Removed: the `domains`
  field from both `.vendo/tools.json` and `.vendo/overrides.json`, the
  `DATA DOMAINS` prompt section, and the `domains` provider slot on the apps
  runtime.

  Removed public API: `DomainManifest` and `domainManifestSchema` (from
  `@vendoai/core`); the `domains` field on `ToolsFile` / `OverridesFile`;
  `createApps({ domains })`. `mergedSemanticsAndDomains` is now
  `mergedHostSemantics` and returns the per-tool semantics record directly
  (the `MergedHostSemantics` wrapper type is gone).

  `.vendo/overrides.json` is strict, so a leftover `domains` key now fails
  loudly at parse — delete it and re-run `vendo sync`.

- 020fc8e: Add the judgment channel: a judge pass, an independent skeptic, and the human
  gate on loosenings (`packages/vendo/src/cli/judge/`).

  `runJudgmentPass()` reads the deterministic `.vendo/tools.json`, asks a model to
  grade it, then asks a SECOND independent run to tear that answer apart, and
  writes only what survives into `.vendo/judgments.json`. Not yet wired into
  `init`/`sync`/`try` — that is the next change; this one adds the module and its
  tests.

  The shape follows from one failure mode: a single model pass allowed to grade
  capability will confidently justify a grade the code does not support, in either
  direction. An over-tight grade silently breaks a working product; a loose one
  hands out capability. So:

  - the JUDGE proposes, and every proposal costs a VERBATIM quote from the
    handler. No quote, no proposal — rejected at parse and counted in the
    narrative, never discarded silently. One bad proposal cannot fail a whole
    batch of twenty.
  - the SKEPTIC is a second run (fresh conversation, same engine) whose only job
    is to check each field against the real source, including whether the quoted
    evidence appears in the file at all. It rejects hardenings as readily as
    loosenings.
  - anything the skeptic never examined gets exactly ONE re-ask and is then
    REJECTED, with an honest count. Unexamined never means applied. A proposal
    whose every field is rejected writes no entry at all, so a discredited quote
    is never recorded as provenance.
  - survivors route through the direction rule in `@vendoai/actions`: hardenings
    and prose apply themselves; loosenings either aggregate into ONE review diff
    (`loosenings: "review"`) or park as `pending` (`loosenings: "queue"`).

  Risk may now move in BOTH directions and a wake-up (`disabled: false`) may be
  proposed for a scanner-disabled tool — the old clamp could only refuse those,
  so a real finding evaporated into a log line.

  The engine ladder merges the two that existed (enrichment's resolver and init's
  selection) into one: the credential gate runs first so a keyless repo never
  probes a harness, an `--engine` pin never falls back to another provider, and
  availability is swept across the whole ladder so the unavailable-pin message can
  name the real alternatives. Keyless degrades to one calm line
  (`judgment: structural-only …`) with zero errors.

  Every model-originated string and every evidence snippet is treated as untrusted
  repo content and stripped of C0/C1/DEL control characters before it reaches a
  terminal — including the review diff, which is exactly what an attacker would
  want to spoof.

  Also dedupes `askYesNo`: the copy in `cli/extract/extraction.ts` is removed in
  favor of the existing one in `cli/shared.ts` (which additionally guards against
  blocking on a non-TTY stdin). Importers updated; no call-site behavior change
  for interactive runs.

- a9aa714: Wire the judgment channel into `init`, `sync` and `try`, and delete the three AI
  systems it replaces.

  `init` and `sync` now run `runJudgmentPass` instead of the staged AI extraction
  and the sync enrichment pass. The difference that matters is WHERE model output
  lands and what it costs to get there: a proposal needs a verbatim source quote,
  an independent skeptic checks it against the real handler, hardenings and prose
  apply themselves into `.vendo/judgments.json`, and loosenings — lower risk, wider
  audience, a woken tool, a cleared critical mark — wait for a human. So
  `overrides.json` goes back to meaning only "what a person decided", and a
  re-sync can no longer clobber either file.

  Deleted outright: the staged extraction pipeline (survey → draft-per-surface →
  cross-check) with its prompts, `runAiExtraction`/`applyDraft` and the whole
  `cli/enrich/` pass (watermark diff, restrictive-only clamp, tripwire), and the
  `vendo extract --apply` delegation path — including the `aiPolish` contract the
  `init --agent` plan used to carry, which no external agent can honour now that a
  judgment requires quoted evidence. `vendo extract` exits as an unknown command.

  The prose half survives as two focused stages, `runBriefStage` and
  `runThemeStage`; the brief prompt now reads the JUDGED catalog rather than a
  draft. `vendo try`'s background deepening runs judgment → brief → seeds and
  queues loosenings instead of prompting, since that surface is non-interactive by
  design.

  Flags: `vendo sync --no-watermark` is renamed `--no-ai` (the old name keeps
  working as a silent alias); `--review` now shows the queued and new loosenings;
  `--full` judges the whole catalog instead of only what moved.

  Also fixed: `vendo doctor`'s live-surface check and the `try` profile's tool
  summaries hand-rolled a tools+overrides merge that would have disagreed with the
  runtime once judgments existed. Both now resolve the same three layers the
  runtime does — skeleton ⊕ judgments ⊕ overrides — so a disable either surface
  reports is one the agent actually sees.

### Patch Changes

- db1915e: Teach the judge three labeling rules the mutation test cannot derive.

  The risk section of the judge prompt now states, alongside the mutation test:

  - **A catch-all route is graded at its worst operation.** When one URL fronts
    many operations (`[...nextauth]`, `[trpc]`, an upload or OAuth SDK handler),
    which method reaches which operation is decided inside the dependency, not in
    the host's source — so the tool is graded at the most dangerous operation
    reachable behind that URL, and when the source cannot settle it, at the worst
    plausible one, said out loud in the reason.
  - **`destructive` needs bulk or irreversible loss.** A hard delete of one easily
    re-created row or object — remove a member, cancel an invite, remove an image
    — is a `write`. If every delete were destructive the top grade would mean
    nothing.
  - **An unrecallable outbound effect is a `write` with no row written** — mail or
    SMS sent, a webhook delivered, a payment captured, an external checkout or
    billing-portal session created.

  Doctrine is unchanged: hardenings still apply immediately, loosenings still need
  the skeptic and a human, and the self-consistency check still drops a grade that
  contradicts its own reason.

- b14b209: Wire `.vendo/judgments.json` into the runtime read path: the AI layer now
  actually applies, between the machine layer and the human one.

  Host tools compose as `tools.json < judgments.json < overrides.json` — the
  scanner's skeleton, hardened by its standing judgment, then corrected by the
  authored override, which still wins last. `LoadedHost` carries the parsed
  judgments file, and `loadHost` reads it in the same `Promise.all` as the pair.
  Absent is fine; MALFORMED fails loudly at load, the same fail-closed posture as
  `overrides.json` and for the same reason — the file can carry disables and
  audience exclusions, so silently ignoring a broken one would silently loosen the
  live surface.

  Judgments are a HOST-tool layer only: connector, registry, and compound tools
  are untouched. Lane A's safety properties hold on the read path — a `pending`
  loosening never applies, and a judgment whose `binding` no longer matches the
  tool's identity is wholly inert.

  `mergedHostSemantics` gains the matching leg, so generation sees the same three
  layers: `tools.json` semantics, then `judgments.json` `fields.semantics`, then
  the authored overrides. `createVendo`'s host-semantics provider reads
  `.vendo/judgments.json` alongside the pair, live per generation.

  Also fixed: the zero-live-host-tools boot warning derived enablement by hand
  from `overrides.json` alone, so a deployment whose host tools were all disabled
  by judgments would have shipped a silently useless agent without warning. It now
  reads the same effective state the registry dispatches from.

- 23cdb00: Onboarding safety and honesty: four fixes to the first `vendo init`.

  - **A secret written into a committed file now says so.** `vendo login` and
    `vendo init --cloud-key` land `VENDO_API_KEY` in `.env.local`, and now say one
    line about whether git will commit it, with the remediation that actually
    works: `git rm --cached` when the file is already tracked (where .gitignore
    cannot help), the .gitignore line when it is untracked and unignored, and an
    explicit "git could not answer" when a live repo errors. Symlinks are resolved
    first, so a gitignored `.env.local` pointing at a tracked file is judged by
    the file the write really lands in. Silent when the file is ignored, and when
    there is no working tree or no git at all. The write is never blocked — the
    key is already minted.
  - **The closing line stopped guessing in both directions.** It claimed "the
    agent is live in your app" whenever a rung resolved — including a malformed
    `VENDO_API_KEY` or `VENDO_DEV_CREDENTIAL=vendo-cloud` with no key, neither of
    which can serve a turn. Now: a usable credential says live; a composition
    scaffolded this run with no key says "live once you add a model key"; and a
    re-run over a composition Vendo did not write states the condition, because
    that composition may pass its own `model` and nothing here can see it.
  - **A pages-only Next host gets instructions that work.** The manual wiring
    paste and the agent tail named `app/layout.tsx`, a file such a host does not
    have. They now name `pages/_app.tsx` and wrap `<Component {...pageProps} />`
    (the generated `vendo/vendo-root.tsx` is a client component, so it mounts
    there unchanged). Where the API route segment is scaffolded is unchanged.
  - **An interactive init at a monorepo root names the real host.** Detection
    finds no `next`/`express` at a workspace root and falls through to the
    runtime-neutral `custom` scaffold — silently one level too high. It now names
    the workspace packages that do look like hosts ("did you mean apps/web?") and
    suggests a path that resolves from the caller's own cwd, single-quoted when the
    shell would otherwise mangle it. Non-interactive runs already errored with the
    exact flag; unchanged.

- e4d674b: The two first-hour model failures now show their fix instead of a generic error.

  A keyless app and a missing provider install already had exact instructions —
  but the model ladder threw them as plain `Error`s, so the wire's safe-error gate
  replaced them with "An error occurred while generating the response." in the
  thread and "the turn returned an error frame" in `vendo doctor`. The honest
  message only ever reached the server log. Both are `VendoError`s now, so the
  existing rail carries them to the thread banner and doctor's live-turn line.

  A rejected key (401) got the same generic line. The ladder knows which rung it
  resolved, so it now says which key was refused and what to do: a Cloud key is
  re-minted with `vendo login`, a BYO provider key is checked in `.env.local` —
  neither is ever sent the other's next step. The provider's own error stays on
  `cause`, so its request id still reaches the server log. A 401 the ladder cannot
  attribute — a provider the host wired itself, or a tool's own HTTP failure —
  keeps the generic line rather than guessing it was about the model key. A 401
  carrying the Cloud meter refusal still renders the pricing sentence.

  `npx vendo try` turns ride that same rail now: the surface is handed the
  ladder's own model instead of the raw provider one, so a rejected key names the
  rung it was rejected on there too. That lazy model also forwards the resolved
  provider's `supportedUrls`, so a remote image or PDF the provider can ingest
  natively is no longer downloaded first — which is what made such a turn fail
  outright under restricted egress.

- 2f0a421: `vendo init --yes` no longer blocks on the loosening review, and three CLI help
  and error lines now say what the code actually does.

  `--yes` promises every question is already answered. It kept that promise for
  the AI-polish consent and broke it one step later: with `--ai-polish` granting
  consent, a run in a terminal reached the aggregated loosening review and waited
  for a human the moment the judgment pass proposed waking a disabled tool or
  lowering a risk grade — so `vendo init --yes --ai-polish` could hang in CI or
  under an agent. Unattended runs now queue loosenings instead: held as `pending`,
  nothing applied, printed with `vendo sync --review`. Auto-applying was never an
  option — risk is not lowered without a human — and no `confirm` seam is handed
  to the pass at all when the run is unattended, so nothing downstream can block
  either.

  `--yes` claimed only "skip the cloud-login offer". It also accepts the detected
  auth preset, skips the AI polish pass and the theme review, and swaps the
  interactive success screen for the agent tail — an agent reading the old line
  could not predict any of that. `--framework` listed `next, express` while
  `custom` (the runtime-neutral scaffold for Workers, Bun, Deno, Hono, and Lambda
  adapters) has been accepted all along.

  When `vendo login` dies on a transient failure — network, DNS, a killed fetch —
  it printed the raw error and nothing else, so the reader assumed the ceremony
  was lost and started over, abandoning an approval that would still have landed.
  It now names the surviving pairing code and says that re-running `vendo login`
  resumes the same request. The line appears only when a resume can actually
  succeed: every terminal outcome already deletes the claim.

- c52629b: Remix is experimental: unresolved remixable slots now warn (`experimental:` prefix, slot + reason + fix hint) instead of failing `vendo sync` with exit 2. Slots are still never skipped silently; acknowledge intentionally uncapturable ones in `overrides.json` → `remix.ignoreSlots`.
- a7199db: Chrome polish wave + the automation card's missing emitter.

  - **Status ribbon docks onto the composer** (Codex-style): narrower than the
    composer, top corners only, its bottom edge tucked behind the card — no more
    floating pill with a gap, on both the page surface and the overlay's
    dock-anchor DOM.
  - **Approval card de-escalated**: the ceremony card keeps the neutral surface
    with a single amber accent bar instead of the full yellow wash; the
    ALL-CAPS "CRITICAL" eyebrow is gone; risk slugs render in the user's
    language ("Irreversible", "Makes changes", "Read-only") with the raw slug
    intact on `data-risk` and the tooltip.
  - **App-card dot stands down when ready**: the pulsing build dot fades and
    collapses once the view is generated; the ready bar carries just the name.
  - **`.fl-btn` is a non-wrapping flex row**: icon + label ride one line (the
    connect card's "Connecting…" spinner no longer folds onto its own line).
  - **`VendoPage` accepts `thread`** (`suggestions` + `discoverability`
    passthrough to the chat tab), so hosts can move their curated landing onto
    the full workspace; Maple's Ask Maple page and Cadence's assistant now
    render the workspace console.
  - **The automation card now actually streams**: `vendo_apps_edit` ok-outputs
    that armed an automation emit `data-vendo-automation` from the agent tool
    bridge (name-scoped, 01 §16), and the apps runtime reports the armed
    trigger's true `enabled` state on `EditResult.automation`. The playground
    gallery gains an "Automation created" scenario.

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
- Updated dependencies [127aa29]
- Updated dependencies [b14b209]
- Updated dependencies [9532dc0]
- Updated dependencies [e4d674b]
- Updated dependencies [d6c231e]
- Updated dependencies [5987985]
- Updated dependencies [a7199db]
  - @vendoai/core@0.6.0
  - @vendoai/actions@0.6.0
  - @vendoai/apps@0.6.0
  - @vendoai/ui@0.6.0
  - @vendoai/agent@0.6.0
  - @vendoai/automations@0.6.0
  - @vendoai/guard@0.6.0
  - @vendoai/knowledge@0.6.0
  - @vendoai/mcp@0.6.0
  - @vendoai/store@0.6.0

## 0.5.0

### Minor Changes

- c7277f6: Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

  Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `entailmentVerifier`: a capped, schema-constrained check that reads the passages a search returned and decides whether they can answer the question at all. An unsupported verdict becomes the existing `insufficient-evidence` outcome, carrying the gap the verifier named so the agent can say WHAT the docs do not cover.

  **It is not score-gated.** It reads every search that returns hits. An earlier design ran it only inside a calibrated score band; the live run showed four unanswerable questions per pass scoring outside that band, never being checked, and being answered — so a check gated on the number it exists to replace inherits that number's blind spots.

  **What it is measured to do.** Live against the cloud engine over the 94-question corpus: false answers 7/34 and 10/34 on its two passes, false refusals 3/60, reading 94/94 searches at 1.37-1.39 model calls per search and adding p50 ~2.5s of verification to a verified turn (summed over that turn's calls; one call's median is ~1.7-1.8s). It reduces confident wrong answers sharply — the same corpus loses 19/34 with the check gated to a score band — but it does not eliminate them, because it cannot refuse when a verification times out and it is sometimes simply wrong. The per-question records and the full table, including the removed gated configuration, are in `docs/eval/KNOWLEDGE.md`.

  **OFF by default.** `VENDO_KNOWLEDGE_VERIFY=on` opts in for the Cloud engine; a value that is neither on nor off throws at composition rather than silently disabling a trust feature. It ships off because the measurement says it does not clear the zero-false-answer bar it exists for, while costing a model call per search and seconds on a call the user waits through — that trade is the host's to make, not a default. Only the Cloud engine composes it; BYO and self-hosted engines are untouched.

  **Enabling the check changes no threshold.** The host's `weakScoreThreshold` (default 0) is exactly what it was, and it still decides every search the check could not read. When there is a verdict the verdict decides, in both directions.

  **It fails open, and says so.** No model, a timeout, or an unusable response yields no verdict: the tool answers the way it would have without a verifier and marks the result with the additive `unverified` field on `vendo/knowledge-result@1`. The thread renders that as the amber "I couldn't check this answer against the documentation" line beside the sources, so a check that did not run is never mistaken for one that passed. Verification is capped per TURN as well as per call, so a chat→deep escalation cannot spend the cap twice.

  An empty or placeholder gap ("", "n/a", "none") fails the verdict schema, so a verdict with its evidence torn off yields no verdict at all and the tool falls open marked, rather than refusing a user with a reason that says nothing.

  The verifier rides its own `knowledgeVerifier` model slot (`VENDO_MODEL_KNOWLEDGE_VERIFIER`, `models.knowledgeVerifier`) beside `judge` — pinning the model that grades answers no longer repoints the one that gates them.

  `@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.

- f5fbb4b: Make the MCP door presentable: per-surface tool menus, human tool titles, and
  risk-derived MCP annotations.

  Hosts curate what each surface offers from `.vendo/overrides.json`'s new
  `surfaces` block (`agent` and `mcp`, a closed key set so a misspelled surface
  fails loudly at parse). `ActionsRegistry.surfaceMenu()` resolves it: the
  authored list wins, an absent `agent` menu is unrestricted, and an absent `mcp`
  menu falls back to every merged, enabled tool whose `audience` is `end-user` or
  unset. Menus are curation, not security: the guard, `disabled`, and audience
  exclusions are untouched, an off-menu call returns the same not-found an unknown
  tool returns, and a menu entry naming a missing or disabled tool warns once and
  is skipped rather than taking the host down. Vendo's own `vendo_*` runtime tools
  are never curated away on either surface.

  `ToolDescriptor` and `ToolOverride` gain an optional `title`: the short human
  label for surfaces people read. `vendo sync`'s AI enrichment proposes one per
  tool (presentation, so it is exempt from the restrictive-only clamp and carried
  across structural syncs); `.vendo/overrides.json` corrects it. The door emits it
  in both standard MCP places (top-level `title` and `annotations.title`), and
  approval cards prefer it over the prettified tool id, behind an in-code
  `ToolMeta.label`.

  **Upgrade note.** Every tool the door lists now carries `annotations`
  unconditionally, including for hosts with no `surfaces` block. That means a
  `read` tool asserts `readOnlyHint: true` to clients, and some MCP clients use
  that hint to skip their own confirmation prompt for read calls. Nothing changes
  server-side: Vendo's guard, policy, approvals, and audit decide exactly what
  they decided before, and annotations are hints the spec says clients may
  ignore. If you have a `read`-labelled tool that is not actually side-effect
  free, correct its `risk` in `.vendo/overrides.json` — that label was already
  driving your policy.

  Every tool the door lists now also carries `annotations` derived from its risk
  label (`read` → `readOnlyHint`, `destructive` → `destructiveHint`), and the door
  serves a themed, script-free, unauthenticated connect page at `{mount}/connect`
  with the MCP URL and per-client setup steps for Claude, ChatGPT, and Cursor.
  demo-bank ships a curated twelve-tool menu as the worked example.

- f95feb7: Runtime/generation wave: `apps.pipeline` threading through createVendo, `agent.instructions` host-voice seam, per-instance judge model binding (bindVendoModelSlots — the process-level slot registry is gone; `Judge.model` is now part of the guard's Judge contract), island-scoped repair + concurrent tier-0 paint lane with a monotonic partial gate, region-parallel assembly compiling the production inline-reference dialect, smoke-render environment failures skipping instead of failing apps, no-emoji contract rules, and per-lane generation logging (onTiming/onPipeline wired to the operator console).
- d1364b6: Chrome wave: split-view workspace with morphing stage, compact embeds, staged blur, stage pinning (host onPin seam), AutomationCard, ConnectCard lifecycle states, landing composer, docked new-reply banner, streaming skeletons, WorkingRibbon, connect-dock resilience, ApprovalSheet fixes, approvals-decided resume event, and eventOutcomeLabel stream-part semantics.
- b94ac5a: The vendo model family lands in the runtime. `vendoModel(name?)` replaces `devModel()` (kept as a deprecated alias): a lazily-resolving AI-SDK model bound to the credential ladder that passes any name string VERBATIM to the resolved rung — the Cloud gateway with `VENDO_API_KEY` (where `vendo`, `vendo-paint`, `vendo-judge`, `vendo-extract` are real model ids), or your provider untouched on a BYO key. There is no client-side name mapping; unknown names surface the provider's own error. `createVendo` gains a `models` block (`{ agent?, paint?, judge? }`, string or LanguageModel per slot) superseding the deprecated top-level `model` and `paint.model` (`paint.disabled` stays the single-lane switch). Per-slot env pins `VENDO_MODEL`, `VENDO_MODEL_PAINT`, `VENDO_MODEL_JUDGE`, and `VENDO_MODEL_EXTRACT` override with no code change (precedence: explicit model object → env pin → models string → per-rung default); the old `VENDO_DEV_*_MODEL` / `VENDO_CLOUD_MODEL` / `VENDO_EXTRACTION_MODEL` vars keep working as deprecated fallbacks. When no model is configured, the paint lane rides the family fast pick per rung (`vendo-paint` on Cloud, e.g. `claude-haiku-4-5` on an Anthropic key) instead of needing a `paint` knob. `vendo doctor` now states the winning model credential rung and any active `VENDO_MODEL_*` pins.

### Patch Changes

- 221b851: Vendo Cloud meter refusals (pricing v3 §5: HTTP 402, stable code
  `meter-exhausted`, structured body) now surface honestly everywhere the OSS
  client can meet them — with no client-side entitlement checks; the refusal
  body stays the only source of truth. Core gains `parseMeterExhausted` /
  `formatMeterExhausted` / `meterExhaustedFromError`: one crafted sentence
  naming the meter, the usage figures and reset date, and the two exits
  (upgrade / BYO). The Cloud adapters (hosted store, sandbox, connections,
  apps) render that sentence on their existing 402 → cloud-required mapping
  with the structured fields preserved on `detail`; the agent recognizes the
  gateway's 402 refusal on the safe stream-error rail so the thread banner
  ends the turn with it; the CLI prints the same single line instead of a raw
  error dump, and doctor's existing live-turn check surfaces safe
  Vendo-prefixed error frames verbatim. Scheduler-refused automation runs
  already read back as failed runs — the blocked reason and code now have
  test-pinned rendering in run history.
- Updated dependencies [0b58e3e]
- Updated dependencies [0e3bc0a]
- Updated dependencies [f965d77]
- Updated dependencies [cbffc9e]
- Updated dependencies [22601e3]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [f95feb7]
- Updated dependencies [b1ba2ec]
- Updated dependencies [f49b1de]
- Updated dependencies [d1364b6]
- Updated dependencies [280a142]
  - @vendoai/apps@0.5.0
  - @vendoai/core@0.5.0
  - @vendoai/store@0.5.0
  - @vendoai/knowledge@0.5.0
  - @vendoai/agent@0.5.0
  - @vendoai/ui@0.5.0
  - @vendoai/actions@0.5.0
  - @vendoai/mcp@0.5.0
  - @vendoai/guard@0.5.0
  - @vendoai/automations@0.5.0

## 0.4.8

### Patch Changes

- 9f01a92: Two fixes from the first full init→app-generated e2e on real workerd:
  the island TSX validator's esbuild import is now bundler-blind (Wrangler
  inlined the Node-only package into Worker bundles, where its \_\_filename
  crash was misread as "invalid TSX" and failed EVERY app build — the field
  report's apps-create death), and a validator that crashes at runtime now
  degrades to no validation instead of failing every island. The CLI also
  accepts `--framework custom` (the flag whitelist had missed it; only the
  programmatic path worked).
- Updated dependencies [9f01a92]
  - @vendoai/apps@0.4.8
  - @vendoai/automations@0.4.8
  - @vendoai/core@0.4.8
  - @vendoai/store@0.4.8
  - @vendoai/agent@0.4.8
  - @vendoai/actions@0.4.8
  - @vendoai/guard@0.4.8
  - @vendoai/ui@0.4.8
  - @vendoai/mcp@0.4.8

## 0.4.7

### Patch Changes

- bb74239: The wire's `open?pending=1` disambiguation now works on hosted (Vendo Cloud) store deployments and passes terminal build failures through to every caller (0.4.6 E2E cert defect D2). The existence probe behind the flag read through `appStore()` — raw SQL over a local db handle — which a hosted wire-door store doesn't have, so on Cloud-store deployments it answered false on every call and every owner-scoped not-found masked to `{"kind":"pending"}`: the #532 terminal failure records never resolved a non-owner poll, and the principal-mismatch diagnosis was unreachable. The probe now reads through the store adapter interface (every store shape serves it), and when the record carries the server-written `buildFailed` marker the wire answers `{"kind":"failed"}` with the persisted reason — a terminal failure is terminal for every caller. A genuinely absent record keeps answering `pending`.
- Updated dependencies [fd9260d]
  - @vendoai/apps@0.4.7
  - @vendoai/ui@0.4.7
  - @vendoai/automations@0.4.7
  - @vendoai/core@0.4.7
  - @vendoai/store@0.4.7
  - @vendoai/agent@0.4.7
  - @vendoai/actions@0.4.7
  - @vendoai/guard@0.4.7
  - @vendoai/mcp@0.4.7

## 0.4.6

### Patch Changes

- Updated dependencies [60c5e39]
  - @vendoai/apps@0.4.6
  - @vendoai/ui@0.4.6
  - @vendoai/automations@0.4.6
  - @vendoai/core@0.4.6
  - @vendoai/store@0.4.6
  - @vendoai/agent@0.4.6
  - @vendoai/actions@0.4.6
  - @vendoai/guard@0.4.6
  - @vendoai/mcp@0.4.6

## 0.4.5

### Patch Changes

- 87eadba: fix(venue): e2b is only selectable when actually usable — 0.4.4 regression

  `e2bInstalled()` treated a runtime without `import.meta.resolve` as "the
  bundler inlined the SDK, so it must be available". Inside Turbopack/webpack
  server bundles that fallback always fired, so a stray `E2B_API_KEY` (for
  example inherited from the shell) flipped the venue ladder to an e2b the
  runtime could never load, outranking the Vendo Cloud sandbox and killing
  every server-app build — 0.4.3 printed `execution venue: cloud`, 0.4.4
  printed `e2b` on the same host. The probe now tests usability instead of
  importability: it asks Node's own resolver (`require.resolve` via
  `process.getBuiltinModule`, which works inside server bundles), falls back to
  a real `import.meta.resolve`, and reads an unverifiable runtime as NOT
  installed — the SDK is never bundler-inlined (the mutable-specifier import
  from the edge-portability work guarantees it), so the runtime resolver is the
  only truth. With `VENDO_API_KEY` set and no usable e2b, the venue is the
  Cloud sandbox again.

  `vendo doctor` also stops false-blessing the venue: `execution venue: e2b`
  now passes only when `E2B_API_KEY` is set and the `e2b` package resolves from
  the project; otherwise it fails with E-LIVE-007 and a concrete fix line.

- Updated dependencies [31f899e]
- Updated dependencies [87eadba]
  - @vendoai/core@0.4.5
  - @vendoai/agent@0.4.5
  - @vendoai/apps@0.4.5
  - @vendoai/ui@0.4.5
  - @vendoai/actions@0.4.5
  - @vendoai/automations@0.4.5
  - @vendoai/guard@0.4.5
  - @vendoai/mcp@0.4.5
  - @vendoai/store@0.4.5

## 0.4.4

### Patch Changes

- 52c72c2: Doctor judges unknown-framework hosts (Cloudflare Workers, Bun, Hono, ...)
  by their actual wiring instead of Next.js file layout — no more permanent
  E-WIRE-003/004 false positives on custom runtimes (new codes E-WIRE-007/008).
  The tool surface is now graded statically: all extracted tools disabled or
  excluded fails doctor (E-TOOLS-001), an empty surface warns (E-TOOLS-002),
  and the actions registry warns at runtime when the agent composes with zero
  live host tools — the silently-useless-agent failure mode is no longer
  silent anywhere.
- 835d17a: Edge-runtime portability: the server entry now bundles and boots on
  Web-standard runtimes (Cloudflare Workers first). Fetch defaults are
  invocation-safe, the optional e2b SDK no longer breaks esbuild/Wrangler
  builds, Node-only legs (local store engines, dev model ladder, telemetry
  disk config, actions sync tooling) sit behind worker/edge export
  conditions with honest guidance, and createVendo performs no I/O, timers,
  or random generation at construction — module-scope wiring works. A CI
  portability gate (bundle + real workerd boot) keeps it that way.

  Note for hosts that reach into composed blocks directly: the BYO tool seam
  (`vendo.guardedTools`, and the ai-sdk/mastra packs built on it) arms schema
  readiness on first execute. Raw `vendo.store`/`vendo.automations` reach-ins
  should `await vendo.store.ensureSchema()` first — the previous eager kick
  only ever gave that pattern a racy head start.

- 70b59db: Extraction now grades every tool's audience (end-user / operator / internal)
  by reading the handler's own auth checks, and excludes non-end-user tools
  from the embedded agent by default (recorded as `audience` in
  .vendo/overrides.json; human decisions always win). Applying a surface that
  leaves the agent with zero live tools warns loudly instead of shipping a
  silently useless agent. Field origin: an infra product's extraction proposed
  operator/reconciliation endpoints; stripping them by hand left an empty
  toolkit and an agent that couldn't act.
- 0c1fca2: `vendo init --framework custom`: a runtime-neutral wiring for any
  Web-standard host (Cloudflare Workers, Bun, Deno, Hono). The generated
  vendo/server.ts is a lazy Request→Response module with the environment
  passed per call; with a Vendo Cloud key it wires the Cloud adapters
  explicitly (model = stock Anthropic provider at the console gateway).
  Unknown-framework detection lands here instead of guessing the Next
  layout into hosts that aren't Next.
- Updated dependencies [52c72c2]
- Updated dependencies [835d17a]
- Updated dependencies [70b59db]
- Updated dependencies [89e3d2b]
  - @vendoai/actions@0.4.4
  - @vendoai/core@0.4.4
  - @vendoai/apps@0.4.4
  - @vendoai/automations@0.4.4
  - @vendoai/store@0.4.4
  - @vendoai/telemetry@0.3.2
  - @vendoai/agent@0.4.4
  - @vendoai/ui@0.4.4
  - @vendoai/guard@0.4.4
  - @vendoai/mcp@0.4.4

## 0.4.3

### Patch Changes

- 7355eed: Install-funnel fixes from the 0.4.x E2E certification (Wave 2):

  - **Visible surface (B3).** `vendo init` now generates a `"use client"` mount
    wrapper (`vendo/vendo-root.tsx`) that applies the registry + theme and
    mounts `<VendoOverlay />`, and wires it into the Next.js layout with one
    bounded, idempotent edit (skipped when a Vendo mount already exists;
    degraded to printed paste lines when the layout has no single unambiguous
    `{children}`). The wrapper is the RSC-safe home for the registry import —
    the previously printed registry-in-server-layout paste crashed every page.
    `VendoOverlay` is re-exported from `@vendoai/vendo/react` so the scaffold
    resolves under pnpm strict linking.
  - **Principal alignment (B4).** The anonymous scaffold's wire principal now
    resolves the same demo subject the existing-agents quickstart chat routes
    set (`demo-user`) instead of `null`, so apps and approvals created through
    a BYO agent loop are visible to the embeds. `GET /apps/:id/open?pending=1`
    now distinguishes a record that exists under another principal (terminal
    `{kind:"failed"}` with the mismatch diagnosis) from a still-building app
    (`{kind:"pending"}`) — no more infinite skeleton.
  - **Doctor honesty.** New E-WIRE-006 check fails when no visible surface is
    mounted anywhere; new E-LIVE-006 render gate GETs the app root and fails on
    a 5xx; new E-DEP-002 fails when the running wire's `/status` version
    disagrees with the CLI's (split-brain installs where a direct
    `@vendoai/vendo` pin beats the `vendoai` umbrella); E-WIRE-004 now accepts
    a `<VendoRoot>` mount in ANY app layout (not just the root one); the
    unreachable-`/status` copy names the wire base `--url` expects; the probe
    dev-server's pipes are destroyed on stop so doctor's exit code always
    lands.
  - **Login write-preflight (M4).** `vendo login` proves `.env.local` is
    writable before opening (or resuming) a claim — a sandboxed run that cannot
    write the file fails up front instead of consuming the single-use claim and
    losing the minted key — and a redemption-time write failure now reads as a
    distinct write error (revoke + retry) instead of the timeout copy.

- a48b1b7: Wave 2 runtime fixes from the 0.4.x E2E certification campaign:

  - Mastra shim: open-schema guarded tools (extracted routes whose body shape
    is untyped) no longer execute with `{}` when the user dictated args.
    Mastra's provider schema-compat layers hard-close every object schema for
    strict-mode providers, so an open input reached the model as "takes no
    arguments"; the shim now bridges open inputs through one declared `args`
    property (JSON object or JSON-encoded string) and unwraps it before the
    guard, so approvals park — and replay — with the real arguments.
  - Failed app builds now carry their reason everywhere: `create()` re-throws
    with the classified reason in the message (the tool outcome the calling
    agent reads), logs the un-canned issue list to the operator terminal
    (previously a silent failure), and the app embed shows a retry hint for
    retryable failures. The generation engine now captures streamText's
    swallowed provider errors, so quota/timeout/no-key failures classify
    correctly instead of collapsing to "generation failed".
  - The dev model's no-usable-credential lines (missing provider package, no
    key at all) surface verbatim in the failed-build reason — the in-surface
    error now carries the actionable `npm install @ai-sdk/...` / `vendo login`
    instruction instead of `model could not produce a valid app`.
  - `@vendoai/ui` DonutChart no longer crashes on `undefined`/non-array data
    inside generated apps; it renders the designed empty state like the other
    Kit charts.

- Updated dependencies [a48b1b7]
  - @vendoai/apps@0.4.3
  - @vendoai/ui@0.4.3
  - @vendoai/automations@0.4.3
  - @vendoai/core@0.4.3
  - @vendoai/store@0.4.3
  - @vendoai/agent@0.4.3
  - @vendoai/actions@0.4.3
  - @vendoai/guard@0.4.3
  - @vendoai/mcp@0.4.3

## 0.4.2

### Patch Changes

- 8eaceb5: Login and first-turn fixes from the 0.4.1 E2E certification campaign:
  `vendo login` pending claims are now scoped per project directory —
  concurrent logins in different repos can no longer clobber or resume each
  other's ceremonies (the machine-global file could deliver one project's key
  to another). A matching pre-0.4.2 claim file is migrated automatically.
  `vendo init` now installs the model provider its resolved credential loads
  at runtime (`ai@^6` plus `@ai-sdk/anthropic@^3` / `@ai-sdk/openai@^3` /
  `@ai-sdk/google@^3`), so the first turn no longer 500s on a fresh install
  until the provider is added by hand.
  - @vendoai/core@0.4.2
  - @vendoai/store@0.4.2
  - @vendoai/agent@0.4.2
  - @vendoai/actions@0.4.2
  - @vendoai/guard@0.4.2
  - @vendoai/apps@0.4.2
  - @vendoai/automations@0.4.2
  - @vendoai/ui@0.4.2
  - @vendoai/mcp@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1
  - @vendoai/telemetry@0.3.1
  - @vendoai/actions@0.4.1
  - @vendoai/agent@0.4.1
  - @vendoai/apps@0.4.1
  - @vendoai/automations@0.4.1
  - @vendoai/guard@0.4.1
  - @vendoai/mcp@0.4.1
  - @vendoai/store@0.4.1
  - @vendoai/ui@0.4.1

## 0.4.0

### Minor Changes

- 5d89564: Extract registered host-component catalogs deterministically during sync, persist strict catalog artifacts and stale-safe review-only copy proposals, and load generated catalogs into the umbrella runtime with actionable malformed-file warnings. TypeScript is loaded only on the sync scan path and is no longer a production dependency of `@vendoai/actions`.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- 2f67c65: Server-actions extractor behind the extractor seam (ENG-248): statically scan `"use server"` modules and inline functions with the TypeScript compiler API, interpret zod-validated and annotated inputs into JSON Schema (fail-closed to permissive + note otherwise), and emit the additive `server-action` binding kind (`module` + `exportName` + ordered `params`) within `vendo/tools@1`. Execution is direct in-process registration: `vendo init` now generates a `vendo-actions.ts` registration map wired into `createVendo({ serverActions })`; a server-action tool whose registration is missing fails closed with a clear error and no work performed. Risk labels fail closed — actions default `write`, the destructive word list applies, and unclassifiable or inline (non-importable) actions are emitted `disabled: true` with a note.
- ebc72e4: Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.
- b29f65d: Init AI unification: theme extraction's model fallback now rides the same consent-gated AI pass as tool judgment (one consent covers both), running through the dev's `claude` CLI on PATH or a resolvable Agent SDK — nothing installed in the host app. The exact CSS pass still always writes `theme.json` first; `--theme slot=value` overrides any slot directly. Font-family names are canonicalized without optional CSS quotes.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
- fbe4a49: Vendo Cloud gateway calls now send curated model aliases instead of raw provider ids. The `VENDO_API_KEY` dev-mode rung requests `vendo-default` (Sonnet) by default; `VENDO_CLOUD_MODEL` picks `vendo-fast` (Haiku) or `vendo-strong` (Opus). The box's Cloud inference rung pins `vendo-default` the same way (`VENDO_INFERENCE_MODEL` still overrides). The gateway remaps any non-alias to `vendo-default` (with an `x-vendo-model-remapped` warning header) during a grace window and will reject non-aliases after it. BYO provider keys are unaffected and keep real model ids.
- 023b3c0: Security hardening (ENG-251).

  - **Run-token anti-replay** (`@vendoai/apps`): run tokens now carry a random `jti`
    nonce. A run's jti is burned when its machine is torn down, so a captured token
    replayed afterwards is rejected at the proxy even though its HMAC and TTL still
    verify — shrinking the replay window from the full 15-minute TTL to the live run.
    A token remains valid for every callback of its own live run (tools, state,
    egress), so legitimate repeated proxy calls are unaffected. A token minted with
    no `jti` fails closed.
  - **Timing-safe `/tick` compare** (`@vendoai/vendo`): the `VENDO_TICK_SECRET`
    bearer check used plain string equality (a timing oracle). It now uses a
    WebCrypto HMAC-digest constant-time compare — edge-safe, no `node:crypto`.
  - **Bounded ephemeral-subject set** (`@vendoai/store`): the anonymous-visitor
    ephemeral-subject set is now a bounded LRU (10k) instead of growing until
    process restart. The subject registered for the current request is never the
    one evicted.

- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
- dab84c2: Performance: bound the automations tick and the agent's per-turn context.

  - **automations**: the tick fetches only schedule-triggered apps through an indexed
    `trigger_kind` ref (was a full scan of every app for every subject) and batches every
    schedule cursor into one query (was an N+1 get per app). Fired automations now execute
    with bounded parallelism (`tickConcurrency`, default 4) and an optional per-run timeout
    (`runTimeoutMs`), so one hung run cannot block other tenants or overrun the tick
    interval. `emit` likewise fetches only the subject's host-event apps. `/tick` still
    returns the same runIds.
  - **agent**: Anthropic prompt-caching breakpoints on the static system prompt and the
    stable history prefix (ignored by other providers); a default tool-output cap so one
    huge host-tool response cannot blow the context (`config.agent.toolOutputCap`); a new
    `historyWindow` knob bounding what is re-sent per turn (default: the full thread, as
    before); and thread listing that derives titles from a stored `title` instead of loading
    every thread's full message array.
  - **store**: btree indexes backing the `(created_at, id)` keyset pagination on
    `vendo_records` and the paged MCP tables, a generated `trigger_kind` column on
    `vendo_apps`, and a `title` column on `vendo_threads`. All applied as additive DDL — no
    schema-version bump and no data migration.

- Updated dependencies [49e9ccc]
- Updated dependencies [5d89564]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [a7d57b7]
- Updated dependencies [e9c538c]
- Updated dependencies [da4d3e8]
- Updated dependencies [a2ca8e2]
- Updated dependencies [b819ab2]
- Updated dependencies [75cb256]
- Updated dependencies [5093682]
- Updated dependencies [083a3b9]
- Updated dependencies [c42d41a]
- Updated dependencies [2f67c65]
- Updated dependencies [023b3c0]
- Updated dependencies [ebc72e4]
- Updated dependencies [fa0ad98]
- Updated dependencies [0e94fa6]
- Updated dependencies [0f17f39]
- Updated dependencies [7826a6e]
- Updated dependencies [7546de1]
- Updated dependencies [51f3fc9]
- Updated dependencies [0d2810b]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
- Updated dependencies [8d5423d]
- Updated dependencies [0c10661]
  - @vendoai/core@0.4.0
  - @vendoai/store@0.4.0
  - @vendoai/mcp@0.4.0
  - @vendoai/actions@0.4.0
  - @vendoai/agent@0.4.0
  - @vendoai/automations@0.4.0
  - @vendoai/guard@0.4.0
  - @vendoai/ui@0.4.0
  - @vendoai/apps@0.4.0
