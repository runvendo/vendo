---
"@vendoai/actions": minor
"@vendoai/vendo": minor
---

Any REST API with a spec becomes agent tools. `openApiConnector({ spec, baseUrl,
headers, name })` takes an OpenAPI document — JSON or YAML text, or an
already-parsed object — and hands the agent one guarded tool per operation,
named `openapi_<name>_<operationId>`.

It brings nothing new to do it. The document goes through the SAME extractor
`vendo sync` runs over a spec in your repo, so path parameters, query
parameters, the JSON request body and the declared response schema arrive
exactly as they would from `.vendo/tools.json` — and risk comes from the method,
`DELETE` destructive and everything else `ungraded` until something authorized
grades it. The call then executes through the SAME HTTP dispatch a host tool
executes through. A spec behaves identically whichever door it comes in, which
is the point: there is no second code path to keep in step.

`spec` is the document, never a path and never a URL. Reading and fetching stay
the caller's business, so the connector works on every runtime and no argument
of it can be steered into a request.

Two factorings paid for that sharing, and together they delete far more than
they add. `extractOpenApi`'s document half is the pure `openapi-document.ts`
now, with `sync/openapi.ts` keeping node:fs and the spec-file entry points — the
connector could not import from `sync/`, whose graph carries the TypeScript
compiler the portability gate forbids in a Worker bundle outright. And
`registry.ts`'s HTTP leg — argument binding, path substitution, the tRPC
envelope, the fetch, the JSON envelope — is `runtime/http-dispatch.ts`, used by
the registry and the connector both.

`headers` takes static headers or a per-call resolver, the shape `mcpConnector`
already had. That resolver's context was never MCP's, so it is
`ConnectorAuthContext` now; `McpAuthContext` and `McpHeadersResolver` keep
working as deprecated aliases of the connector-wide names.

Both connectors are exported from `@vendoai/vendo/server` — and so from
`vendoai/server` — so bringing an outside API in is one import from the
umbrella, and both are documented at `/capabilities/connectors`, which is
`mcpConnector`'s first page.
