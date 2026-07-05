# Provider-Agnostic Core + @flowlet/server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any big-3 provider key alone gives working chat via env config, and a non-Next Node server can host Flowlet through a new `@flowlet/server` package, with `@flowlet/next` unchanged for its users.

**Architecture:** Extract the already fetch-native handler core from `@flowlet/next` into `packages/flowlet-server`, add a provider-resolution module (env keys + `FLOWLET_MODEL` provider-prefix syntax, optional peer deps for OpenAI/Google), fix the chat capability flag to reflect any configured model, and prove the non-Next path with a `node:http` example. Spec: `docs/superpowers/specs/2026-07-04-provider-agnostic-core-design.md`.

**Tech Stack:** TypeScript, ai SDK (`ai`, `@ai-sdk/anthropic` dep, `@ai-sdk/openai` + `@ai-sdk/google` optional peers), vitest, tsc builds, pnpm + turbo workspace, Vite React example client.

**Per-task rhythm:** every task is TDD (write failing test, see it fail, implement, see it pass) and ends with a commit. Commands below assume repo root.

---

### Task 1: Scaffold `@flowlet/server`

**Files:**
- Create: `packages/flowlet-server/package.json`, `packages/flowlet-server/tsconfig.json`, `packages/flowlet-server/src/index.ts`
- Reference: `packages/flowlet-next/package.json` (mirror its build/test/typecheck scripts and tsc-based build)

- [ ] Create the package skeleton: name `@flowlet/server`, same script shape as `@flowlet/next` (tsc build, vitest, typecheck), dependencies `@flowlet/core`, `@flowlet/runtime`, `@flowlet/components`, `ai`, `zod`, `@ai-sdk/anthropic`. Declare `@ai-sdk/openai` and `@ai-sdk/google` as optional peerDependencies (peerDependenciesMeta optional true). No react deps: this package is server-only.
- [ ] Add a trivial index export so the package builds, run `pnpm install` then `pnpm --filter @flowlet/server build typecheck` and confirm both pass.
- [ ] Commit.

### Task 2: Move the handler core out of `@flowlet/next`

