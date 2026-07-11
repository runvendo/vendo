import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { UINode } from "@vendoai/core";
import type { StageRoute } from "@vendoai/stage";
import { defaultBrand } from "@vendoai/components/theme";

// Capture the props the packaged sandbox hands to VendoStage.
let captured: Record<string, any> | null = null;
vi.mock("@vendoai/react", () => ({
  VendoStage: (props: any) => {
    captured = props;
    return null;
  },
}));

// NOTE: this file deliberately does NOT import or mock `next/navigation`.
// The generic @vendoai/client must stay Next-free (a Next dependency here
// would break plain-React/Vite consumers like examples/node). Route is now an
// OPTIONAL host-supplied input; a Next host passes it from its own
// next/navigation. These tests exercise both the supplied and absent paths.

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
      return new Response("", { status: 404 });
    }),
  );
}

const node: UINode = { id: "gen", kind: "component", source: "prewired", name: "Text", props: { text: "hi" } };

describe("packaged SandboxStage route channel", () => {
  it("forwards a host-SUPPLIED route to VendoStage (non-empty, catch-all array preserved)", async () => {
    stubSources();
    // A Next host would build this from its own usePathname/useSearchParams/useParams.
    const routeSource = (): StageRoute => ({
      pathname: "/clients/cl_rivera",
      search: "?tab=invoices&page=2",
      params: { id: "cl_rivera", slug: ["a", "b"] },
    });
    render(
      <SandboxStage node={node} brand={defaultBrand} components={[]} basePath="/api/vendo" routeSource={routeSource} />,
    );

    // Sources load in an effect, then RoutedStage mounts VendoStage with the route.
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.route).toBeDefined();
    expect(captured!.route.pathname).toBe("/clients/cl_rivera");
    expect(captured!.route.search).toBe("?tab=invoices&page=2");
    // Catch-all array param survives unchanged (segment shape preserved).
    expect(captured!.route.params).toEqual({ id: "cl_rivera", slug: ["a", "b"] });
    // The whole point of the feature: a supplied route reaches the sandbox non-empty.
    expect(captured!.route.pathname).not.toBe("");
    expect(captured!.route.search).not.toBe("");
  });

  it("renders the non-Next path (NO route supplied) without crashing and with no route on VendoStage", async () => {
    stubSources();
    // No routeSource: the generic client must mount the stage with no route,
    // leaving the sandbox's route shims to resolve empty — exactly the behavior
    // before the route feature, and the path a plain-React/Vite host takes.
    render(<SandboxStage node={node} brand={defaultBrand} components={[]} basePath="/api/vendo" />);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.route).toBeUndefined();
  });
});
