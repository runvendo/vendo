import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, type AppPlan, type NormalizedCatalog } from "@vendoai/core";
import { isWorkerLoadablePath, resolveWorkerModulePaths, sampleFromShape, smokeRenderIslands } from "./generation/validation/smoke-render.js";
import type { GeneratedAppDocument } from "./generation/engine.js";
import { runIslandLane, type IslandLaneDeps } from "./generation/lanes.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/index.js";

/**
 * v4 wave — the smoke-render gate. Final gate 2026-07-21: two crash forms
 * shipped because nothing executed island code before ship — C11 (React
 * error #310: useState inside a client .map; the whole app rendered as an
 * error blob) and the broken-render class generally. Each island now renders
 * once, headless, against a stubbed ambient scope; a crash is a normal
 * validation issue routed to repair.
 *
 * Scope: CRASHES only (throw on render, hooks-order violations, undefined
 * names). Visual wrongness (M7's zero-bar chart) is data-shape territory —
 * deliberately out of scope here.
 */

const tools = [
  { name: "host_listClients", description: "List clients", risk: "read" as const },
  { name: "host_sendMessage", description: "Send a message", risk: "write" as const },
];

const toolShapes = {
  host_listClients: {
    kind: "object" as const,
    fields: {
      clients: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: {
            id: { kind: "string" as const },
            name: { kind: "string" as const },
            missingDocs: { kind: "number" as const },
          },
        },
      },
    },
  },
};

// The C11 shape: clients load through the ambient tools read, and each row
// mints its own useState INSIDE the .map — hook count grows when data lands,
// React #310 fires on the re-render.
const HOOKS_IN_MAP = `
export default function ClientContactCards() {
  const [clients, setClients] = useState([]);
  useEffect(() => {
    tools.host_listClients({}).then((res) => setClients(res.clients ?? []));
  }, []);
  return (
    <Stack>
      {clients.map((client) => {
        const [expanded, setExpanded] = useState(false);
        return (
          <Surface key={client.id}>
            <Text text={client.name} />
            <Button label="Details" onClick={() => setExpanded(!expanded)} />
            {expanded ? <Text text={client.id} /> : null}
          </Surface>
        );
      })}
    </Stack>
  );
}
`;

const HEALTHY = `
export default function ClientList() {
  const [clients, setClients] = useState([]);
  useEffect(() => {
    tools.host_listClients({}).then((res) => setClients(res.clients ?? []));
  }, []);
  if (clients.length === 0) return <Text text="Loading clients" />;
  return (
    <Stack>
      <Stat label="Clients" value={String(clients.length)} />
      <DataTable rows={clients.map((client) => ({ name: client.name, missing: client.missingDocs }))} />
    </Stack>
  );
}
`;

describe("isWorkerLoadablePath", () => {
  it("accepts absolute filesystem paths and rejects bundler externals wrappers", () => {
    // Live 2026-07-23 — under a Turbopack dev server, createRequire().resolve
    // returns an externals WRAPPER id instead of throwing; passing it to the
    // worker's plain require failed EVERY island-bearing app with a fake
    // island-crash issue. Wrappers must route to the next resolver / skip.
    expect(isWorkerLoadablePath("/Users/dev/app/node_modules/jsdom/lib/api.js")).toBe(true);
    expect(isWorkerLoadablePath("C:\\dev\\app\\node_modules\\jsdom\\lib\\api.js")).toBe(true);
    expect(isWorkerLoadablePath("[externals]/jsdom [external] (jsdom, cjs)")).toBe(false);
    expect(isWorkerLoadablePath("jsdom")).toBe(false);
  });

  it("rejects NON-STRING resolve results — the Turbopack production numeric module id", () => {
    // Rematch gate 2026-07-25 (docs/eval/runs/2026-07-25-rematch): under a
    // Turbopack-bundled `next start` server, createRequire().resolve("react")
    // returned Turbopack's NUMERIC module id (constant 429302 on both hosts);
    // require(429302) in the worker crashed EVERY island-bearing app and
    // 65/90 creates were refused. A non-string is never a loadable path.
    expect(isWorkerLoadablePath(429302)).toBe(false);
    expect(isWorkerLoadablePath(undefined)).toBe(false);
    expect(isWorkerLoadablePath(null)).toBe(false);
    expect(isWorkerLoadablePath({ id: "/real/path.js" })).toBe(false);
  });
});

