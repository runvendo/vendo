---
"@vendoai/agents": minor
"@vendoai/actions": minor
---

A hand-authored tool may declare its result shape, and an MCP server's is no
longer dropped on the way in.

`ToolDescriptor.outputSchema` has been read on three prompt surfaces for a while
— the apps shape brief, the automation planner, the screen agent's tool brief —
and every one of them prints "result shape unknown — pass the whole output
through; do not bind to guessed field names" when it is absent. Two producers
never supplied it, so for their tools that sentence was always the answer:
`tool()`, where the host knows the shape exactly and had nowhere to say it, and
the inbound MCP connector, which parsed a server's `tools/list` entry and threw
the advertised `outputSchema` away. A generated screen over either could not bind
to a field until something had called the tool once and read the rows back.

- **`tool({ …, outputSchema })`** (`@vendoai/agents`) takes the shape as JSON
  Schema and puts it on the descriptor. Omitted, the key is absent rather than
  `undefined`, so the unknown-shape sentence still prints.
- **`mcpConnector`** (`@vendoai/actions`) keeps whatever the server advertised,
  by the same rule its `inputSchema` already follows: an object survives,
  anything else is not a schema and is ignored.

Advisory in both cases. Nothing validates a result against the declared shape —
a schema that has drifted from the code makes the model's expectations wrong,
which is recoverable, where a checked one would fail a tool that works.
