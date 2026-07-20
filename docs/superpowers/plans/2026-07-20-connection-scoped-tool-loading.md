# Connection-Scoped Tool Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop loading the full Composio catalog (4,002 tools); load full schemas only for toolkits the current user has connected, keep every connectable toolkit discoverable via a cheap index, and seed the agent's initial loadout from connected toolkits instead of alphabetical junk.

**Architecture:** Two tiers — a deployment-global discovery index (~56 toolkit entries with descriptions) and per-toolkit lazily-expanded full descriptors. The registry grows append-only (global memoization preserved: expansion busts `loadedPromise` exactly like the existing `add()`); per-USER scoping lives purely in the agent's per-turn loadout seed and search results. Search hits on an unexpanded toolkit expand it on the fly and materialize new tools into the live ToolSet mid-turn (`prepareStep` already re-reads active names each step).

**Tech Stack:** TypeScript monorepo (pnpm + turbo + vitest), ai SDK v5 dynamicTool, Composio REST v3, Next.js console (vendo-web).

**Spec:** `docs/superpowers/specs/2026-07-20-connection-scoped-tool-loading-design.md`

**Branches:** flowlet work on `yousefh409/connection-scoped-tools` (cut from `origin/main`; cherry-pick the spec commit and the demo-bank connectors-slot fix from `vendo-cloud-e2e`). Console work on vendo-web `yousefh409/catalog-descriptions` (cut from `origin/main`).

---

### Task 0: Branches + carry-over commits

**Files:** none (git only)

- [ ] **Step 1: flowlet branch**

```bash
cd /Users/yousefh/orca/workspaces/flowlet/connections
git fetch origin -q
git stash push -u -m "wip" 2>/dev/null || true
git checkout -b yousefh409/connection-scoped-tools origin/main
git cherry-pick <spec-commit-sha>       # "spec: connection-scoped tool loading (approach B)" from vendo-cloud-e2e
git stash pop 2>/dev/null || true       # restores the demo-bank connectors-slot edit if stashed
git add docs/superpowers/plans/2026-07-20-connection-scoped-tool-loading.md apps/demo-bank/src/vendo/server.ts
git commit -m "plan + demo-bank: leave connectors slot unset without a Composio key (cloud default composes)"
```

- [ ] **Step 2: vendo-web branch**

```bash
cd /Users/yousefh/orca/workspaces/vendo-web
git fetch origin -q && git checkout -b yousefh409/catalog-descriptions origin/main
```

---

### Task 1: Live-probe Composio toolkit descriptions (evidence before code)

**Files:** none (probe only; result decides Task 7 parsing)

- [ ] **Step 1: probe the toolkits metadata endpoint**

```bash
KEY=$(grep -h "COMPOSIO_API_KEY=" /Users/yousefh/orca/workspaces/flowlet/vendo-w1-bench/.env | cut -d= -f2 | tr -d "'\"")
curl -s "https://backend.composio.dev/api/v3/toolkits?limit=5" -H "x-api-key: $KEY" | python3 -m json.tool | head -60
curl -s "https://backend.composio.dev/api/v3/toolkits/gmail" -H "x-api-key: $KEY" | python3 -m json.tool | head -40
```

Expected: items carrying a slug plus a human description field (`meta.description`, `description`, or similar). Record the exact field path; Tasks 2 and 7 parse it. If no description field exists anywhere, both tasks fall back to `undefined` descriptions plus the static blurbs in Task 2 Step 3.

---

### Task 2: Connector interface + Composio lazy mode (packages/actions)

**Files:**
- Modify: `packages/actions/src/connectors/connector.ts`
- Modify: `packages/actions/src/connectors/composio.ts`
- Create: `packages/actions/src/connectors/composio-lazy.test.ts`

- [ ] **Step 1: interface additions** (`connector.ts`, after `ConnectorCatalogEntry`)

```ts
/** One toolkit in the discovery index: always searchable, never executable on
 * its own. `description` is load-bearing for recall ("send email" must match
 * gmail), so implementations enrich from provider metadata with a static
 * fallback. */
export interface ToolkitIndexEntry {
  toolkit: string;
  label?: string;
  description?: string;
}
```

And on `Connector` (after `connections?`):

```ts
  /** Optional: the lazily-loaded discovery index — one entry per connectable
   * toolkit. Present only on connectors that defer full schema loading. */
  discoveryIndex?(): Promise<ToolkitIndexEntry[]>;
  /** Optional: fetch + include the named toolkits' full descriptors in the
   * next descriptors() read. Returns true when anything NEW was expanded (the
   * registry then invalidates its load memo). Unknown toolkits are ignored. */
  expandToolkits?(toolkits: string[]): Promise<boolean>;
```

- [ ] **Step 2: failing tests first** (`composio-lazy.test.ts` — reuse the `startServer` harness from `composio-catalog.test.ts` verbatim)

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { composioConnector } from "./composio.js";

// startServer + closers: copy from composio-catalog.test.ts (same 20 lines).

/** Stub: auth_configs (page-numbered, lying next_cursor), per-toolkit tools,
 * and toolkits metadata with descriptions. */
