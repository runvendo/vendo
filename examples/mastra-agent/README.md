# Mastra agent + Vendo

This is the unmodified [`create-mastra`](https://mastra.ai/docs) weather-agent
starter, fronted with Next.js per Mastra's own guide (`@mastra/ai-sdk` →
`useChat` + AI SDK UI), **plus a four-touch Vendo diff** (~60 lines). Your
agent keeps its own loop, model, and UI — Vendo adds, through that same loop:

1. **Guarded host actions** — every `vendo_*` call routes policy → approval →
   audit (`vendo_send_trip_report` here asks for approval before "sending").
2. **Generated UI in your chat** — `vendo_create_app` returns fast with an
   app ref; the build streams into `<VendoAppEmbed>` over the Vendo wire.
3. **Whole-task delegation** — `vendo_delegate` hands Vendo's own agent a task.

Docs: the "Use with your existing agent" section of the Vendo docs site.

## The four touches

| Touch | File | What it does |
| --- | --- | --- |
| 1 | `src/lib/vendo.ts` (+ `src/lib/vendo-actions.ts`, `.vendo/tools.json`) | One `createVendo` call: cautious policy + two host actions — `get_weather` (read; generated apps query it for live data) and the risky `send_trip_report` (write; exercises approvals) |
| 2 | `src/app/api/vendo/[...vendo]/route.ts` | The stock Vendo wire route (what `vendo init` scaffolds) |
| 3 | `src/mastra/agents/weather-agent.ts` | `tools: async () => ({ weatherTool, ...(await vendoMastraTools(vendo)) })` |
| 4 | `src/app/page.tsx` (+ 2 lines in `src/app/api/chat/route.ts`) | `<VendoProvider>` wrap + `<VendoToolResult output>` per tool part; the principal set server-side on Mastra's `RequestContext` |

Everything else is the starter (`src/mastra/**` is `mastra init`'s output —
only the agent file carries the marked diff) plus the guide's chat route and a
plain `useChat` page. All Vendo lines are marked with `// VENDO` comments.

Notes on the seam:

- `vendoMastraTools(vendo)` returns a **Promise** (the pack enumerates the
  live registry), which is why the agent uses Mastra's tools-as-function form.
- A Mastra agent definition is static, so the shim resolves the caller's
  principal per call from the request context key `vendo-principal`
  (`VENDO_PRINCIPAL_KEY`); a call without one fails closed. The chat route
  sets it server-side — never trust the client for identity.

## Run it

```bash
pnpm install
cp .env.example .env   # add OPENAI_API_KEY (the starter agent's model)
pnpm dev               # http://localhost:3000
```

App generation resolves a model key from the environment independently
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `VENDO_API_KEY`) — two models,
deliberately: your agent keeps its model, Vendo's `model` seam powers
generation and the delegate.

## Demo script

1. "What's the weather in Paris?" — the starter's own `weatherTool`, untouched.
2. "Make me a dashboard comparing weather in Paris, Tokyo and NYC" — the agent
   calls `vendo_create_app`; the app builds live inline in the chat.
3. "Email the report to ops@example.com" — `vendo_send_trip_report` parks on
   the cautious policy; an approval card renders inline; approving executes
   the parked call in place.

## Tests

`pnpm test` runs the fixture e2e (`e2e/vendo-seam.e2e.test.ts`): hermetic
(scripted models, temp store), it drives a real Mastra agent turn through the
pack — approval park → wire approve → parked call executes → the wire serves
the `executed` state the embed renders — plus the app-ref envelope from a real
generation, delegation, and the fail-closed principal check.

## Workspace adaptations

Two pins differ from a fresh scaffold, so the example lives in this monorepo:
`zod` stays on `^3` (workspace-wide peer resolution; every Mastra package here
accepts it), and `ai`/`@ai-sdk/react` are pinned to a current release because
`@mastra/core`'s loop requires `ai >= 6.0.182`. A standalone scaffold
installing latest versions needs neither pin.

One starter deviation: the agent's model is `openai/gpt-4.1-mini` instead of
the scaffolded `openai/gpt-5-mini` — multi-turn tool use with GPT-5 reasoning
models currently fails on history replay
([mastra-ai/mastra#9005](https://github.com/mastra-ai/mastra/issues/9005));
gpt-4.1-mini is the workaround those issues document.
