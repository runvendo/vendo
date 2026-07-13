# Non-Next Host in the Corpus (Express) — Wave Plan

**Goal:** Prove the contracts' framework-agnostic claim (09 §2: the fetch handler "runs anywhere: any JS runtime") with one real, permanent Express host in the corpus — `vendo init` + `vendo doctor` green against it, and a full agent flow (chat → tool call → approval → generated view) running on it, continuously verified.

**Why now:** Every demo and corpus host is Next.js. The claim is contract law but has never been tested.

**Execution model:** Fable orchestrates (this session); all implementation runs on Codex lanes. Autonomous merge on the full hardening done-definition. No npm publish.

## Decisions

1. **Express, not Remix.** Simplest real non-Next server; Remix would re-introduce a framework runtime and blur the "plain JS runtime" proof.
2. **The host lives in-repo at `corpus/hosts/express-host` and joins the pnpm workspace** (new `corpus/hosts/*` glob). Root CI builds/tests it; the corpus harness copies it out to `.repos/` and treats the copy exactly like a cloned foreign repo (inject tarballs, real install, `vendo init --yes`).
3. **The host is a real product, not a stub:** a small task-tracker with an Express 5 API (reads, writes, one destructive action so approvals fire), a Vite-built React SPA served by the same Express process on one port, an `openapi.json` at the root (the extraction source for non-Next apps), and brand CSS custom properties (the theme-extraction source).
4. **The fetch adapter is host-owned.** The umbrella's handler stays exactly the frozen `(Request) => Promise<Response>`; the host carries the small Node-HTTP↔fetch adapter a real integrator would write, including SSE streaming. No new umbrella exports, no contract change.
5. **`vendo init` and `vendo doctor` learn Express as a first-class framework** (additive CLI behavior, contract 09 §5 compatible): detection from the dependency graph, no Next files scaffolded into non-Next apps, doctor recognizes Express wiring and keeps the live `/status` probe.
6. **The corpus manifest gains a local source kind** (path into this repo instead of `gitUrl` + `pinnedSha`): the harness copies the host, creates the throwaway git baseline the idempotency diff needs, and defers the first dependency install to the post-injection install so the committed host never resolves `@vendoai/*` from the registry.
7. **The structural layer branches on framework** for wiring checks (Express: handler composed and mounted in the server; `<VendoRoot>` in the SPA entry) while every framework-neutral check (init exit, `.vendo/*` files, schema validation, typecheck/build baseline, idempotency, fail-closed tools) stays identical.
8. **Verification is two-legged:**
   - CI leg (no LLM key): the host package's own e2e suite boots the real Express server over real HTTP with a scripted model and drives chat → tool execution against the host's own API → approval round-trip → app creation → generated-view (tree) fetch, plus programmatic `init`/`doctor` green runs. This is the suite run ≥5× before DONE.
   - Nightly leg (real LLM): the host joins the manifest as a deep-tier repo with expectations + conversations, so the nightly corpus sweep continuously re-proves extraction, wiring, and the live agent flow on a non-Next host.
9. **Doctor is asserted in the harness for this host** while its server is up (live `/status` round-trip), closing the "init + doctor work against it" requirement in the permanent pipeline, not just once.

## Lanes

- **Lane A — the host app** (`corpus/hosts/express-host`, workspace glob, its e2e suite). Owns everything under its directory plus the one-line workspace glob.
- **Lane B — CLI framework support** (`packages/vendo/src/cli`: init detection + Express planning, doctor Express checks, tests).
- **Lane C — corpus integration** (`corpus/harness` local source kind + framework-aware structural checks + doctor step, manifest entry, `corpus/expectations/express-host/*`, e2e prep, README). Runs after A and B land, since it verifies their outputs.

## Acceptance bar

- Root gates green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
- `pnpm corpus run express-host --layer 3 --strict` green locally (with a real key), including the doctor assertion.
- The host's CI e2e suite green 5 consecutive runs.
- Browser verification of the Express host's Vendo surface with screenshots on the PR.
- Dual review (Codex + adversarial self-pass), external reviewers triaged, PR to main, merge on the full done-definition.
