# Provider-Agnostic Core + Framework-Agnostic Handler

**Date:** 2026-07-04
**Status:** Approved by Yousef (brainstorm session, provider-agnostic-core worktree)
**Scope:** Two Tier-1 OSS-release gaps from the 2026-07-04 feature audit: (A) BYO-any-provider in the zero-config path, (B) a non-Next server handler.

## Problem

1. **Provider-agnosticism is half-true.** `options.model` accepts any ai-SDK `LanguageModel`, but the zero-config default (`world.ts` `defaultModel()`) is hardcoded to `@ai-sdk/anthropic`, and the `chat` capability flag (`capabilities.ts`) is gated on `ANTHROPIC_API_KEY` presence. An adopter injecting an OpenAI model gets a working POST /chat but `GET /capabilities` reports `chat:false`, so the client hides chat. The 2026 market bar (CopilotKit, assistant-ui, Vercel AI SDK, Tambo) makes BYO-any-provider table stakes.
2. **Next-only reads as lock-in.** Only `@flowlet/next` exists as a server adapter. The handler core is already fetch-native (`Request -> Response`); the market bar is a framework-agnostic core with Next as the first adapter.

## Decisions (with Yousef)

| Decision | Ruling |
| --- | --- |
| Env scope | Multi-provider via env: provider-prefixed `FLOWLET_MODEL` plus key-based auto-detect |
| Key ladder | A key is a credential: `OPENAI_API_KEY` alone lights up chat (on OpenAI) AND the voice flag |
| CLI | Fully in scope, with its own per-provider verification pass |
| Packaging | New `@flowlet/server` package; `@flowlet/next` becomes a thin adapter |
| Reference adapter | Plain `node:http` bridge + `examples/node`; Express is a documented one-liner, Hono mounts the fetch handler directly |
| Anthropic default | Bump to `claude-sonnet-5` (pinnable back via `FLOWLET_MODEL=claude-sonnet-4-6`) |

## Part A: Provider resolution and capability keys

### Resolution order (`resolveModel(env)`, replaces `defaultModel()`)

1. `options.model` injected in code: wins, used as-is.
2. `FLOWLET_MODEL` env var, two forms:
   - `provider/model` (e.g. `openai/gpt-5.5`, `google/gemini-3.5-flash`, `anthropic/claude-sonnet-5`)
   - bare model id (e.g. `claude-sonnet-4-6`), applied to the auto-detected provider. Backwards compatible with today's usage.
3. Nothing set: auto-detect by key presence, precedence **Anthropic > OpenAI > Google**, per-provider defaults:
   - `ANTHROPIC_API_KEY` -> `claude-sonnet-5`
   - `OPENAI_API_KEY` -> `gpt-5.5`
   - `GOOGLE_GENERATIVE_AI_API_KEY` -> `gemini-3.5-flash`

Exact OpenAI/Google default ids are re-verified against provider docs at implementation time. Key env-var names follow the ai-SDK provider conventions so the SDKs need no extra plumbing.

### Dependencies

- `@ai-sdk/anthropic` stays a regular dependency of `@flowlet/server` (primary path stays zero-friction).
- `@ai-sdk/openai` and `@ai-sdk/google` are optional peer dependencies, loaded by dynamic `import()` only when resolved to. Missing package fails boot loudly with an actionable install hint (e.g. `run: npm i @ai-sdk/openai`). No silent fallback to another provider.

### Capability semantics (the bug fix)

- `chat` = model injected via `options.model` OR any recognized provider key present. `detectCapabilities` gains a `hasInjectedModel` input so `GET /capabilities` and POST /chat always agree.
- Ladder: any provider key -> chat + generated UI; `OPENAI_API_KEY` additionally sets the voice flag; `COMPOSIO_API_KEY` -> integrations. A missing key still never errors; the capability reads false and the client hides that surface.
- Existing Anthropic-only installs see zero behavior change.
- Keys are still never validated at boot; an invalid key fails at first model call (unchanged).

### Automations

The resolved model feeds `createAutomationsWorld` (agent-step runner), so automations are provider-agnostic with no separate work.

## Part B: `@flowlet/server` and the non-Next path

### New package `packages/flowlet-server`

- Moves the framework-agnostic handler core out of `@flowlet/next`: chat, action, integrations, capabilities, world, options, guard, flowlet-dir, manifest-tools, agent, default-policy, connections, plus the new provider-resolution module. All already fetch-native; semantics unchanged.
- Public API:
  - `createFlowletFetchHandler(options)` returning one `(req: Request) => Promise<Response>` that routes on the sub-path (chat, action, integrations, capabilities, tick).
  - `toNodeHandler(fetchHandler)`: a small streaming-safe bridge from Node `(IncomingMessage, ServerResponse)` to fetch `Request`/`Response`. SSE chat streaming must flow through it. Express mounting becomes one line; Hono/Bun/Deno pass the fetch handler directly.
- The optional `@ai-sdk/openai` / `@ai-sdk/google` peers live here.

### `@flowlet/next` becomes a thin adapter

Depends on `@flowlet/server`; keeps its exact current public API (`createFlowletHandler` returning `{GET, POST}`, plus the `/client` entry). Next users see zero change. The `@flowlet/runtime` dependency-guard allowlist is untouched.

### Example `examples/node`

- A ~30-line `node:http` server using `createFlowletFetchHandler` + `toNodeHandler`, including serving the sandbox assets from `public/flowlet/` (the one thing Next served implicitly; the example must show it).
- A Vite React client following the `examples/basic` pattern, proxying `/api/flowlet` to the Node server.
- README documents the Express one-liner and the Hono/Bun direct-mount variants.

## Part C: CLI (`flowlet init`)

- `flowlet-cli/src/llm.ts` adopts the same provider resolution: any of the three keys (or `FLOWLET_MODEL`) drives the extractor's LLM steps. Deterministic rescues unchanged when no key resolves.
- Extractor prompts were tuned on Claude, so this gets its own verification pass: run `flowlet init` against demo-bank ground truth with an OpenAI key; fix or document structured-output differences.
- `.env.example` output updated to the new key ladder.

## Testing and verification

- Unit: provider-resolution matrix (each key alone, multiple keys, both `FLOWLET_MODEL` forms, missing-peer-dep error), capability detection with injected model, node bridge including streaming.
- The existing `@flowlet/next` test suite passes unchanged (proves the extraction broke nothing for Next users).
- Live browser verification of `examples/node` (chat + generated UI) with (a) Anthropic key only and (b) OpenAI key only; screenshots in the PR per repo rules.
- Docs: quickstart gains a "Not using Next?" section; the capability-ladder table is updated.

## Out of scope

- Publishing to npm (ENG-198).
- Providers beyond the big three (any other ai-SDK provider still works via `options.model`).
- Voice UX (the flag semantics only).
- Multi-tenant or durable persistence (separate audit tier).