function lazyStub() {
  let toolFetches: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://stub");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v3/auth_configs") {
      res.end(JSON.stringify({
        items: [
          { id: "ac_gmail", toolkit: { slug: "gmail" }, status: "ENABLED" },
          { id: "ac_slack", toolkit: { slug: "slack" }, status: "ENABLED" },
        ],
        total_items: 2, next_cursor: null,
      }));
      return;
    }
    if (url.pathname === "/api/v3/toolkits") {
      res.end(JSON.stringify({
        items: [
          { slug: "gmail", name: "Gmail", meta: { description: "Send and read email with Gmail" } },
          { slug: "slack", name: "Slack", meta: { description: "Post messages to Slack channels" } },
        ],
        total_items: 2, next_cursor: null,
      }));
      return;
    }
    if (url.pathname === "/api/v3/tools") {
      const tk = url.searchParams.get("toolkit_slug")!;
      toolFetches.push(tk);
      res.end(JSON.stringify({ items: [{
        slug: `${tk.toUpperCase()}_DO_THING`, toolkit_slug: tk,
        description: `${tk} tool`, input_parameters: { type: "object" },
      }] }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  };
  return { handler, toolFetches: () => toolFetches };
}

describe("composio lazy mode (no apps)", () => {
  it("loads NOTHING eagerly: descriptors() is empty and no /tools fetch happens", async () => {
    const stub = lazyStub(); const server = await startServer(stub.handler); closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });
    await expect(connector.descriptors()).resolves.toEqual([]);
    expect(stub.toolFetches()).toEqual([]);
  });

  it("serves the discovery index with provider descriptions", async () => {
    const stub = lazyStub(); const server = await startServer(stub.handler); closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });
    await expect(connector.discoveryIndex!()).resolves.toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
    ]);
  });

  it("expands only requested, connectable toolkits and caches per toolkit", async () => {
    const stub = lazyStub(); const server = await startServer(stub.handler); closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });
    await expect(connector.expandToolkits!(["gmail", "not-a-toolkit"])).resolves.toBe(true);
    const names = (await connector.descriptors()).map((d) => d.name);
    expect(names).toEqual(["gmail_GMAIL_DO_THING"]);
    // second expand of the same toolkit: no new work, no refetch
    await expect(connector.expandToolkits!(["gmail"])).resolves.toBe(false);
    expect(stub.toolFetches()).toEqual(["gmail"]);
    // executing an expanded tool dispatches through the normal path
    // (normalizedToRaw must be rebuilt on each descriptors() read)
  });

  it("apps mode is unchanged: eager, exactly those apps, index mirrors apps", async () => {
    const stub = lazyStub(); const server = await startServer(stub.handler); closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url, apps: ["gmail"] });
    const names = (await connector.descriptors()).map((d) => d.name);
    expect(names).toEqual(["gmail_GMAIL_DO_THING"]);
    await expect(connector.discoveryIndex!()).resolves.toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
    ]);
  });
});
```

- [ ] **Step 3: run to verify failure** — `pnpm --filter @vendoai/actions exec vitest run src/connectors/composio-lazy.test.ts` → FAIL (`discoveryIndex` undefined; descriptors walks the catalog).

- [ ] **Step 4: implement in `composio.ts`**

Inside `composioConnector`, above the `return`:

```ts
  const lazy = config.apps === undefined;
  const expandedToolkits = new Set<string>();
  const toolkitToolCache = new Map<string, Promise<ComposioTool[]>>();
  let indexPromise: Promise<ToolkitIndexEntry[]> | undefined;
  let connectableSlugsPromise: Promise<Set<string>> | undefined;

  function toolkitTools(toolkit: string): Promise<ComposioTool[]> {
    let p = toolkitToolCache.get(toolkit);
    if (!p) { p = fetchTools(toolkit); toolkitToolCache.set(toolkit, p); }
    return p;
  }

  /** Toolkit metadata (name + description) from /api/v3/toolkits — page-numbered
   * pagination exactly like auth_configs (walk cursor=1,2,… vs total_items).
   * Parse path per Task 1 probe; STATIC_BLURBS fallback, else undefined. */
  async function toolkitMeta(): Promise<Map<string, { label?: string; description?: string }>> { /* walk + parse */ }

  const STATIC_BLURBS: Record<string, string> = {
    gmail: "Send, read, and manage email with Gmail",
    googlecalendar: "Create and manage Google Calendar events",
    slack: "Post messages and interact with Slack channels",
    github: "Manage GitHub repos, issues, and pull requests",
    notion: "Create and edit Notion pages and databases",
    linear: "Create and manage Linear issues",
  };

  async function buildIndex(): Promise<ToolkitIndexEntry[]> {
    const meta = await toolkitMeta().catch(() => new Map());
    const slugs = config.apps ?? (await listConnectable()).map((e) => e.toolkit);
    return slugs.map((toolkit) => ({
      toolkit,
      ...(meta.get(toolkit)?.label ? { label: meta.get(toolkit)!.label } : {}),
      ...((meta.get(toolkit)?.description ?? STATIC_BLURBS[toolkit])
        ? { description: meta.get(toolkit)?.description ?? STATIC_BLURBS[toolkit] } : {}),
    }));
  }
