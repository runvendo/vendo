# Standalone agent

The `@vendoai/agents` quickstart, whole. One package, three short files:

| File | What it is |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | `agent()` with a name, instructions, and one `tool()` |
| [`src/chat.ts`](src/chat.ts) | one turn, printed in the terminal |
| [`src/server.ts`](src/server.ts) | the same agent mounted on an HTTP server |

Nothing else is configured. No store, no sandbox, no harness, no `vendo init`,
no CLI. Left unset, the agent thinks in this process and persists its threads
and audit rows automatically, so these three files are the whole project.

## Run it

```bash
pnpm install && pnpm build

# the one line that gives the agent a brain
cd examples/standalone-agent
npx vendoai@latest login          # mints VENDO_API_KEY into .env.local, never prints it

pnpm chat
```

`.env.local` is a Next.js convention and nothing in `@vendoai/agents` reads it,
so the `chat` and `start` scripts pass it to Node themselves
(`node --env-file-if-exists=.env.local …`). Exporting `VENDO_API_KEY` in your
shell works just as well.

The agent calls `order_status`, reads the row, and answers in its own words.
Verbatim, on 2026-08-19:

```
$ node --env-file-if-exists=.env.local dist/chat.js
[vendo] model: VENDO_API_KEY (Vendo Cloud) → vendo via the Cloud gateway
Order A-1001 has shipped and is expected to arrive by August 21, 2026. Let me know if you'd like more details!
```

`order_status` is graded `risk: "read"`, which is why that turn ran straight
through. Leave `risk` off and the tool is ungraded, which the guard asks a
person about every time — the first `chat()` would come back `interrupted` with
nothing run.

`VENDO_API_KEY` is the shortest path to a model. To bring your own instead,
pass one to `agent()` and the key is not needed at all:

```ts
import { anthropic } from "@ai-sdk/anthropic";

agent({ name: "support", model: anthropic("claude-sonnet-4-6") });
```

Either way the key is only read when a turn runs — building and typechecking
this example needs nothing.

## Over HTTP

```bash
pnpm --filter @vendoai-examples/standalone-agent start
```

```bash
curl -N http://localhost:3000/api/agent/threads \
  -H 'content-type: application/json' \
  -d '{"message":"Where is order A-1002?"}'
```

The response is an AI SDK UI message stream and the conversation's id comes
back on `x-vendo-thread-id`. Send that id back as `threadId` to keep talking on
the same thread. `GET /api/agent/threads` lists this user's threads;
`GET /api/agent/threads/:id` reads one back.

In a browser, `useVendoChat` from `@vendoai/ui` speaks to this mount directly:

```tsx
const { messages, sendMessage, interruptions, resume } = useVendoChat({
  api: "/api/agent",
});
```
