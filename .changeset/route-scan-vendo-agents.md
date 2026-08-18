---
"@vendoai/actions": patch
---

Route extraction recognises Vendo's own backend library as an agent loop.

The exclusion that keeps a host's agent endpoint out of the callable catalog knew
every OTHER framework — `ai`, `@ai-sdk/*`, `@mastra/*`, the umbrella's own
ai-sdk and mastra entries — and missed `@vendoai/agents`. Its call marker was
anchored on the literal receiver `vendo.respond(`, which nobody writes when their
agent is called `support`. So a route running `agent()` or `support.respond(…)`
became a callable tool and was handed back to the agent hosted in it.

`@vendoai/agents` joins the recognised imports, and `.respond(` / `.run(` now
match on any receiver. The escape hatch is unchanged: the tool is emitted
`disabled: true` with the reason on it, and one `"disabled": false` in
`.vendo/overrides.json` puts it back. The predicate is exported so `vendo init`
can recommend the agent-loop use case off the same evidence rather than a second
copy of the regex.