```

Replace the `descriptors()` body's app-filter line: `const appFilters = config.apps === undefined ? [undefined] : config.apps;` becomes

```ts
      const appFilters = lazy ? [...expandedToolkits] : config.apps!;
      if (appFilters.length === 0) { normalizedToRaw = new Map(); return []; }
      const pages = await Promise.all(appFilters.map((app) => toolkitTools(app)));
```

(the full-catalog `[undefined]` walk is deleted — lazy mode never bulk-fetches). Add to the returned connector object:

```ts
    discoveryIndex: () => (indexPromise ??= buildIndex()),

    async expandToolkits(toolkits) {
      if (!lazy) return false;
      connectableSlugsPromise ??= (async () => new Set((await listConnectable()).map((e) => e.toolkit)))();
      const connectable = await connectableSlugsPromise;
      let changed = false;
      for (const toolkit of toolkits) {
        if (!connectable.has(toolkit) || expandedToolkits.has(toolkit)) continue;
        expandedToolkits.add(toolkit);
        changed = true;
      }
      return changed;
    },
```

- [ ] **Step 5: run tests green** — same command → PASS. Also `pnpm --filter @vendoai/actions test` (whole package; the old "unscoped walk" expectations in existing composio tests get updated here if any assert the `[undefined]` full walk).

- [ ] **Step 6: commit** — `git commit -m "actions: composio lazy mode — discovery index + per-toolkit expansion, no full-catalog walk"`

---

### Task 3: Registry expansion, loadout seed, index-aware search (packages/actions)

**Files:**
- Modify: `packages/actions/src/runtime/registry.ts`
- Create: `packages/actions/src/runtime/registry-expansion.test.ts`

- [ ] **Step 1: failing tests** (`registry-expansion.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import type { Connector } from "../connectors/connector.js";
import { createActions } from "./registry.js";

/** A lazy fake: index of 2 toolkits, per-toolkit tools materialize on expand. */
function lazyConnector() {
  const expanded = new Set<string>();
  const connector: Connector = {
    name: "composio",
    descriptors: async () => [...expanded].map((tk) => ({
      name: `${tk}_${tk.toUpperCase()}_SEND`, description: `send via ${tk}`,
      inputSchema: {}, risk: "write" as const,
    })),
    execute: async (call) => ({ status: "ok", output: { ran: call.tool } }),
    discoveryIndex: async () => [
      { toolkit: "gmail", description: "Send and read email with Gmail" },
      { toolkit: "slack", description: "Post messages to Slack channels" },
    ],
    expandToolkits: async (tks) => {
      let changed = false;
      for (const tk of tks) if (["gmail", "slack"].includes(tk) && !expanded.has(tk)) { expanded.add(tk); changed = true; }
      return changed;
    },
  };
  return connector;
}

const HOST_TOOL = { name: "host_listAccounts", description: "List the user's accounts", risk: "read" as const, input: [], bind: "listAccounts" };

function registry() {
  return createActions({ dir: "", tools: [HOST_TOOL], connectors: [lazyConnector()] });
}