describe("resolveWorkerModulePaths", () => {
  const absolute = (specifier: string): string => `/repo/node_modules/${specifier}/index.js`;

  it("treats a resolver returning Turbopack numeric module ids as environment-unresolvable (gate skips, never a refusal)", () => {
    // The 2026-07-25 rematch signature: every specifier resolves to the same
    // bundler-internal number. No resolver qualifies → undefined → the gate
    // skips per the esbuild precedent instead of refusing every island.
    expect(resolveWorkerModulePaths([() => ({ resolve: () => 429302 })])).toBeUndefined();
  });

  it("falls through a numeric-id resolver to one returning real absolute paths", () => {
    const paths = resolveWorkerModulePaths([
      () => ({ resolve: () => 429302 }),
      () => ({ resolve: absolute }),
    ]);
    expect(paths).toEqual({
      react: absolute("react"),
      reactDom: absolute("react-dom"),
      reactDomClient: absolute("react-dom/client"),
      jsdom: absolute("jsdom"),
    });
  });

  it("rejects a resolver where ANY single specifier resolves non-string or to a wrapper id", () => {
    const oneNumeric = (specifier: string): unknown => (specifier === "jsdom" ? 429302 : absolute(specifier));
    expect(resolveWorkerModulePaths([() => ({ resolve: oneNumeric })])).toBeUndefined();
    const oneWrapper = (specifier: string): unknown =>
      (specifier === "jsdom" ? "[externals]/jsdom [external] (jsdom, cjs)" : absolute(specifier));
    expect(resolveWorkerModulePaths([() => ({ resolve: oneWrapper })])).toBeUndefined();
  });

  it("treats throwing resolvers (and an empty resolver list) as environment-unresolvable", () => {
    const throwing = (): { resolve: (specifier: string) => unknown } => ({
      resolve: () => { throw new Error("Cannot find module"); },
    });
    expect(resolveWorkerModulePaths([throwing])).toBeUndefined();
    expect(resolveWorkerModulePaths([throwing, () => ({ resolve: absolute })])).toEqual({
      react: absolute("react"),
      reactDom: absolute("react-dom"),
      reactDomClient: absolute("react-dom/client"),
      jsdom: absolute("jsdom"),
    });
    expect(resolveWorkerModulePaths([])).toBeUndefined();
  });
});

