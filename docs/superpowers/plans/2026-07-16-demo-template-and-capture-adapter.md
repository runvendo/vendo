# Demo Template + Generic Capture Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 1 of the demo-creator spec (`docs/superpowers/specs/2026-07-16-demo-creator-design.md`): a new `apps/demo-template` host containing only the never-breaks plumbing, and a generic host adapter so `bench/demo-capture` can boot, verify, and record any generated demo — not just Maple/Cadence.

**Architecture:** demo-template is a stripped sibling of `apps/demo-bank`: same Vendo wiring pattern (`src/vendo/server.ts` via `createVendo`), same in-memory seeded-store + typed API-route pattern (`src/server/*`, `src/app/api/*`), but with placeholder visible pages the creator agent will fully rewrite, a per-demo `demo.config.json` that drives chips/caps/expiry/beats, and no login wall. The capture harness gains a config-driven host definition alongside the two hardcoded ones.

**Tech Stack:** Next.js 16 / React 19 (matching demo-bank), `@vendoai/*` workspace packages, zod for config validation, vitest, existing Playwright+ffmpeg capture harness in `bench/`.

**Per Yousef's planning rules this plan is high-level: each step says what to build and how to prove it, not the code.**

---

## File map

**Create (apps/demo-template/):**
- `package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `README.md` — copied/trimmed from demo-bank; package name `demo-template`
- `demo.config.json` — the per-demo contract: demo id, prospect name, beat definitions (beat key + prompt + chip label), caps (max agent turns, model-spend budget in USD), expiry date, CTA URL
- `src/lib/demo-config.ts` — zod schema + loader for demo.config.json (single source of truth; capture adapter reads the same shape)
- `src/vendo/server.ts` — minimal createVendo wiring: Anthropic model, store, empty host-component catalog seam, demo principal (no Auth.js, no OAuth, no MCP, no Composio)
- `src/vendo/theme.ts` — theme seam the creator overwrites
- `src/server/store.ts`, `src/server/seed.ts`, `src/server/types.ts` — the Maple store pattern reduced to one worked example entity (so the creator has a copyable pattern), clearly commented as replace-me
- `src/app/api/vendo/[...]` — Vendo handler route wrapped by the caps guard
- `src/app/api/example/*` — typed API route for the example entity (the fake-API pattern)
- `src/server/caps.ts` — usage tracking + enforcement: counts agent turns per demo, estimates spend, returns a structured refusal once caps are hit
- `src/components/demo-chrome.tsx` — Vendo-demo badge, "Get this in your product" CTA (cal.com/yousefhelal from config), and the "demo limit reached — book a call" state
- `src/components/suggestion-chips.tsx` — renders the config beats as first-prompt chips in/above the panel mount
- `src/app/page.tsx` + `src/app/demo/page.tsx` (placeholder visible product) and the panel route `src/app/vendo/page.tsx` — minimal, loudly marked as creator-rewrites-this
- `VERIFY.md` — the verification contract a creator run must satisfy (build green, boot clean, all beats hit marks, brand fidelity self-score, uncanny-data pass)
- Tests colocated per repo convention: `src/lib/demo-config.test.ts`, `src/server/caps.test.ts`, `src/server/seed.test.ts`

**Modify (bench/):**
- `bench/src/demo-capture/cli-args.ts` — `DemoHost` union (`"maple" | "cadence" | "both"`) gains a config-driven escape hatch: `--host-config <path to demo.config.json + app dir>`
- `bench/src/demo-capture/hosts.ts` — `DemoHostDefinition.packageName` union widened to string; new function building a `DemoHostDefinition` from a demo config (route, thread id derived from demo id, no password envs — template has no login wall, and the existing login helper already no-ops when no form is present)
- `bench/src/demo-capture/capture.ts` — beat prompts resolvable from the demo config instead of built-in defaults when a host-config is supplied
- `bench/src/demo-capture/cli-args.test.ts`, `hosts.test.ts` — coverage for the new path
- `bench/demo-capture/README.md` — document the generic host usage

**No changes needed:** pnpm workspace + turbo already glob `apps/*`, so demo-template joins build/test/typecheck/lint automatically (verify in Task 1).

---

## Task 1: Scaffold `apps/demo-template` and get it into CI

- [ ] Copy demo-bank's config files (package.json, next/ts/vitest/eslint/postcss configs), rename package to `demo-template`, strip dependencies the template doesn't need (next-auth, radix widgets, recharts, cmdk, swr, composio)
- [ ] Delete everything Maple-specific; leave empty `src/app`, `src/server`, `src/vendo`, `src/components` scaffolding with a root layout and a placeholder home page
- [ ] Confirm `pnpm build --filter demo-template`, `pnpm test --filter demo-template`, `pnpm typecheck`, `pnpm lint` all pass from the repo root and that turbo picked the app up without pipeline changes
- [ ] Commit

## Task 2: demo.config contract (TDD)

- [ ] Write failing tests for `src/lib/demo-config.ts`: a valid config parses; missing/extra fields fail loudly; beats require key+prompt+chip label; caps require turn count and USD budget; expiry must be a future ISO date at load time
- [ ] Implement the zod schema + loader; check in a sample `demo.config.json` (demo id `template-sample`, 3 beats matching the spec's fixed arc with generic prompts, caps 20 turns / $5, far-future expiry)
- [ ] Tests green; commit

## Task 3: Vendo wiring + example fake-API pattern (TDD)

- [ ] Port the minimal slice of Maple's `src/vendo/server.ts`: createVendo with Anthropic model, `createStore` on `.vendo/data`, demo principal (anonymous per-visitor, reusing the existing per-client anon-principal pattern), empty catalog seam, theme seam
- [ ] Write failing tests for the example entity store/seed (deterministic seed via the prng pattern from demo-bank; one entity type with list + one mutating action)
- [ ] Implement `src/server/{types,store,seed}.ts` and the typed routes `src/app/api/example/*`; wire the Vendo handler route
- [ ] Boot the app locally, confirm the panel loads and the agent can call the example action end-to-end (real browser check, screenshot kept for the PR)
- [ ] Tests green; commit

## Task 4: Caps guard (TDD)

- [ ] Write failing tests for `src/server/caps.ts`: under-cap requests pass and increment the turn counter; hitting the turn cap or USD budget returns the structured limit-reached refusal; counters persist across process restart (store-backed, keyed by demo id); expired demo (per config expiry) refuses all agent traffic
- [ ] Implement the guard and wrap the Vendo handler route with it
- [ ] Verify in the browser: exhaust a 2-turn test cap and confirm the panel shows the friendly limit state with the CTA
- [ ] Tests green; commit

## Task 5: Demo chrome + suggestion chips

- [ ] Build `demo-chrome.tsx` (persistent Vendo-demo badge + CTA from config, fake-data disclaimer) and `suggestion-chips.tsx` (config beats → chips that prefill/submit the composer), mounted on the panel page
- [ ] Placeholder visible pages get a clear "the creator rewrites everything in src/app and src/components except demo chrome" banner comment
- [ ] Browser check with screenshots (repo rule for UI changes); commit

## Task 6: Generic capture adapter (TDD)

- [ ] Write failing tests in `bench`: `cli-args` accepts `--host-config` and rejects it combined with `--host both`; `hosts` builds a correct definition from the sample demo.config (package name, route, thread id) 
- [ ] Widen the types, add the config-driven host constructor, resolve beat prompts from the config when present
- [ ] Run a real capture against the locally booted demo-template using the sample config: all three beats record, stopwatch marks land, GIFs produced — this run is the acceptance proof that "GIF capture is the verification" works for generated demos
- [ ] Update `bench/demo-capture/README.md`; tests green; commit

## Task 7: VERIFY.md + wrap-up

- [ ] Write `VERIFY.md`: the exact checklist a creator run must satisfy before a demo counts as done (build/boot/console-clean, three beats hit marks on recording, brand-fidelity self-score vs prospect screenshots, uncanny-data pass, caps + expiry configured, 3-strikes-then-escalate rule)
- [ ] Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green at root
- [ ] Update `docs/` if any integration doc references the demo hosts list
- [ ] Open PR with browser screenshots + the sample capture GIF; request review

---

## Self-review notes

- Spec coverage: template plumbing (Tasks 1–5), VERIFY.md contract (Task 7), generic adapter + config-driven beats (Task 6), no-login-wall decision (Task 3 principal choice), caps/expiry defaults 20 turns/$5/14-day (Task 2 sample sets caps; expiry enforcement Task 4). Milestones 2–5 of the spec are explicitly separate plans.
- Deliberately out of scope here: Railway/router/DNS, the creator pipeline itself, the mac-mini skill, MCP-door beat.