describe("registry lazy expansion", () => {
  it("boots with host tools only; expansion grows descriptors AND dispatch", async () => {
    const actions = registry();
    expect((await actions.descriptors()).map((d) => d.name)).toEqual(["host_listAccounts"]);
    await actions.expandToolkits(["gmail"]);
    const names = (await actions.descriptors()).map((d) => d.name);
    expect(names).toContain("gmail_GMAIL_SEND");
    const outcome = await actions.execute(
      { id: "c1", tool: "gmail_GMAIL_SEND", args: {} },
      { principal: { kind: "user", subject: "u1" }, venue: "chat", presence: "present", sessionId: "s1" },
    );
    expect(outcome).toMatchObject({ status: "ok" });
  });

  it("loadoutSeed = host tools first, then ONLY the connected toolkits' tools", async () => {
    const actions = registry();
    const seed = await actions.loadoutSeed(["gmail"]);
    expect(seed[0]).toBe("host_listAccounts");
    expect(seed).toContain("gmail_GMAIL_SEND");
    expect(seed.join(",")).not.toContain("slack");
  });

  it("zero connections: seed is host tools only", async () => {
    await expect(registry().loadoutSeed([])).resolves.toEqual(["host_listAccounts"]);
  });

  it("search expands matching index toolkits and annotates results", async () => {
    const actions = registry();
    const matches = await actions.search("send an email");
    const gmail = matches.find((m) => m.name === "gmail_GMAIL_SEND");
    expect(gmail).toBeDefined();
    expect(gmail!.description).toContain("gmail");
    expect(gmail!.description).toMatch(/connect/i);
    // slack's index blurb doesn't match "email" → not expanded
    expect((await actions.descriptors()).map((d) => d.name)).not.toContain("slack_SLACK_SEND");
  });

  it("search with no index match behaves exactly as before", async () => {
    const matches = await registry().search("list accounts");
    expect(matches[0]!.name).toBe("host_listAccounts");
  });
});
```

- [ ] **Step 2: run to verify failure** — `pnpm --filter @vendoai/actions exec vitest run src/runtime/registry-expansion.test.ts` → FAIL (`expandToolkits`/`loadoutSeed` missing).

- [ ] **Step 3: implement in `registry.ts`**

Interface (top of file):

```ts
export interface ActionsRegistry extends ToolRegistry {
  add(tools: ToolRegistry): void;
  briefs(): Promise<CapabilityBrief[]>;
  search(query: string, options?: ToolSearchOptions): Promise<ToolSearchMatch[]>;
  /** Fetch + register the named lazy toolkits' tools (idempotent, global). */
  expandToolkits(toolkits: string[]): Promise<void>;
  /** The per-turn initial loadout: host/eager tools first, then the given
   * (connected) toolkits' tools — never an alphabetical slice of the catalog. */
  loadoutSeed(connectedToolkits: string[]): Promise<string[]>;
}
```

Inside `createActions`, next to `load()`:

```ts
  const MAX_SEARCH_EXPANSIONS = 3;
  let indexPromise: Promise<Array<{ toolkit: string; description?: string; label?: string }>> | undefined;

  function discoveryEntries() {
    indexPromise ??= (async () => {
      const lists = await Promise.all(connectors.map((c) => c.discoveryIndex?.() ?? Promise.resolve([])));
      return lists.flat();
    })();
    return indexPromise;
  }

  async function expand(toolkits: string[]): Promise<boolean> {
    if (toolkits.length === 0) return false;
    let changed = false;
    for (const connector of connectors) {
      if (connector.expandToolkits === undefined) continue;
      if (await connector.expandToolkits(toolkits)) {
        descriptorPromises.delete(connector);
        changed = true;
      }
    }
    if (changed) loadedPromise = undefined;   // same invalidation add() uses
    return changed;
  }
```

Public methods:

```ts
    async expandToolkits(toolkits) { await expand(toolkits); },

    async loadoutSeed(connectedToolkits) {
      await expand(connectedToolkits);
      const { descriptors: all, dispatch } = await load();
      const eager: string[] = []; const connected: string[] = [];
      for (const descriptor of all) {
        const entry = dispatch.get(descriptor.name);
        if (!entry) continue;
        const isLazyConnectorTool = entry.kind === "connector" && entry.connector.expandToolkits !== undefined;
        if (!isLazyConnectorTool) { eager.push(descriptor.name); continue; }
        if (connectedToolkits.some((tk) => descriptor.name.startsWith(`${tk}_`))) connected.push(descriptor.name);
      }
      return [...eager, ...connected];
    },

    async search(query, options) {
      // Rank the discovery index (toolkit-level pseudo-descriptors) and expand
      // the top matches BEFORE ranking tools, so an unloaded toolkit's tools
      // are findable by intent ("send email" → gmail).
      const index = await discoveryEntries();
      const expandedNames = new Set<string>();
      if (index.length > 0) {
        const pseudo = index.map((entry) => ({
          name: entry.toolkit,
          description: `${entry.label ?? entry.toolkit}: ${entry.description ?? ""}`,
          inputSchema: {}, risk: "read" as const,
        }));
        const toolkitHits = searchToolDescriptors(pseudo, query, { limit: MAX_SEARCH_EXPANSIONS });
        if (toolkitHits.length > 0 && await expand(toolkitHits.map((h) => h.name))) {
          for (const hit of toolkitHits) expandedNames.add(hit.name);
        }
        for (const hit of toolkitHits) expandedNames.add(hit.name);
      }
      const matches = searchToolDescriptors((await load()).descriptors, query, options);
      if (expandedNames.size === 0) return matches;
      return matches.map((match) => {
        const toolkit = [...expandedNames].find((tk) => match.name.startsWith(`${tk}_`));
        return toolkit === undefined ? match : {
          ...match,
          description: `${match.description} (part of the ${toolkit} toolkit — if the user hasn't connected ${toolkit}, calling this will prompt them to connect)`,
        };
      });
    },
