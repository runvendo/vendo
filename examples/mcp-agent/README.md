# A stock AI SDK agent through the MCP door

[`agent.mjs`](agent.mjs) is the doors proof: **an agent with no Vendo code in its
process** asking a Vendo-equipped product to make its user a screen.

Three third-party packages and nothing else — `ai` for the loop,
`@ai-sdk/anthropic` for the model, `@modelcontextprotocol/sdk` for the
connection. `grep @vendoai agent.mjs` returns nothing, and that is the claim: an
outside agent needs no SDK, no adapter, and no integration to reach the product's
tools. It connects to the door, takes its `tools/list` verbatim, and hands the
whole thing to `streamText`.

Contrast with [`../ai-sdk-agent`](../ai-sdk-agent), which is the *other* door: an
agent running **inside** the host's own backend, spreading the guarded tool pack
into its loop with `@vendoai/vendo/ai-sdk`. Same `vendo_make`, same guard, same
audit — one door for your own agent, one for everyone else's.

## Run it

```bash
# 1. a live deployment (any Vendo host with `mcp: true`)
pnpm --filter demo-bank dev

# 2. the agent
export ANTHROPIC_API_KEY=sk-ant-…
export VENDO_MCP_URL=http://localhost:3000/api/vendo/mcp
node examples/mcp-agent/agent.mjs "make me something I can watch this month's spending on"
```

## What it prints

```
door     http://localhost:3123/api/vendo/mcp
bearer   vmat_EAqWt7p…  (the product's own OAuth: DCR, PKCE, login, consent)
listed   21 tools, including vendo_make

user     make me something I can watch this month's spending on

agent    → vendo_make({"request":"A spending dashboard for the current month showing total
           spend, a breakdown by category with amounts and progress bars, and a list of
           recent transactions. Keep it live so it updates as new transactions come in."})
         ← {"id":"app_790892b0…","title":"August Spending","status":"ready",
            "say":"August Spending is on your screen."}

         August Spending is on your screen! …

receipt  {"id":"app_790892b0…","title":"August Spending","status":"ready","say":"…"}

PASS — words to the agent, pixels to the product.
       the screen is at http://localhost:3123/vendo/apps  (app app_790892b0…)
```

Read that bottom line literally. The agent got four fields of words and narrated
them; it never received a tree, a component, a payload or a URL. The screen went
server → the product's own page, and this process never saw it. Open the app in
the product to look at it — the screen the agent cannot describe.

The script asserts the receipt law itself: if `tree`, `components`,
`componentTools`, `machine` or `snapshotRef` ever appeared in a receipt, it exits
non-zero and says which one.

## Two things it will do that are not bugs

**A read may park for approval.** Under a `cautious` policy an outside agent's
tool call is judged like any other, so the first `host_*` read comes back as
"approval `apr_…` is waiting in the product's queue". Approve it in the product
(the Vendo tab's approvals inbox) and run again — that is the perimeter working,
and the reason the door is not a bypass.

**`vendo_make` may answer `failed` and explain why.** The checks floor rejects a
screen whose bindings claim data the host does not return ("the binding sums
`spending.amount`, but the query returns `amount_cents`"). The agent gets that
sentence and can retry with a narrower request. A broken binding is a lie, and it
never reaches the person.

## Signing in

The `bearer()` function is the part a real MCP client does in a browser: Claude
Code, Cursor and ChatGPT open the door's authorize URL and the person signs in
and consents on the product's own pages. This script is headless, so it walks the
same redirects itself — discovery, dynamic client registration, PKCE S256, the
product's login, the door's consent page, code exchange.

If you are wiring a real client instead of a script, none of that is your code to
write. See [`../claude-code-plugin`](../claude-code-plugin) — it is a manifest, a
connection and a skill.
