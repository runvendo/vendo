---
"@vendoai/vendo": patch
---

`vendo.agentTools` — one method for an agent loop you wrote yourself.

A host on the AI SDK or Mastra gets `vendoTools(vendo)` and is done. A host
driving `messages.create` by hand had to write about seventy lines first: mint a
badge, stand up an MCP client and a transport, map the tool format, keep ONE
session for the whole conversation (the door pins a parked approval to the
session that parked it, so a per-request reconnect parks forever), re-mint when
the ten minutes run out, and collect the typed envelopes the page renders. None
of that is a decision a host wants to make.

```ts
const door = await vendo.agentTools(request); // or a user id, same as tokenFor

while (true) {
  const reply = await anthropic.messages.create({ tools: door.tools, messages, ... });
  messages.push({ role: "assistant", content: reply.content });
  const results = await door.results(reply);
  if (results.length === 0) break;          // the model called nothing: done
  messages.push({ role: "user", content: results });
}
// door.embeds — the approval refs and app refs this conversation produced
```

`tools` is already the shape `messages.create` takes and `results` is already
the shape you push back, with no import from `@anthropic-ai/sdk` on either side
and nothing for you to annotate. `is_error` rides along; a parked call comes
back as the sentence the model should read, and its typed
`vendo/approval-ref@1` lands in `embeds` — read from `structuredContent`, never
from the prose.

In-process, like `tokenFor`: every call rides `vendo.handler`, so a deployment
never has to be able to reach itself over the network, and a path-prefixed
deployment works unchanged.