```

- [ ] **Step 4: run green** — expansion tests + `pnpm --filter @vendoai/actions test` (registry/search/steps suites must stay green; `search.test.ts` and `registry` callers of the old 3-method interface may need the two new methods on hand-rolled `ActionsRegistry` mocks — add `expandToolkits: async () => {}, loadoutSeed: async () => []` where literals implement the interface).

- [ ] **Step 5: commit** — `git commit -m "actions: registry lazy expansion, loadoutSeed, index-aware search with connect annotation"`

---

### Task 4: Agent — seeded loadout + mid-turn materialization (packages/agent)

**Files:**
- Modify: `packages/agent/src/tool-search.ts`
- Modify: `packages/agent/src/tools.ts`
- Modify: `packages/agent/src/agent.ts` (~lines 463–480)
- Modify: `packages/agent/src/tool-search.test.ts` (add cases)

- [ ] **Step 1: failing tests** (append to `tool-search.test.ts`; follow that file's existing descriptor fixtures)

```ts
describe("seeded loadout", () => {
  const d = (name: string, risk: "read" | "write" = "read") =>
    ({ name, description: name, inputSchema: {}, risk }) as ToolDescriptor;

  it("seed wins over the risk/name fallback and is capped", () => {
    const descriptors = [d("vendo_apps_create"), d("aaa_JUNK"), d("gmail_SEND", "write"), d("host_list")];
    const loadout = computeInitialLoadout(descriptors, { search: async () => [], maxInitialTools: 2 }, ["host_list", "gmail_SEND", "missing_TOOL"]);
    expect([...loadout]).toEqual(["vendo_apps_create", "host_list", "gmail_SEND"]);
    expect(loadout.has("aaa_JUNK")).toBe(false);
  });

  it("explicit config.loadout still beats the seed", () => {
    const descriptors = [d("aaa_JUNK"), d("gmail_SEND")];
    const loadout = computeInitialLoadout(descriptors, { search: async () => [], loadout: ["aaa_JUNK"] }, ["gmail_SEND"]);
    expect([...loadout]).toEqual(["aaa_JUNK"]);
  });
});

describe("mid-turn materialization", () => {
  it("search results NOT in the built toolset resolve + materialize + load", async () => {
    const materialized: string[] = [];
    const session = createToolSearchSession({
      config: { search: async () => [{ name: "gmail_SEND", description: "send", risk: "write", score: 5 }] },
      descriptors: [],
      loaded: new Set(),
      resolve: async (names) => names.map((name) => ({ name, description: "send", inputSchema: {}, risk: "write" as const })),
      materialize: (descriptor) => { materialized.push(descriptor.name); },
    });
    const tools: ToolSet = {};
    session.attach(tools);
    const outcome = await (tools[VENDO_TOOLS_SEARCH_TOOL_NAME]! as { execute: Function }).execute({ query: "email" }, { toolCallId: "t1" });
    expect(materialized).toEqual(["gmail_SEND"]);
    expect(outcome.output.loaded).toEqual(["gmail_SEND"]);
    expect(session.activeToolNames()).toContain("gmail_SEND");
  });
});
```

- [ ] **Step 2: run to verify failure** — `pnpm --filter @vendoai/agent exec vitest run src/tool-search.test.ts` → FAIL.

- [ ] **Step 3: implement `tool-search.ts`**

`ToolSearchConfig` gains (import `RunContext` from core):

```ts
  /** Per-turn initial-loadout seed: typically the connected toolkits' tools
   * (umbrella wires this to registry.loadoutSeed(connected)). Runs BEFORE the
   * toolset is built so expanded tools are included. Never throws to the turn:
   * callers degrade to the risk/name fallback. */
  seed?: (ctx: RunContext) => Promise<string[] | undefined>;
```

`computeInitialLoadout(descriptors, config, seedNames?)` — insert between the explicit-loadout branch and the cap fallback:

```ts
  const cap = Math.max(Math.trunc(config.maxInitialTools ?? DEFAULT_MAX_INITIAL_TOOLS), 1);
  if (seedNames !== undefined) {
    const seeded = seedNames.filter((name) => available.has(name) && !isAlwaysActive(name)).slice(0, cap);
    return new Set([...alwaysActive, ...seeded]);
  }
```

`ToolSearchSessionOptions` gains:

```ts
  seedNames?: readonly string[];
  /** Full descriptors for names search returned that are NOT yet in the built
   * toolset (they were lazily expanded during search). */
  resolve?: (names: string[]) => Promise<ToolDescriptor[]>;
  /** Add a freshly resolved descriptor into the LIVE toolset (prepareStep
   * re-reads active names each step, so it's callable next step). */
  materialize?: (descriptor: ToolDescriptor) => void;
```

Session: `const initial = computeInitialLoadout(options.descriptors, options.config, options.seedNames);` and `available` becomes mutable. In the meta-tool execute, replace the loadable filter:

```ts
          const missing = matches.filter((match) => !available.has(match.name)).map((match) => match.name);
          if (missing.length > 0 && options.resolve !== undefined && options.materialize !== undefined) {
            try {
              for (const descriptor of await options.resolve(missing)) {
                options.materialize(descriptor);
                available.add(descriptor.name);
              }
            } catch { /* unresolved names simply stay unloadable */ }
          }
          const loadable = matches.filter((match) => available.has(match.name));
```

Meta-tool description — replace with:

```ts
        description:
          "Search ALL of this product's tools and connected-service tools by intent, and LOAD the matches so you can call them this run. "
          + "Results may include tools for services the user has NOT connected yet — calling one is safe and correct: the user is prompted to connect in-line. "
          + "Use this whenever no currently-available tool fits the ask.",
```

- [ ] **Step 4: `tools.ts` — extract the per-descriptor factory.** Move the entire `for (const descriptor of descriptors) { ... }` body into an exported function, and call it from the loop:

```ts
/** Build ONE guard-bound agent tool and insert it into `tools`. Exported so a
 * tool lazily expanded mid-turn (tool search) materializes with the exact
 * wrapper the boot-time toolset uses. */
