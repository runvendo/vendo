// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, useApp, type VendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

/**
 * Post-check H16 — an app tile that nobody has scrolled to must cost nothing.
 * The Apps page maps the FULL list and every tile mounts a real app (a get, an
 * open, sometimes an iframe), so thirty apps booted thirty machines while the
 * home shelf capped itself at four for exactly that reason. `useApp`'s
 * `enabled` is the mechanism a host gates a tile with.
 */

describe("the app boot gate", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  function wrapper({ children }: PropsWithChildren) {
    return <VendoProvider client={client}>{children}</VendoProvider>;
  }

  const boots = () => wire.requests.filter(request => request.path.startsWith("/apps/app_1")).length;

  it("boots nothing while it is disabled", async () => {
    const { result } = renderHook(() => useApp("app_1", { enabled: false }), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(boots()).toBe(0);
    expect(result.current.app).toBeUndefined();
    expect(result.current.surface).toBeUndefined();
    // Not loading — nothing was asked for.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it("boots once when it is turned on, and stays booted", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useApp("app_1", { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(boots()).toBe(0);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.app?.id).toBe("app_1"));
    // GET /apps/app_1 + GET /apps/app_1/open, once each.
    expect(boots()).toBe(2);

    rerender({ enabled: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(boots()).toBe(2);
    expect(result.current.surface).toBeDefined();
  });

  it("boots by default — an existing caller is unchanged", async () => {
    const { result } = renderHook(() => useApp("app_1"), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.app?.id).toBe("app_1"));
  });
});
