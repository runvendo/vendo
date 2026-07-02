# One Box: consolidate all generated UI into the sandbox

**Goal:** One output invariant — every piece of AI-*generated* UI renders in the locked sandbox. Pre-built components are just a library the AI references inside a generated view; they are not a separate output path. Remove the in-process single-component renderer and the loose raw-HTML iframe.

**Decisions locked (from discussion):**
- One content tool: `render_view` (emits a generated view). `render_ui` (single in-process component) is removed.
- One renderer: the sandbox (`SandboxStage`). Nothing AI-generated renders in-process anymore.
- Raw-HTML "app" path (`HtmlApp`, loose iframe) is **dropped**. Generated React components already cover arbitrary interactive UI (games included); JSX-authoring ergonomics is a separate later follow-up.
- **Connect is the one principled exception:** the Composio OAuth connect card needs host privileges (popup, chat context, window events) the sandbox denies, so it stays host-rendered — but behind its own explicit, narrow affordance, not the general component renderer.

## End state
- The agent has one UI-content tool, `render_view`, plus a narrow `request_connect` affordance for the privileged OAuth card.
- `render-node.tsx`: `kind:"generated"` → `SandboxStage`; a `Connect` request → host-rendered `DemoConnectCard`. No in-process component impls, no `App`/HtmlApp branch.
- Pre-built components render only inside the sandbox (they're in the sandbox host bundle already).
- Deleted: `render-tool.ts` (render_ui), `HtmlApp.tsx`, the in-process impl/App branches in render-node, related engine registration/exports/tests.

## Tasks

### Task 1: Make render_view the only content tool
- Remove `render_ui` registration + `RENDER_TOOL_NAME` from the engine; delete `render-tool.ts` and its test; drop the export from the agent barrel.
- Shell: `RENDER_TOOLS` set becomes just `render_view` (keep it a set for clarity).
- Update engine/shell tests to the single-tool reality.
- Verify: agent + shell suites green.

### Task 2: Connect as an explicit privileged affordance
- Add a narrow agent tool `request_connect({ toolkit, reason? })` that emits a recognizable connect node (e.g. `{ kind:"connect", toolkit, reason }` or a minimal component node the host special-cases).
- `render-node.tsx`: render that node with the existing `DemoConnectCard` (host-side). Keep the OAuth flow exactly as-is.
- Remove the old `name:"Connect"` render_ui path.
- Verify: connect flow still triggers DemoConnectCard.

### Task 3: Collapse render-node to one renderer
- `render-node.tsx`: keep only two branches — the Connect affordance (Task 2) and `kind:"generated"` → `SandboxStage`. Remove the in-process `impls[node.name]` branch and the `App`/HtmlApp branch.
- Delete `HtmlApp.tsx`.
- Remove now-unused imports (`prewiredImpls`, `coerceProps`/`rawProps` if only used by removed branches, `HtmlApp`).
- Verify: build + demo tests; no dangling imports.

### Task 4: Rewrite the demo agent prompt
- `agent.ts` `buildInstructions()`: instruct the agent to ALWAYS use `render_view`. Remove all `render_ui`, `name:"App"` raw-HTML, and `name:"Connect"` guidance. Explain: emit one generated view; reference pre-built components by name as building blocks; write novel components (React.createElement) when the catalog can't express it; a single component is just a one-node view. Point the connect need at `request_connect`.
- Verify: agent tests green; prompt has no stale tool references.

### Task 5: Verify end-to-end + docs
- Full: `pnpm build`, `pnpm test` (only the known-unrelated orders.test.ts failure allowed), `pnpm --filter @flowlet/stage test:browser` (all pass).
- Live/visual: render a view through the box (existing gates + screenshot); confirm a single pre-built component now renders inside the sandbox (not in-process).
- Docs: update README + demo README to describe the single-output model; move the raw-HTML/JSX note to "future".

## Out of scope (follow-ups)
- Host-side JSX compilation so novel components author as easily as HTML.
- A server-side approval token for the action route.
- Perf tuning if per-view iframe mount latency matters.