export function addAgentTool(tools: ToolSet, descriptor: ToolDescriptor, options: ToolBridgeOptions): void {
  /* the existing loop body, verbatim, ending in tools[descriptor.name] = dynamicTool({...}) */
}

export async function buildAgentTools(options: ToolBridgeOptions): Promise<ToolSet> {
  const descriptors = await options.registry.descriptors();
  const tools: ToolSet = {};
  for (const descriptor of descriptors) addAgentTool(tools, descriptor, options);
  return tools;
}
```

- [ ] **Step 5: `agent.ts` wiring** (inside the turn, BEFORE `buildAgentTools`):

```ts
          // Connection-scoped loadout: resolve + expand the principal's
          // connected toolkits FIRST so the built toolset includes them; a
          // failed seed degrades to the risk/name fallback, never the turn.
          let seedNames: string[] | undefined;
          if (config.toolSearch?.seed !== undefined) {
            try { seedNames = await config.toolSearch.seed(input.ctx); }
            catch { seedNames = undefined; }
          }
          const bridgeOptions = {
            registry: config.tools, guard: config.guard, ctx: input.ctx, writer,
            toolOutputCap: config.context?.toolOutputCap,
            ...(missDetector === undefined ? {} : { onCall: missDetector.onCall }),
          };
          const tools = await buildAgentTools(bridgeOptions);
          missDetector?.attach(tools);
          const toolSearch = config.toolSearch === undefined ? undefined : createToolSearchSession({
            config: config.toolSearch,
            descriptors: await config.tools.descriptors(),
            loaded: loadedFor(thread.id),
            ...(seedNames === undefined ? {} : { seedNames }),
            resolve: async (names) => (await config.tools.descriptors()).filter((d) => names.includes(d.name)),
            materialize: (descriptor) => addAgentTool(tools, descriptor, bridgeOptions),
          });
```

(Note `missDetector` is created above this block today — keep declaration order; `bridgeOptions` replaces the current inline object passed to `buildAgentTools`.)

- [ ] **Step 6: run green** — `pnpm --filter @vendoai/agent test` (full package: conformance/approval/connect suites must not regress).

- [ ] **Step 7: commit** — `git commit -m "agent: seeded loadout from connected toolkits + mid-turn materialization of searched-in tools"`

---

### Task 5: cloudTools lazy mode (packages/vendo)

**Files:**
- Modify: `packages/vendo/src/cloud-tools.ts`
- Modify: `packages/vendo/src/cloud-tools.test.ts`

- [ ] **Step 1: failing tests** (extend the existing `consoleStub` harness)

```ts
  it("lazy mode (no apps): nothing eager, index from catalog, per-toolkit expansion", async () => {
    const fetched: string[] = [];
    const stub = consoleStub((url) => {
      if (url.includes("/connections/catalog")) return { body: { available: [
        { toolkit: "gmail", connector: "composio", description: "Send and read email with Gmail" },
        { toolkit: "slack", connector: "composio", description: "Post messages to Slack" },
      ] } };
      if (url.includes("/api/v1/tools?toolkits=")) { fetched.push(new URL(url).searchParams.get("toolkits")!); return { body: { tools: [GMAIL_TOOL] } }; }
      return { status: 404, body: {} };
    });
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });
    await expect(connector.descriptors()).resolves.toEqual([]);          // no bulk fetch
    await expect(connector.discoveryIndex!()).resolves.toEqual([
      { toolkit: "gmail", label: undefined, description: "Send and read email with Gmail" },
      { toolkit: "slack", label: undefined, description: "Post messages to Slack" },
    ].map(e => ({ toolkit: e.toolkit, ...(e.description ? { description: e.description } : {}) })));
    await expect(connector.expandToolkits!(["gmail"])).resolves.toBe(true);
    expect((await connector.descriptors()).map((d) => d.name)).toEqual(["gmail_GMAIL_SEND_EMAIL"]);
    expect(fetched).toEqual(["gmail"]);
    await expect(connector.expandToolkits!(["gmail"])).resolves.toBe(false); // cached
  });

  it("apps mode is unchanged (eager scoped fetch) and index mirrors apps", async () => { /* assert current behavior + index = apps */ });

  it("index fetch failure degrades to [] with one warn (never throws)", async () => { /* 503 catalog → discoveryIndex []  */ });