**Files:**
- Move (with their tests): `packages/flowlet-next/src/{chat,action,integrations,capabilities,world,options,guard,flowlet-dir,manifest-tools,agent,default-policy,connections,catalog}.ts` -> `packages/flowlet-server/src/`
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/index.ts`, `packages/flowlet-next/package.json` (add `@flowlet/server` workspace dep)
- Stays in flowlet-next: `handler.ts`, `handler.test.ts`, `src/client/` (all React client code)

- [ ] `git mv` the listed modules and their `.test.ts` files into `packages/flowlet-server/src/`; export the moved public symbols from `packages/flowlet-server/src/index.ts`.
- [ ] Point `flowlet-next`'s `handler.ts` imports at `@flowlet/server`; make `flowlet-next`'s `index.ts` re-export the moved symbols from `@flowlet/server` so its public API is byte-for-byte identical (same names, same types).
- [ ] Run `pnpm --filter @flowlet/server --filter @flowlet/next test typecheck` and confirm everything passes with zero test edits beyond import paths. Any needed source change beyond imports means the move broke a seam: stop and fix.
- [ ] Run the full `pnpm test` and `pnpm typecheck` at repo root to catch downstream consumers (demo apps import `@flowlet/next` only, so expect no fallout).
- [ ] Commit.

### Task 3: Provider resolution module (TDD)

**Files:**
- Create: `packages/flowlet-server/src/model.ts`, `packages/flowlet-server/src/model.test.ts`
- Modify: `packages/flowlet-server/src/world.ts` (delete `defaultModel`, use the new resolver), `packages/flowlet-server/src/index.ts` (export resolver)

- [ ] Write failing tests for the resolution matrix, driving `resolveModel(env)` (async, returns a LanguageModel) and a pure `resolveModelChoice(env)` helper (returns provider + model id, easy to unit test without provider SDKs):
  - each key alone picks its provider and default id (Anthropic -> `claude-sonnet-5`, OpenAI -> `gpt-5.5`, Google -> `gemini-3.5-flash`; verify current ids against provider docs while writing this task and adjust)
  - multiple keys: precedence Anthropic > OpenAI > Google
  - `FLOWLET_MODEL=provider/model` picks that provider regardless of other keys; unknown provider prefix is a readable boot error
  - bare `FLOWLET_MODEL` id applies to the detected provider (backwards compatible)
  - no keys and no `FLOWLET_MODEL`: resolver reports "no provider configured" (used by capabilities, must not throw at assemble time; chat returns its existing 503-style disabled response)
  - missing optional peer package produces the actionable error naming the exact `npm i @ai-sdk/...` command (simulate by injecting the importer)
- [ ] Run `pnpm --filter @flowlet/server test -- model` and confirm the new tests fail.
- [ ] Implement: pure choice logic + dynamic `import()` per provider, `@ai-sdk/anthropic` statically imported. Replace `defaultModel()` usage in `world.ts` and delete it. Note `assemble()` in the handler is sync today and `resolveModel` is async: resolve the model lazily inside the chat/world paths or make assemble async; pick whichever keeps the moved tests green and document the choice in the code.
- [ ] Run the same test command and confirm pass, then full-package `pnpm --filter @flowlet/server test`.
- [ ] Commit.

### Task 4: Capability semantics fix

**Files:**
- Modify: `packages/flowlet-server/src/capabilities.ts`, `packages/flowlet-server/src/capabilities.test.ts`, `packages/flowlet-next/src/handler.ts` (and the equivalent wiring in Task 5's fetch handler)

- [ ] Write failing tests: `chat` is true when any of the three provider keys is present; true when `hasInjectedModel` is passed regardless of env; voice still keys off `OPENAI_API_KEY`; integrations off `COMPOSIO_API_KEY`; all false with nothing set.
- [ ] Run `pnpm --filter @flowlet/server test -- capabilities`, confirm fail.
- [ ] Implement `detectCapabilities(env, { hasInjectedModel })`; update the handler so `GET /capabilities` passes `hasInjectedModel: options.model !== undefined` and `POST /chat` gates on the same value (delete the ad-hoc `options.model !== undefined || s.capabilities.chat` special case in favor of one source of truth).
- [ ] Run package tests, confirm pass. Commit.

### Task 5: `createFlowletFetchHandler` + thin Next adapter

**Files:**
- Create: `packages/flowlet-server/src/fetch-handler.ts`, `packages/flowlet-server/src/fetch-handler.test.ts`
- Modify: `packages/flowlet-next/src/handler.ts` (becomes a wrapper), `packages/flowlet-server/src/index.ts`

- [ ] Write failing tests for the single fetch handler: routes GET capabilities/integrations, POST chat/action/integrations/tick by sub-path, 404 otherwise, same lazy-assembly-on-first-request behavior (build in CI without keys must not throw at import time). Reuse the scenarios from `handler.test.ts` where they apply.
- [ ] Confirm fail, then implement by lifting the routing from `flowlet-next/src/handler.ts` into `fetch-handler.ts` (method + sub-path switch over one `(req) => Response` function).
- [ ] Rewrite `flowlet-next`'s `createFlowletHandler` as a thin wrapper: build the fetch handler once, return `{ GET: h, POST: h }`. Its existing `handler.test.ts` must pass unchanged.
- [ ] Run `pnpm --filter @flowlet/server --filter @flowlet/next test typecheck`, confirm pass. Commit.

### Task 6: `toNodeHandler` bridge

**Files:**
- Create: `packages/flowlet-server/src/node.ts`, `packages/flowlet-server/src/node.test.ts`
- Modify: `packages/flowlet-server/src/index.ts` (export)

- [ ] Write failing tests using a real `node:http` server wrapping a stub fetch handler: method/url/headers/body translate into the `Request`; JSON response translates back; a streaming `ReadableStream` response (SSE content type) arrives incrementally, not buffered; abort on client disconnect cancels the stream.
- [ ] Confirm fail, implement the bridge (Node 18+ web streams; no new dependencies).
- [ ] Run tests, confirm pass. Commit.

### Task 7: `examples/node`

**Files:**
- Create: `examples/node/server.mjs`, `examples/node/package.json`, `examples/node/vite.config.ts`, `examples/node/index.html`, `examples/node/src/` (client, cloned from the `examples/basic` pattern), `examples/node/README.md`
- Reference: `examples/basic/` for the Vite client shape; `packages/flowlet-cli/dist/assets/` for the sandbox runtime assets story

- [ ] Build the ~30-line `node:http` server: mounts `toNodeHandler(createFlowletFetchHandler())` under `/api/flowlet/`, statically serves `public/flowlet/` sandbox assets (document where they come from; copy them in a postinstall or checked-in step consistent with how quickstart describes `flowlet init`).
- [ ] Build the Vite React client from the `examples/basic` pattern with a dev-server proxy for `/api/flowlet` to the Node server port.
- [ ] README: run instructions, then the two variants as short documented snippets only (Express one-liner via `toNodeHandler`, Hono/Bun mounting the fetch handler directly).
- [ ] Wire `pnpm --filter @flowlet/example-node dev` scripts; verify the app boots and chat answers locally with `ANTHROPIC_API_KEY` set. Commit.

### Task 8: CLI provider resolution

**Files:**
- Modify: `packages/flowlet-cli/src/llm.ts`, its tests, `packages/flowlet-cli/src/next-wiring.ts` (only if `.env.example` text lives there; find the emitter with `grep -rn "ANTHROPIC_API_KEY" packages/flowlet-cli/src`)

- [ ] Write failing tests: the CLI model factory resolves from any of the three keys with the same precedence and `FLOWLET_MODEL`/`FLOWLET_CLI_MODEL` overrides; returns null (skip LLM steps, deterministic rescues) when nothing resolves.
- [ ] Implement by reusing the resolver. Preferred: import `resolveModelChoice`/`resolveModel` from `@flowlet/server`; the CLI bins are vite-bundled, so mark `@ai-sdk/*` and `@flowlet/server` external or verify the bundle keeps dynamic imports intact. Known gotcha (ENG-197): some workspace dists are not Node-loadable from the CLI bundle. If that bites, fall back to a small duplicated resolver in `llm.ts` with a comment naming `@flowlet/server/src/model.ts` as the source of truth.
- [ ] Update the generated `.env.example` content to the new ladder (any provider key = chat; OPENAI adds voice; COMPOSIO adds integrations).
- [ ] Run `pnpm --filter @flowlet/cli test typecheck` and confirm pass. Rebuild the CLI and smoke `node packages/flowlet-cli/dist/cli.js init --help`. Commit.

### Task 9: Docs

**Files:**
- Modify: `docs/quickstart.md`, `CLAUDE.md` (commands section only if scripts changed)

- [ ] Quickstart: update the capability-ladder table (any provider key -> chat + generated UI; OPENAI also voice flag; COMPOSIO integrations), document `FLOWLET_MODEL` both forms and the optional-peer install hint, add a "Not using Next.js?" section pointing at `@flowlet/server`, `toNodeHandler`, and `examples/node`.
- [ ] Commit.

### Task 10: Verification (gates the PR)

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all green at repo root.
- [ ] Live browser check 1: `examples/node` with only `ANTHROPIC_API_KEY` set; chat plus a generated view render; screenshot.
- [ ] Live browser check 2: same app with only `OPENAI_API_KEY` set (and `@ai-sdk/openai` installed); capabilities reports chat true, chat answers, generated view renders; screenshot. Also confirm the missing-peer error message by running once without `@ai-sdk/openai` installed.
- [ ] Regression check: demo-bank (`pnpm demo`) still works zero-config with the Anthropic key (its `@flowlet/next` surface must be unchanged); note the default model is now `claude-sonnet-5`.
- [ ] CLI check: run `flowlet init` against the demo-bank ground truth with only an OpenAI key; compare extraction output to the Anthropic baseline; fix or document divergences.
- [ ] Invoke superpowers verification-before-completion before claiming done.

### Task 11: PR

- [ ] Push branch `yousefh409/provider-agnostic-core`, open a PR titled "feat: provider-agnostic core + @flowlet/server framework-agnostic handler" linking the spec, with both screenshots embedded. Never merge; Yousef merges.
