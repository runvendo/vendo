# AI SDK agent + Vendo

This is the **unmodified [AI SDK Next.js quickstart chatbot](https://ai-sdk.dev/docs/getting-started/nextjs-app-router)**
(`useChat` + `streamText` + the weather tool) **plus the lines below** — the
four-touch Vendo diff that gives an existing AI SDK agent guarded host actions,
generated UI, and approvals inside its own chat.

Docs guide: *Use with your existing agent → AI SDK* on the Vendo docs site.

## The diff

Every added line is fenced with `--- vendo` / `--- /vendo` markers, so you can
grep the whole integration:

| Touch | File | What it is |
| --- | --- | --- |
| 1 | [`lib/vendo.ts`](lib/vendo.ts) | `createVendo` + the two host actions it guards: the quickstart's weather lookup (now `host_get_weather`, risk `read`) and a deliberately risky `sendTripReport` (`host_send_trip_report`, risk `write` — parks for approval). Descriptors live in [`.vendo/tools.json`](.vendo/tools.json), exactly where `vendo init` extracts them in a real app. |
| 2 | [`app/api/vendo/[...vendo]/route.ts`](app/api/vendo/%5B...vendo%5D/route.ts) | The stock wire route. It serves apps and approvals to the embeds — "Vendo minus the conversation". |
| 3 | [`app/api/chat/route.ts`](app/api/chat/route.ts) | One spread: `...(await vendoTools(vendo, { principal }))` from `@vendoai/vendo/ai-sdk`. Your loop, your model — plus `vendo_host_*` (guard-wrapped host actions), `vendo_create_app`, and `vendo_delegate`. |
| 4 | [`app/page.tsx`](app/page.tsx) | `<VendoProvider>` around the chat and one `dynamic-tool` case that hands tool outputs to `<VendoToolResult>` — app-ref envelopes render the inline app embed, approval-ref envelopes render the approval card, plain data renders nothing. |

Plus one config line ([`next.config.ts`](next.config.ts)):
`serverExternalPackages: ["esbuild", "@electric-sql/pglite"]` keeps Vendo's
native/wasm modules out of the bundler. The only starter code that *moved* is
the weather tool's `execute` body — from an inline `tool()` in the chat route
into `lib/vendo.ts`, so the lookup runs through policy → approval → audit like
everything else the agent can touch.

Two models, deliberately: your agent keeps its own model in `/api/chat`;
`createVendo({ model })` powers app generation and the delegate.

## Run it

```bash
# from the repo root
pnpm install && pnpm build

# the demo has no auth; every session is the same demo user (lib/vendo.ts)
echo 'ANTHROPIC_API_KEY=sk-ant-…' > examples/ai-sdk-agent/.env.local

pnpm --filter @vendoai-examples/ai-sdk-agent dev
```

Open http://localhost:3000.

## Demo script

All three value props in one thread:

1. **"What's the weather in Paris?"** — normal tool use. The model calls
   `vendo_host_get_weather`; the guard runs it (risk `read` under the
   `cautious` policy), audits it, and returns plain data the model narrates.
2. **"Make me a dashboard comparing the weather in Paris, London and Tokyo."**
   — the model calls `vendo_create_app`, gets a `vendo/app-ref@1` envelope back
   immediately, and the app **builds inline** in `<VendoAppEmbed>` while the
   build streams over the wire.
3. **"Email that trip report to boss@example.com."** — the model calls
   `vendo_host_send_trip_report`; the guard parks it and returns a
   `vendo/approval-ref@1` envelope, which renders as an **approval card**.
   Click **Approve** — the wire executes the parked call and the card resolves
   in place to the executed result. (Deny resolves to "declined"; walking away
   expires it on the parked-call TTL.)

## Tests

`pnpm test` runs the hermetic fixture e2e
([`e2e/byo-agent.e2e.test.ts`](e2e/byo-agent.e2e.test.ts)): one real
`streamText` turn per value prop over a real `createVendo` composition — a
guarded action returning plain data, `vendo_create_app` returning the app-ref
envelope with the wire serving the built app, and the full approval
park → approve → execute round trip. Both model seams are scripted, so no keys
are needed.