describe("smokeRenderIslands", () => {
  it("fails an island calling useState inside a .map with a teaching message", async () => {
    const issues = await smokeRenderIslands({
      components: { ClientContactCards: HOOKS_IN_MAP },
      componentTools: { ClientContactCards: ["host_listClients"] },
      tools,
      toolShapes,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('island "ClientContactCards"');
    expect(issues[0]).toContain("never inside .map(), loops, or conditions");
  }, 30_000);

  it("passes a healthy tools-calling island, rendered against the stub without network", async () => {
    const issues = await smokeRenderIslands({
      components: { ClientList: HEALTHY },
      componentTools: { ClientList: ["host_listClients"] },
      tools,
      toolShapes,
    });
    expect(issues).toEqual([]);
  }, 30_000);

  it("fails an island referencing an undefined component with a teaching message", async () => {
    const source = `
export default function Card() {
  return <MapleNetWorthCard valueCents={1200} />;
}
`;
    const issues = await smokeRenderIslands({
      components: { Card: source },
      componentTools: { Card: [] },
      tools,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("MapleNetWorthCard is not defined");
    expect(issues[0]).toContain("ambient scope");
  }, 30_000);

  it("fails an island that crashes on unguarded tool data (no shape known → {})", async () => {
    const source = `
export default function Rows() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    tools.host_listRows({}).then((res) => setRows(res.rows));
  }, []);
  if (rows === null) return <Text text="Loading" />;
  return <Stack>{rows.map((row) => <Text key={row.id} text={row.id} />)}</Stack>;
}
`;
    const issues = await smokeRenderIslands({
      components: { Rows: source },
      componentTools: { Rows: ["host_listRows"] },
      tools: [{ name: "host_listRows", description: "rows", risk: "read" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("crashed when rendered against stubbed tool results");
  }, 30_000);

  it("resolves mutating tools as pending-approval, never a failure", async () => {
    const source = `
export default function Sender() {
  const [state, setState] = useState("idle");
  useEffect(() => {
    tools.host_sendMessage({ id: "cl_1", body: "hi" }).then((res) => {
      setState(res && res.status === "pending-approval" ? "awaiting approval" : "sent");
    });
  }, []);
  return <Text text={state} />;
}
`;
    const issues = await smokeRenderIslands({
      components: { Sender: source },
      componentTools: { Sender: ["host_sendMessage"] },
      tools,
    });
    expect(issues).toEqual([]);
  }, 30_000);

  it("fails an island that terminates the worker before the render completes", async () => {
    const source = `
export default function Quitter() {
  process.exit(0);
  return <Text text="never" />;
}
`;
    const issues = await smokeRenderIslands({
      components: { Quitter: source },
      componentTools: { Quitter: [] },
      tools,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('island "Quitter"');
    expect(issues[0]).toContain("exited before the component finished rendering");
  }, 30_000);

  it("passes an island using ReactDOM portals and fmt.format — names the real jail scope provides", async () => {
    const source = `
export default function PortalNote() {
  return (
    <Surface>
      <Text text={fmt.format(123456, "money")} />
      {ReactDOM.createPortal(<Text text="floating" />, document.body)}
    </Surface>
  );
}
`;
    const issues = await smokeRenderIslands({
      components: { PortalNote: source },
      componentTools: { PortalNote: [] },
      tools,
    });
    expect(issues).toEqual([]);
  }, 30_000);

  it("terminates an infinite render loop within the render budget", async () => {
    const source = `
export default function Spinner() {
  const [n, setN] = useState(0);
  while (true) { /* spin forever on first render */ }
  return <Text text={String(n)} />;
}
`;
    const issues = await smokeRenderIslands({
      components: { Spinner: source },
      componentTools: { Spinner: [] },
      tools,
      renderTimeoutMs: 500,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("did not finish rendering");
  }, 30_000);

  it("renders islands in parallel and stays within budget", async () => {
    const components: Record<string, string> = {};
    const componentTools: Record<string, string[]> = {};
    for (let index = 0; index < 3; index += 1) {
      components[`Island${index}`] = HEALTHY.replace("ClientList", `Island${index}`);
      componentTools[`Island${index}`] = ["host_listClients"];
    }
    const startedAt = Date.now();
    const issues = await smokeRenderIslands({ components, componentTools, tools, toolShapes });
    const elapsed = Date.now() - startedAt;
    expect(issues).toEqual([]);
    // Report the measured latency (cold: worker spawn + jsdom/react import;
    // warm: the source-keyed cache, what repair/end-pass revalidation pays).
    const warmStartedAt = Date.now();
    await smokeRenderIslands({ components, componentTools, tools, toolShapes });
    console.info(`[smoke-render] 3 islands in parallel: ${elapsed}ms cold, ${Date.now() - warmStartedAt}ms warm-cached`);
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);
});

describe("sampleFromShape", () => {
  it("builds arrays with two items so data-driven re-renders exercise hooks", () => {
    const sample = sampleFromShape(toolShapes.host_listClients) as { clients: unknown[] };
    expect(sample.clients).toHaveLength(2);
    expect(sample.clients[0]).toEqual({ id: "sample", name: "sample", missingDocs: 2 });
  });
});

// ---------------------------------------------------------------------------
// Integration: the gate screens the island the plan declared, and a crash it
// alone can see drives the lane's fix-it retry.
// ---------------------------------------------------------------------------

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const ISLAND = "ClientContactCards";

const cardsPlan = (): AppPlan => ({
  name: "Cards",
  queries: [{ id: "clients", tool: "host_listClients", input: {} }],
  groups: [{
    tab: "Overview",
    leaves: [{ component: ISLAND, query: "clients", purpose: "A card per client with a quick message button" }],
  }],
  island: { name: ISLAND, purpose: "A card per client with a quick message button" },
  cannot: [],
});

const emptyDocument = (): GeneratedAppDocument => ({
  format: VENDO_APP_FORMAT,
  name: "Cards",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "app",
    nodes: [{ id: "app", component: "Stack", source: "prewired", children: [] }],
  } as GeneratedAppDocument["tree"],
});

const deps = (model: unknown, extra: Record<string, unknown> = {}): IslandLaneDeps => ({
  model,
  catalog: [] as unknown as NormalizedCatalog,
  tools,
  toolShapes,
  ...extra,
}) as unknown as IslandLaneDeps;

describe("smoke-render gate inside the island lane", () => {
  it("routes a hooks-in-map island to repair and ships the repaired app", async () => {
    const broken = `<App name="Cards"><Island name="${ISLAND}">${HOOKS_IN_MAP}</Island><${ISLAND}/></App>`;
    const fixed = `<App name="Cards"><Island name="${ISLAND}">${HEALTHY.replace("ClientList", ISLAND)}</Island><${ISLAND}/></App>`;
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const lane = await runIslandLane(cardsPlan(), emptyDocument(), deps(model, {
      request: "contact cards with a quick message button",
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("never inside .map(), loops, or conditions");
    expect(lane.document.components?.[ISLAND]).not.toContain("clients.map((client) => {");
  }, 60_000);

  it("can be disabled with pipeline.smokeRender: false", async () => {
    const broken = `<App name="Cards"><Island name="${ISLAND}">${HOOKS_IN_MAP}</Island><${ISLAND}/></App>`;
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return broken;
    });
    const lane = await runIslandLane(cardsPlan(), emptyDocument(), deps(model, {
      request: "contact cards",
      pipeline: { smokeRender: false },
    }));
    expect(calls).toBe(1);
    expect(lane.document.components?.[ISLAND]).toBeDefined();
  }, 60_000);
});