```

- [ ] **Step 2: verify failure**, then **Step 3: implement** — mirror Task 2's shape: `lazy = options.apps === undefined`; `descriptors()` unions per-toolkit cached fetches of `expandedToolkits` (empty → `[]`, and keep the existing degrade-never-throw on per-toolkit failures: warn + skip that toolkit); `discoveryIndex()` = cloudFetch `/api/v1/connections/catalog` → entries (`description` passes through when the console provides it — Task 7), degrade to `[]` + warn; `expandToolkits()` gates on the catalog's slugs, adds to the set, returns changed. Apps mode: eager `GET /api/v1/tools?toolkits=<apps>` at first `descriptors()` exactly as today.

- [ ] **Step 4: run green** — `pnpm --filter @vendoai/vendo exec vitest run src/cloud-tools.test.ts`.
- [ ] **Step 5: commit** — `git commit -m "vendo: cloudTools lazy mode — catalog-driven index, per-toolkit expansion, no bulk fetch"`

---

### Task 6: Umbrella wiring — per-turn seed from connections (packages/vendo)

**Files:**
- Modify: `packages/vendo/src/server.ts` (toolSearch block ~line 1151; add helper near `selectConnections`)
- Modify: `packages/vendo/src/server.test.ts` (rewrite the connectors-seam test for lazy semantics; add a seed-wiring test)

- [ ] **Step 1: failing test** (in `server.test.ts`, next to the connectors-seam test; reuse its stub-console + store scaffolding)

```ts
  it("seeds the loadout from the principal's connected toolkits over the cloud broker", async () => {
    // Stub console additionally serves /api/v1/connections (gmail active for
    // user_1, nothing for user_2), /api/v1/connections/catalog (gmail+slack
    // with descriptions), and /api/v1/tools?toolkits=gmail.
    // ... createServer stub as in the connectors-seam test ...
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    vi.stubEnv("VENDO_CLOUD_URL", `http://127.0.0.1:${port}`);
    const vendo = await compose({});
    // Boot surface is host+vendo tools only — the catalog is NOT bulk-loaded.
    const boot = (await vendo.actions.descriptors()).map((d) => d.name);
    expect(boot.some((n) => n.startsWith("gmail_"))).toBe(false);
    // Connected user: seed contains gmail tools; nothing alphabetical-junk.
    const seed = await vendo.actions.loadoutSeed(["gmail"]);
    expect(seed.some((n) => n.startsWith("gmail_"))).toBe(true);
    expect(seed.some((n) => n.startsWith("slack_"))).toBe(false);
    // Search discovers the UNCONNECTED toolkit by intent and annotates it.
    const matches = await vendo.actions.search("post a message to slack");
    const slack = matches.find((m) => m.name.startsWith("slack_"));
    expect(slack).toBeDefined();
    expect(slack!.description).toMatch(/connect/i);
  });
```

(The EXISTING connectors-seam test's assertion `autoNames contains gmail_GMAIL_SEND_EMAIL` changes to: boot descriptors are empty of connector tools; after `auto.actions.expandToolkits(["gmail"])` they contain it. Update in the same step.)

- [ ] **Step 2: verify failure**, then **Step 3: implement in `server.ts`** — inside `createVendo` after `const connections = selectConnections(...)` (move that line ABOVE the agent construction if needed, or reference via closure since turns run post-compose):

```ts
  // Connection-scoped loadout seed (spec 2026-07-20): per-subject connected
  // toolkits, cached briefly so a turn doesn't pay a broker round-trip.
  const CONNECTED_TOOLKITS_TTL_MS = 60_000;
  const connectedToolkitsCache = new Map<string, { at: number; toolkits: string[] }>();
  async function loadoutSeedFor(ctx: RunContext): Promise<string[]> {
    const subject = ctx.principal.subject;
    const cached = connectedToolkitsCache.get(subject);
    let toolkits: string[];
    if (cached !== undefined && Date.now() - cached.at < CONNECTED_TOOLKITS_TTL_MS) {
      toolkits = cached.toolkits;
    } else {
      try {
        const accounts = await connections.list(ctx.principal);
        toolkits = [...new Set(accounts.filter((a) => a.status === "active").map((a) => a.toolkit))];
      } catch (error) {
        console.warn("[vendo] connected-toolkits lookup failed; seeding host tools only:",
          error instanceof Error ? error.message : error);
        toolkits = [];
      }
      if (connectedToolkitsCache.size > 1_000) connectedToolkitsCache.clear();
      connectedToolkitsCache.set(subject, { at: Date.now(), toolkits });
    }
    return actions.loadoutSeed(toolkits);
  }
```

and in the agent's `toolSearch` config: `seed: (ctx) => loadoutSeedFor(ctx),`.

- [ ] **Step 4: run green** — `pnpm --filter @vendoai/vendo test` (all 66 files; the seam + store-precedence tests must hold; settle compositions via `/status` per the known teardown gotcha).
- [ ] **Step 5: commit** — `git commit -m "vendo: per-turn loadout seed from the principal's connected toolkits (cached, degrade-safe)"`

---

### Task 7: Console — catalog descriptions (vendo-web)

**Files:**
- Modify: `apps/console/lib/api/composio-client.ts` (add `listToolkitMeta`)
- Modify: `apps/console/lib/api/connections.ts` (catalog entries gain `description`)
- Modify: `apps/console/tests/connections.test.ts`

- [ ] **Step 1: failing test** — in the catalog describe block, the stub gains `/api/v3/toolkits` (page-numbered like auth_configs, descriptions per Task 1's probed field path) and the expectation becomes:

```ts
    expect(await response.json()).toEqual({
      available: [
        { toolkit: "gmail", connector: "composio", description: "Send and read email with Gmail" },
        { toolkit: "slack", connector: "composio", description: "Post messages to Slack channels" },
        { toolkit: "linear", connector: "composio" },   // no meta → no description field
      ],
    });
