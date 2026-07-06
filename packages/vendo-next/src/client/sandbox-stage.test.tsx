import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { UINode } from "@vendoai/core";
import { defaultBrand } from "@vendoai/components/theme";

// Capture the props the packaged sandbox hands to VendoStage.
let captured: Record<string, any> | null = null;
vi.mock("@vendoai/react", () => ({
  VendoStage: (props: any) => {
    captured = props;
    return null;
  },
}));

// The host's real route, exactly as next/navigation would report it (including a
// catch-all array param, which must survive to the sandbox unchanged).
vi.mock("next/navigation", () => ({
  usePathname: () => "/clients/cl_rivera",
  useSearchParams: () => new URLSearchParams("tab=invoices&page=2"),
  useParams: () => ({ id: "cl_rivera", slug: ["a", "b"] }),
}));

import { SandboxStage } from "./sandbox-stage.js";

afterEach(() => {
  cleanup();
  captured = null;
  vi.unstubAllGlobals();
});

function stubSources() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("react-runtime.js")) return new Response("/* react */", { status: 200 });
      if (url.includes("components-sandbox.js")) return new Response("/* bundle */", { status: 200 });
      return new Response("", { status: 404 }); // env assets absent → bare sandbox
    }),
  );
}

describe("packaged SandboxStage route channel", () => {
  it("feeds VendoStage the host's REAL route from next/navigation (non-empty)", async () => {
    stubSources();
    const node: UINode = { id: "gen", kind: "component", source: "prewired", name: "Text", props: { text: "hi" } };
    render(<SandboxStage node={node} brand={defaultBrand} components={[]} basePath="/api/vendo" />);

    // Sources load in an effect, then RoutedStage mounts VendoStage with the route.
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.route).toBeDefined();
    expect(captured!.route.pathname).toBe("/clients/cl_rivera");
    expect(captured!.route.search).toBe("?tab=invoices&page=2");
    // Catch-all array param survives unchanged (segment shape preserved).
    expect(captured!.route.params).toEqual({ id: "cl_rivera", slug: ["a", "b"] });
    // The whole point of the feature: packaged installs get a NON-empty route.
    expect(captured!.route.pathname).not.toBe("");
    expect(captured!.route.search).not.toBe("");
  });
});
