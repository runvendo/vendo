---
"@vendoai/actions": patch
---

The agent is not one of its own tools. Route extraction was cataloging the
endpoints that RUN the agent — the host's own `/api/chat` loop, a Vendo wire
mount branded onto the host's own path, Auth.js's sign-in catch-all — so a
synced host handed the model a tool that calls the model, a catch-all whose
blast radius is everything Vendo exposes, and a callable `host_auth_create`.

Vendo's own wire mount is now recognized by the `nextVendoHandler(` call, not
only by the `/api/vendo` path convention, so a host that mounted the handler
somewhere else no longer ships a live catch-all onto Vendo itself. It yields no
tool, exactly as before — but the drop is no longer silent: sync prints a line
naming the route.

Routes the HOST owns are treated differently, because the reading can be wrong.
A handler that runs a model loop (`ai`, `@anthropic-ai/sdk`, `@ai-sdk/*`,
`@mastra/*`, `@vendoai/vendo/ai-sdk`, `/mastra`, or a `streamText` /
`generateText` / `vendoTools` / `vendo.respond` call) and an authentication
handler (`[...nextauth]`, `next-auth`, `@auth/core`, `NextAuth(`) still produce
their tools — with their real bindings and risk, `disabled: true`, and the
reason on the tool. Sync prints one line per excluded route naming the route,
the reason, and the way back: set that tool's `"disabled": false` in
`.vendo/overrides.json` and it is callable again. No new flag, no new question.

Markers are read from every module the verb walk already reads, so the
`export { GET, POST } from "@/auth"` shape Auth.js's own docs scaffold is caught
with the rest. Ordinary CRUD routes are untouched, including one that imports a
type from `@vendoai/vendo/server`.
