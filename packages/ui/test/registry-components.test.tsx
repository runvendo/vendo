// @vitest-environment jsdom
import type {
  UIPayload,
} from "@vendoai/core";
import type {
  ComponentRegistry,
} from "@vendoai/apps/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, hostComponentMap, useVendoProvider, type VendoClient } from "../src/index.js";
import { VendoSlot } from "../src/chrome/index.js";

/** A pinned vendo-genui/v2 tree whose single node is the HOST component —
 *  the render path that resolves it through the provider's components map. */
const pinPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "MetricCard", props: { value: 42 } }],
} as UIPayload;

function MetricCard({ value }: { value: number }) {
  return <strong data-testid="metric">metric:{value}</strong>;
}

afterEach(cleanup);

describe("components prop accepts the 01 §14 registry form (08 §2 amendment)", () => {
  it("renders a host component registered through the name-keyed registry", () => {
    const registry: ComponentRegistry = {
      MetricCard: {
        component: MetricCard,
        description: "Use for one headline metric.",
        // Data fields (props schema, examples) are server-side; the client
        // must ignore them (01 §14 — the same object serves both sides).
        props: { "~standard": { validate: (value: unknown) => ({ value }) } },
        examples: ['{"value":42}'],
      },
    };
    render(
      <VendoProvider components={registry}>
        <VendoSlot id="hero" pin={{ payload: pinPayload }} />
      </VendoProvider>,
    );
    expect(screen.getByTestId("metric").textContent).toBe("metric:42");
  });

  it("keeps the plain name→component map form working (back-compat)", () => {
    render(
      <VendoProvider components={{ MetricCard }}>
        <VendoSlot id="hero" pin={{ payload: pinPayload }} />
      </VendoProvider>,
    );
    expect(screen.getByTestId("metric").textContent).toBe("metric:42");
  });
});

describe("VendoProvider baseUrl", () => {
  function Probe({ onClient }: { onClient: (client: VendoClient) => void }) {
    onClient(useVendoProvider().client);
    return null;
  }

  it("builds its own client at the given baseUrl, and an explicit client wins", () => {
    let built: VendoClient | undefined;
    render(
      <VendoProvider baseUrl="/maple/api/vendo">
        <Probe onClient={client => { built = client; }} />
      </VendoProvider>,
    );
    expect(built?.baseUrl).toBe("/maple/api/vendo");

    const explicit = createVendoClient({ baseUrl: "/explicit" });
    let seen: VendoClient | undefined;
    render(
      <VendoProvider baseUrl="/maple/api/vendo" client={explicit}>
        <Probe onClient={client => { seen = client; }} />
      </VendoProvider>,
    );
    expect(seen).toBe(explicit);
  });
});

describe("hostComponentMap", () => {
  it("extracts name→component from registry entries and passes plain entries through", () => {
    const map = hostComponentMap({
      Plain: MetricCard,
      FromRegistry: { component: MetricCard, description: "d" },
    });
    expect(map).toEqual({ Plain: MetricCard, FromRegistry: MetricCard });
  });

  it("returns an empty map for undefined", () => {
    expect(hostComponentMap(undefined)).toEqual({});
  });
});
