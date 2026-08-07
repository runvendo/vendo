---
"@vendoai/apps": patch
---

Replace the RFC-6901 JSON Pointer writer in `open.ts` with a direct assignment
under the query's name. The pointer was always `"/" + query.name`, and both
producers of a query name (`validateTree` and the wire compiler) hold it to
`/^[A-Za-z_][A-Za-z0-9_]*$/`, so no separator, escape or index could ever
reach it. The prototype defence stays, as an own-property define — the same
8-line shape `ui/src/tree/mcp-shim/shim-core.ts` already ships.
