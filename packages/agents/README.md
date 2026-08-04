# @vendoai/agents

Spawn a governed, harness-grade agent in any Node backend in a few lines. One
runtime, always host-run; a Vendo Cloud key fills every slot left unset — an
explicit adapter always wins, and there is no hidden key-conditional behavior.

```ts
import { agent, tool, api, createGuard, e2b, postgres, s3 } from "@vendoai/agents";
import { claudeCode } from "@vendoai/agents/harnesses";

const support = agent({
  name: "support",
  harness: claudeCode({ model: "claude-sonnet-5" }),
  tools: [api(), tool({ name: "refund", risk: "write", inputSchema, execute })],
  mcp: [{ url: "https://mcp.example.com", headers: { authorization: "…" } }],
  skills: ["./skills/product-docs"],
  egress: ["api.stripe.com"],
  store: postgres(process.env.DATABASE_URL, { blobs: s3({ /* … */ }) }),
  sandbox: e2b({ apiKey: process.env.E2B_API_KEY }),
  instructions: "Answer as the Acme support desk.",
});

const session = await support.session("u_42", {
  user: { name: "Dana", plan: "pro" },     // server-trust, model-visible
  context: { helpers() { /* … */ } },       // guard/tools only
  headers: req.headers,                     // present-user auth forwarding
});
session.on("approval", (req) => req.approve());
const response = await session.stream("Refund invoice #7");
```

Every tool call passes the guard (`run` / `ask` / `block`); the dev's risk
label is final and an unlabeled tool asks. Unset slots resolve down the
ladder: store → Cloud tenant Postgres (`VENDO_API_KEY`) or the embedded
zero-config store; sandbox → `E2B_API_KEY` or the Cloud pool. Egress binds at
box boot from host code only — a list adds to the harness's minimum, `"all"`
lifts it, and every box boot writes one audit row saying which skin it got.
