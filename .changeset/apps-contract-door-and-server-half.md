---
"@vendoai/core": major
"@vendoai/apps": major
"@vendoai/actions": major
"@vendoai/store": major
"@vendoai/mcp": major
"@vendoai/ui": major
---

App generation moves into one package, behind two doors

`@vendoai/apps` now has a browser-safe **contract door** and a node-only
**engine root**. The app format — the document, the two genui dialects and their
compilers, the Kit, the island/jail rules, catalog + theme, the checking
contract, remix provenance, and the wire shapes `/apps/*` returns — lives on
`@vendoai/apps/contract`, which imports no node built-ins. The behavior that
produces those shapes stays behind `@vendoai/apps`.

**Migration:**

1. **Moved `@vendoai/core` names are a hard rename** — import them from
   **`@vendoai/apps/contract`**: the genui dialect (`validateTree`, `compileWire`,
   `compilePlan`, `printWire`, the expression grammar), the Kit, the
   island/jail rules, catalog + theme, `AppFloor`/`Check`/`CheckInput`,
   `ScreenAssembler`, `MakeReceipt`, host components, and build deadlines.
   Types reaching you through `@vendoai/vendo` or the `vendoai` alias are
   **unchanged** — the umbrella re-exports the contract beside core.
   `@vendoai/apps` is ESM-only, so `require()` of these *values* needs ESM or
   the umbrella.
   `AppDocument` and its schemas, and `Finding`, deliberately **stay in
   `@vendoai/core`** (the store contract and the harness runtime speak them);
   the contract door re-exports them, so one door serves every consumer.

2. **Subpaths — what moved and what did not.** Entry points go 8 → 4:
   - **`@vendoai/apps`, `@vendoai/apps/e2b` and `@vendoai/apps/testing` all
     survive with their specifiers unchanged.** `./e2b` stays because the venue
     ladder reaches it as a real module seam, not merely a convenience re-export.
   - `@vendoai/apps/{sandbox-ladder,internal}` **fold into `@vendoai/apps`** —
     import those names from the root.
   - `@vendoai/apps/adapter-conformance` → **`@vendoai/apps/testing`**, not the
     root: it imports `vitest`, and the root rides every composed host's server
     path.
   - `@vendoai/apps/claude-turn` → **`@vendoai/harnesses/claude-turn`** and
     `@vendoai/apps/box-door` → **`@vendoai/harnesses/box-door`** (both moved with
     `claudeCode()`).
   - **NEW:** `@vendoai/apps/contract`.

3. **`@vendoai/ui`, `@vendoai/store`, `@vendoai/actions` and `@vendoai/mcp` now
   depend on `@vendoai/apps`** and read the app format from
   `@vendoai/apps/contract`. Their own public surfaces are unchanged.

**Known tradeoffs, stated plainly:**

- **One name, still two declarations.** `@vendoai/ui` no longer keeps its own
  copy of the `/apps/*` wire shapes — it re-exports them from the contract
  door. That removes a copy; it does not yet make one definition. The engine's
  server door declares its own richer `EditResult` (with `failure`,
  `graduated`, `box`, `pendingEgress`, `automation`) beside the contract's
  four-field wire shape, so the name has two declarations inside
  `@vendoai/apps`, one per door. Unifying them decides which fields the wire
  may expose, which is a behavior change and not part of this move.
- **Install weight.** `@vendoai/apps` declares `esbuild`, `jsdom`, `fflate` and
  `react-dom` as hard dependencies, so a browser-only consumer of
  `@vendoai/apps/contract` still installs the engine's dependency set. The
  contract door itself bundles clean for a browser target (enforced by a new
  leg in `scripts/portability-gate.mjs`); it is the install graph, not the
  bundle, that carries the weight. Pre-existing, amplified by this split.
