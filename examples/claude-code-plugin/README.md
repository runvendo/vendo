# The Vendo plugin for Claude Code

Two files and one skill. That is the whole plugin, and it is deliberate: the
MCP door already projects the product's tools verbatim, so a plugin has nothing
to implement. What it adds is **judgment** — teaching an outside agent *when* an
answer wants to be looked at rather than read, and how to ask.

| File | What it is |
| --- | --- |
| [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | the manifest |
| [`.mcp.json`](.mcp.json) | the connection — one remote HTTP MCP server, the product's door |
| [`skills/make-a-screen/SKILL.md`](skills/make-a-screen/SKILL.md) | when and how to call `vendo_make` |

No door code, no second tool surface, no client. `vendo_make` and every host
tool arrive through the door's own `tools/list`.

## Install

```bash
# in Claude Code, from anywhere
/plugin marketplace add runvendo/vendo
/plugin install vendo@vendo
```

Point it at your deployment (the default is a local `pnpm --filter demo-bank dev`):

```bash
export VENDO_MCP_URL=https://app.example.com/api/vendo/mcp
```

## Signing in

Nothing to configure. The door answers an unauthenticated request with the
RFC 9728 protected-resource challenge, so Claude Code runs the standard OAuth
flow itself — dynamic client registration, PKCE, your product's own login and
consent page. You are the user you signed in as, and every tool call is judged
by your product's policy, parked for your own approval, and audited under your
subject.

Revoke it the way you revoke anything else: the door's client list is per
subject, and a revoked client's bearer stops working on its next request.

## What Claude Code can then do

```
> what did I spend on travel last quarter?
```

It calls the product's read tools and answers in text.

```
> make me something I can watch my travel spend on
```

It calls `vendo_make` with a plain-language request, gets back a one-line
receipt, and says it. The screen itself never touches the conversation — it
arrives on your own page in the product, on a channel the agent is not on. That
separation is the point: pixels go server → slot, words go to the agent.

## The skill's job

An agent that has `vendo_make` in its tool list will still use it wrongly: for
answers that were one sentence, with numbers it computed pasted into the
request, or by inventing a description of a screen it never saw. The skill is
the fix for all three, and it is one screen of text because it gets read
mid-conversation.
