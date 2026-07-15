# @vendoai/actions

Every API becomes agent tools, executed as the signed-in user. Contract: `docs/contracts/04-actions.md` (FROZEN). Depends on `@vendoai/core` only.

Two halves:

- **Sync (build step)** — `vendoSync({ root, out?, strict? })` extracts tools (OpenAPI spec if present, plus a Next.js route scan; the spec wins on overlapping method+path) into `.vendo/tools.json` (`vendo/tools@1`), respects human-written `.vendo/overrides.json` (`vendo/overrides@1`) forever, captures remixable component baselines into `.vendo/remixable/<slot>.json`, and reports added/removed/changed tools, breaking changes, pins, and machine-readable `unresolvedPins`. Static pin resolution follows default, named/aliased, and namespace imports through named barrel re-export chains. A valid runtime baseline or an explicit `.vendo/overrides.json` `remix.ignoreSlots` entry resolves the slot; otherwise the CLI exits non-zero. Extraction is fail-closed: unclassifiable routes are emitted `disabled: true` with a note, route-scanned tools are never labeled `read`, and `critical` is only ever set by overrides.
- **Runtime** — `createActions({ dir | tools, connectors, actAs, baseUrl, fetch })` returns an `ActionsRegistry` (a core `ToolRegistry` plus `add()`). Present-mode calls forward the inbound session's auth material (`ctx.requestHeaders`) on a same-origin fetch; away-mode calls require the host `actAs` seam and a captured grant. Connectors (`composioConnector`, `mcpConnector`) re-describe external tools through the same descriptor shape.

## Contract judgment calls (flagged for cross-block review)

- **Away-mode grant channel**: `ToolRegistry.execute(call, ctx)` has no grant parameter, but `actAs(principal, grant)` needs the matched grant. Convention: the guard binding (the only sanctioned caller, 05 §2) attaches it as `ctx.grant` — see the exported `ActionsRunContext` type. Away calls without a grant return a `validation` error outcome.
- **`OpenApiBinding.method`/`path`**: the contract names `operationId` + `baseUrl`; we additionally persist `method` and `path` so the runtime can execute without re-reading the spec. Additive fields; consumers ignore unknown keys (01 §15).
- **`SyncReport.warnings`**: additive field carrying fail-soft extraction warnings (the contract's "default fail-soft warn" channel).
- **`vendoSync` strict mode** throws `VendoError("conflict", …, { breaking, report })` *after* writing artifacts; the umbrella bin maps it to exit 2 (09 §5).
- **`tools.json` stays pure extraction output**; overrides are merged at read time (sync report + runtime), so re-extraction never touches human answers and `descriptorHash` is always computed post-merge.
- **`createActions.dir`** accepts either the host root (reads `<dir>/.vendo/…`) or a `.vendo` directory itself.
- **Overrides schema is strict** (unknown fields rejected): it is a hand-written file, and a typo silently ignored would be a policy hole.

## Testing

`pnpm --filter @vendoai/actions test`. The extraction and execution e2e suites run against `fixtures/host-app` (deterministic, seeded); the execution suite boots the fixture's real Next server and signs in for a session cookie. Connector suites use in-process stub servers. The core conformance kit (`@vendoai/core/conformance`) runs against the registry.

## Known v0 limitations

- Route discovery uses comment-stripped regex and structural scanning, not a TypeScript/JavaScript AST.
- Input narrowing detection is top-level only. It covers required/property/type changes, enum reduction or addition, and tightening `additionalProperties` from absent/`true` to `false`; it is not a recursive JSON-Schema compatibility checker.
- OpenAPI inputs include path and query parameters only (plus parameters with no `in` value). Header/cookie transport and `style`/`explode` serialization are not supported.
- Catch-all route parameters are represented as one required argument whose value may be a string or an array; array elements become individually encoded path segments.
- `composioConnector` accepts an additive `baseUrl` configuration seam for deterministic stub and self-hosted endpoint use.
