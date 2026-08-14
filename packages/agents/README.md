# @vendoai/agents

Spawn a governed, harness-grade agent in any Node backend in a few lines. One
runtime, always host-run; a Vendo Cloud key fills the sandbox slot when you
leave it unset — an explicit adapter always wins, and there is no hidden
key-conditional behavior.

```ts
import { agent, tool, api, createGuard, e2b, postgres } from "@vendoai/agents";
import { claudeCode } from "@vendoai/harnesses/claude-code";

const support = agent({
  name: "support",
  harness: claudeCode({ model: "claude-sonnet-5" }),
  tools: [api(), tool({ name: "refund", risk: "write", inputSchema, execute })],
  mcp: [{ url: "https://mcp.example.com", headers: { authorization: "…" } }],
  skills: ["./skills/product-docs"],
  egress: ["api.stripe.com"],
  store: postgres(process.env.DATABASE_URL),
  sandbox: e2b({ apiKey: process.env.E2B_API_KEY }),
  door: { baseUrl: "https://app.example.com" }, // where the box dials back
  instructions: "Answer as the Acme support desk.",
});

// `claudeCode()` thinks on a machine, so it reaches your tools by dialling this
// agent's MCP door. A library cannot add a route to your server — mount it.
// (Next.js app router: `app/api/vendo/mcp/route.ts`.)
export const POST = support.door!;   // mount at DOOR_PATH — "/api/vendo/mcp"

const session = await support.session("u_42", {
  user: { name: "Dana", plan: "pro" },     // server-trust, model-visible
  context: { helpers() { /* … */ } },       // guard/tools only
  headers: req.headers,                     // present-user auth forwarding
  threadId: req.body.threadId,             // omit to start a new conversation
});
session.on("approval", (req) => req.approve());
const response = await session.stream("Refund invoice #7");
// Send `session.threadId` back to the client; it is what reopens this
// conversation on the next request.
```

`respond()` is that pair — `session()` then `stream()` — in one call, for a
route that only wants the Response back:

```ts
export async function POST(req: Request) {
  const { message, threadId } = await req.json();
  return support.respond("u_42", message, { threadId, headers: req.headers });
}
```

`run()` answers CODE rather than a screen: one unattended turn, a report at the
end. Nobody is there to tap, so a call the guard wants a person for parks as a
card instead of running — `refs.approvals` is who to ask, and there is no
resume: answer them and run again.

```ts
const running = support.run("Chase every invoice over 30 days.", {
  as: "u_42",                               // whose run it is; omit to run as the agent
  maxToolCalls: 20,                         // default 20; the call past it is refused
  output: z.object({ chased: z.number() }), // optional typed answer, no second model call
});
console.log(running.threadId);              // readable before the run finishes
for await (const event of running.events) console.log(event);   // text, status, calls

const report = await running;
// status "ok" | "stopped" | "error", summary, toolCalls, usage, output,
// refs: { threadId, approvals }.
```

A session is a REQUEST-lifetime object — the conversation it is on outlives
it, in your store. Build one per request and pass `threadId` back in, or the
next request starts a blank conversation. Omitting `threadId` opens a new
one; a `threadId` that is not this subject's is a `not-found` error, never a
silent new conversation. `session.threadId` is the id to hand your client.

Every tool call passes the guard (`run` / `ask` / `block`); the dev's risk
label is final and an unlabeled tool asks. Unset slots resolve down the
ladder: store → the embedded zero-config store, or the Cloud hosted store with
`VENDO_API_KEY` set (an explicit `store` always wins);
sandbox → the Cloud pool with `VENDO_API_KEY`, else a boot error naming both
ways out. `E2B_API_KEY` is not a rung — it is the credential an explicit
`sandbox: e2b()` reads, so a key in the shell can no longer flip which venue a
deployment runs on. Egress binds at
box boot from host code only — a list adds to the harness's minimum, `"all"`
lifts it, and every box boot writes one audit row saying which skin it got.

## The tool door

A harness that thinks OUTSIDE this process — `claudeCode()` on either leg —
cannot hold your guard-bound registry, so it reaches the same `turn.tools` by
dialling back to an MCP door this package mounts for it. That needs two things
from you:

- **an origin it can reach.** `door: { baseUrl }`, or `VENDO_BASE_URL`; explicit
  always wins. A `machine: "local"` thinker needs neither: it falls back to a
  loopback listener this package serves itself, since a subprocess can always
  dial 127.0.0.1. For a SANDBOXED harness, setting neither is a boot error, not
  a quiet degrade — without an origin the model keeps its own workspace hands
  and loses every one of your tools, and it would answer politely while doing
  nothing.
- **a route.** Mount `support.door` at `DOOR_PATH` (exported; `/api/vendo/mcp`), the same
  mount `createVendo` uses. The handler serves nothing but a live turn's own
  credential: no OAuth surface, no discovery, no listing for anyone else. The
  credential states nothing and grants nothing — it is a pointer at "the turn in
  flight on thread T", minted only from inside such a turn and dead the moment
  it ends. The door's hostname joins the box's egress allowlist automatically.