```

- [ ] **Step 2: verify failure**, then **Step 3: implement** — `listToolkitMeta(composio): Promise<Map<string, string>>` in `composio-client.ts` (same page-number walk as `listEnabledToolkits`, parse the probed description path, degrade to an empty map on failure); in `handleConnectionsCatalog`, merge: `available = toolkits.map((toolkit) => ({ toolkit, connector: "composio", ...(meta.get(toolkit) ? { description: meta.get(toolkit) } : {}) }))`; keep the 5-min cache around the merged result. Also add `description?: string` to the OSS `ConnectorCatalogEntry` (actions) and `ConnectableToolkit` (vendo + ui wire-types) so it flows end-to-end — dock ignores it.

- [ ] **Step 4: run green** — `pnpm --dir apps/console exec tsc --noEmit && pnpm --dir apps/console test`.
- [ ] **Step 5: commit + push + PR** — `git commit -m "console: catalog entries carry toolkit descriptions for the OSS discovery index"`; PR to vendo-web, CI, merge (deploy auto-runs).

---

### Task 8: Full gates (both repos)

- [ ] flowlet: `pnpm build && pnpm typecheck && pnpm lint && pnpm exec turbo run test --concurrency=1` (serialized — the parallel run flakes on known PGlite/port contention). Fix any fallout (doctor/status tool-count assertions are the likely candidates in lazy mode).
- [ ] vendo-web: covered in Task 7 Step 4.
- [ ] Commit any test-fallout fixes individually.

---

### Task 9: Offline e2e matrix (already largely covered; verify the full case list runs)

Cases and where they're asserted — confirm each is green, add any missing:

| Case | Where |
| --- | --- |
| Zero connections → seed = host tools only | Task 3 test 3 + Task 6 |
| Connected toolkit → seeded, executable, no junk | Task 3 tests 1–2, Task 6 |
| Search discovers UNCONNECTED toolkit by intent, annotated | Task 3 test 4, Task 6 |
| Search miss → behaves exactly as before | Task 3 test 5 |
| Mid-turn materialization (search → call same turn) | Task 4 session test |
| Seed capped at maxInitialTools (github-scale toolkit) | Task 4 loadout test |
| Explicit config.loadout precedence | Task 4 |
| BYO explicit `apps` unchanged | Task 2 test 4 |
| Lazy BYO (no apps, own key) | Task 2 tests 1–3 |
| Cloud lazy (no apps, VENDO_API_KEY) | Task 5 + Task 6 |
| Index/broker failure degrades, never bricks | Task 5 test 3 + Task 6 warn path |
| Expansion idempotent + cached | Tasks 2/3/5 |
| Catalog descriptions end-to-end | Task 7 |

---

### Task 10: Live e2e (browser, demo-bank on cloud posture) + evidence

Honor the memory rules: ONE dev server at a time; kill it and reap `.next` orphans after.

- [ ] Boot demo-bank exactly as the 2026-07-20 GIF run (VENDO_API_KEY = conformance org, ANTHROPIC key, no COMPOSIO key, port 4479).
- [ ] **Case B (connected user, yousef@maple.com):** gmail is already connected for this subject from the previous session. Ask "send an email to yousefh409@gmail.com …" → approval card → approve → sends WITHOUT a tools-search detour into asana/box. Verify Activity shows ONLY gmail + host tools. Screenshot.
- [ ] **Case A (zero-connection user, mia@maple.com):** same ask → agent uses `vendo_tools_search` → gmail discovered via the index → call → approval → connect-required → connect card renders. Screenshot. (Don't complete OAuth for mia — card rendering is the assertion.)
- [ ] **Case C (dock):** dock still lists the full 56-toolkit catalog (discovery unaffected). Screenshot.
- [ ] **Case D (app/automation):** re-run the "Maple Daily Balance Email" app's send (or ask the agent to send the summary now) as yousef → approval carries the composed summary → approve while the turn is live → email lands in Gmail Sent. Screenshot Sent folder.
- [ ] **Perf note:** record turn latency vs the 4,002-tool baseline (previous run: multi-minute turns; expect seconds).
- [ ] Kill the dev server, reap `.next` orphans (`pkill -f "next dev --port 4479"`, remove `apps/demo-bank/.next/dev` leftovers), screenshots → `docs/superpowers/evidence/2026-07-20-connection-scoped-tools/` (`git add -f`).

---

### Task 11: Docs, PR, memory

- [ ] `docs/connected-accounts.md`: replace the "the agent's connector tools load and execute through the same broker" sentence with the two-tier model (index always searchable; full tools load for connected toolkits; search prompts connect for the rest).
- [ ] flowlet PR: `gh pr create` on `yousefh409/connection-scoped-tools` with the case table + evidence screenshots; CI green (watch for the merge-ref/synchronize flakes — rebase to retrigger); merge per standing authorization.
- [ ] Update memory (`vendo-connect-dock-auto-catalog.md` or a new lane file): shipped state, the `prepareStep`-rereads-actives discovery, seed-TTL cache, and any new gotchas.
