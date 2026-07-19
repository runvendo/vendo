// @vitest-environment jsdom
/**
 * Invisible graduation, end to end on the fake ladder path (06-apps §2):
 * drive a REAL tree→rung-4 graduation through createApps, then boot the exact
 * bytes the runtime wrote into the machine — index.html plus the pre-bundled
 * tree renderer — inside a browser DOM and prove the first served version
 * renders the identical kept tree and wires its fn: actions to /fn/<name>.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApps } from "../index.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  seedAppRow,
} from "../testing/index.js";

const decoder = new TextDecoder();

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const ctx = (): RunContext => ({
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
});

/** A rung-1 tree app whose kept tree carries a text node and an fn:-bound button. */
const treeApp = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_graduating",
  name: "Dashboard",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["title", "refresh"] },
      { id: "title", component: "Text", source: "prewired", props: { text: "Rung 1 dashboard" } },
      {
        id: "refresh",
        component: "Button",
        source: "prewired",
        props: { label: "Refresh", onClick: { $action: "fn:refresh", payload: { n: 1 } } },
      },
    ],
  },
});

const graduationModel = () => scriptedLanguageModel(
  JSON.stringify({ rung: 4, files: [{ path: "/app/custom.js", content: "export const custom = 1;" }] }),
);

interface RecordedRequest {
  url: string;
  method: string;
  body?: unknown;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).VendoServedTreeRenderer;
});

describe("served-app scaffold renders the graduated tree (e2e)", () => {
  it("boots the machine's exact scaffold bytes and serves the identical kept tree UI", async () => {
    // 1. A real graduation through the public runtime against the fake sandbox.
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog: [],
      model: graduationModel(),
    });
    const ada = ctx();
    const app = treeApp();
    await seedAppRow(store, app, ada.principal.subject);
    const result = await runtime.edit(app.id, "Turn this into a full web app", ada);
    expect(result.issues).toBeUndefined();
    expect(result.app.ui).toBe("http");
    expect(result.app.tree).toEqual(app.tree); // the tree is KEPT, byte for byte

    // 2. Lift the exact bytes graduation wrote into the machine — no fixtures.
    const machine = [...sandbox.machines.values()]
      .find((candidate) => candidate.fileContents.has("/app/tree-renderer.js"));
    if (machine === undefined) throw new Error("no graduated machine holds the scaffold");
    const asset = (path: string): string => decoder.decode(machine.fileContents.get(path) ?? new Uint8Array());
    const indexHtml = asset("/app/index.html");
    const rendererSource = asset("/app/tree-renderer.js");

    // 3. Serve those bytes to the page the way scaffold-server.cjs would.
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (url === "/tree.json" || url === "/components.json") {
        return new Response(asset(`/app${url}`), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (url.startsWith("/fn/") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { refreshed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "not-found", message: "route not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }));

    // 4. Boot the served page: index.html's body plus the executed renderer bundle.
    const parsed = new DOMParser().parseFromString(indexHtml, "text/html");
    document.body.innerHTML = parsed.body.innerHTML; // scripts inert; executed below
    expect(document.querySelector("#vendo-served-tree")).not.toBeNull();
    (0, eval)(rendererSource);

    // 5. The first served version renders the identical kept tree.
    const mount = document.querySelector("#vendo-served-tree");
    await vi.waitFor(() => expect(mount?.textContent).toContain("Rung 1 dashboard"));
    expect(mount?.querySelector('[data-vendo-node-id="title"]')).not.toBeNull();
    const button = mount?.querySelector("button");
    expect(button?.textContent).toContain("Refresh");

    // 6. Its fn: actions reach the scaffold's /fn/<name> route with the bound args.
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "POST")).toEqual([
      { url: "/fn/refresh", method: "POST", body: { args: { n: 1 } } },
    ]));
  });
});
