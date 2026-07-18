// @vitest-environment jsdom
/**
 * Served-app entry (06-apps §2 invisible graduation): the bundle that ships
 * inside every rung-4 graduation scaffold must render the kept tree with the
 * SAME renderer semantics as the pre-graduation host surface, wire `fn:`
 * actions to the scaffold's `/fn/<name>` route, and contain boot failures as
 * a visible notice instead of a blank page.
 */
import { render, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PayloadView } from "../../src/tree/index.js";

declare global {
  // eslint-disable-next-line no-var
  var VendoServedTreeRenderer: { mount(): Promise<void> } | undefined;
}

interface StubRoute {
  status?: number;
  body: unknown;
}

/** Record of one fetch the entry issued, for asserting the /fn wire shape. */
interface RecordedRequest {
  url: string;
  method: string;
  body?: unknown;
}

const requests: RecordedRequest[] = [];
let routes: Record<string, StubRoute> = {};

const installFetchStub = (): void => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const route = routes[url];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { code: "not-found", message: "route not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }));
};

const keptTree = (): UIPayload => ({
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
});

const mountServedApp = async (): Promise<HTMLElement> => {
  document.body.innerHTML = "";
  const element = document.createElement("main");
  element.id = "vendo-served-tree";
  document.body.append(element);
  // First import runs the entry's auto-mount; later calls reuse the exported
  // mount so every test drives a fresh element through the same code path.
  await import("../../src/tree/served-app/entry.js");
  const renderer = globalThis.VendoServedTreeRenderer;
  if (renderer === undefined) throw new Error("entry did not register VendoServedTreeRenderer");
  await renderer.mount();
  return element;
};

beforeEach(() => {
  requests.length = 0;
  routes = {
    "/tree.json": { body: keptTree() },
    "/components.json": { body: {} },
  };
  installFetchStub();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("served-app tree renderer entry", () => {
  it("renders the kept tree identically to the pre-graduation PayloadView", async () => {
    const served = await mountServedApp();
    await waitFor(() => expect(served.textContent).toContain("Rung 1 dashboard"));

    const reference = render(
      <PayloadView
        payload={keptTree() as unknown as UIPayload}
        components={{}}
        onAction={async (): Promise<ToolOutcome> => ({ status: "ok", output: null })}
      />,
    );

    // Invisible graduation: byte-identical markup, not merely similar content.
    expect(served.innerHTML).toBe(reference.container.innerHTML);
  });

  it("merges served components.json into the payload exactly like the host open() wire shape", async () => {
    routes["/tree.json"] = {
      body: {
        formatVersion: VENDO_TREE_FORMAT_V2,
        root: "root",
        nodes: [{ id: "root", component: "Gauge", source: "generated" }],
      } satisfies Tree,
    };
    routes["/components.json"] = { body: { Gauge: "export default function Gauge() { return <div>G</div>; }" } };

    const served = await mountServedApp();

    // Generated components keep their jailed mount — same containment as pre-graduation.
    await waitFor(() => expect(served.querySelector("iframe")).not.toBeNull());
  });

  it("posts fn: actions to the scaffold /fn route with the bound payload", async () => {
    routes["/fn/refresh"] = { body: { result: { refreshed: true } } };
    const served = await mountServedApp();
    await waitFor(() => expect(served.textContent).toContain("Refresh"));

    served.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toEqual([
      { url: "/fn/refresh", method: "POST", body: { args: { n: 1 } } },
    ]));
    // An ok outcome renders no error state on the node — the surface stays clean.
    await waitFor(() => expect(
      served.querySelector('[data-vendo-node-id="refresh"]')?.getAttribute("data-vendo-outcome"),
    ).toBeNull());
  });

  it("surfaces a scaffold /fn error envelope as the action outcome", async () => {
    routes["/fn/refresh"] = {
      status: 500,
      body: { error: { code: "machine", message: "fn exploded" } },
    };
    const served = await mountServedApp();
    await waitFor(() => expect(served.textContent).toContain("Refresh"));

    served.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => expect(
      served.querySelector('[data-vendo-node-id="refresh"]')?.getAttribute("data-vendo-outcome"),
    ).toBe("error"));
  });

  it("refuses non-fn host actions without touching the network", async () => {
    routes["/tree.json"] = {
      body: {
        ...keptTree(),
        nodes: [
          { id: "root", component: "Stack", source: "prewired", children: ["host"] },
          {
            id: "host",
            component: "Button",
            source: "prewired",
            props: { label: "Host tool", onClick: { $action: "billing.refund" } },
          },
        ],
      } satisfies Tree,
    };
    const served = await mountServedApp();
    await waitFor(() => expect(served.textContent).toContain("Host tool"));

    served.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => expect(
      served.querySelector('[data-vendo-node-id="host"]')?.getAttribute("data-vendo-outcome"),
    ).toBe("error"));
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("contains an incomplete scaffold as a visible alert instead of a blank page", async () => {
    routes = { "/components.json": { body: {} } }; // /tree.json 404s
    const served = await mountServedApp();

    await waitFor(() => expect(served.getAttribute("role")).toBe("alert"));
    expect(served.textContent).toContain("failed to load");
  });
});
