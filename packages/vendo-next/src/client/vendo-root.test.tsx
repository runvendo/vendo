import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as shell from "@vendoai/shell";
import * as serverStore from "./server-store.js";
import { VendoRoot } from "./vendo-root.js";

function stubFetch(capabilities: { chat: boolean; integrations: boolean; voice: boolean; storage?: boolean }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/capabilities")) {
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (url.includes("/integrations")) {
      return new Response(JSON.stringify({ enabled: true, integrations: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VendoRoot", () => {
  it("renders children, the launcher pill and fetches capabilities", async () => {
    const fetchMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <VendoRoot productName="Acme" theme={undefined} tools={undefined}>
        <div data-testid="app">app content</div>
      </VendoRoot>,
    );
    expect(screen.getByTestId("app")).toBeDefined();
    expect(screen.getByRole("button", { name: /ask acme/i })).toBeDefined();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/capabilities"))).toBe(true),
    );
  });

  it("mounts VendoToasts by default (deliveries poll) and not when toasts={false}", async () => {
    const fetchMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <VendoRoot productName="Acme">
        <div />
      </VendoRoot>,
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/deliveries"))).toBe(true),
    );
    cleanup();

    const offMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", offMock);
    render(
      <VendoRoot productName="Acme" toasts={false}>
        <div />
      </VendoRoot>,
    );
    await waitFor(() =>
      expect(offMock.mock.calls.some(([u]) => String(u).includes("/capabilities"))).toBe(true),
    );
    expect(offMock.mock.calls.some(([u]) => String(u).includes("/deliveries"))).toBe(false);
  });

  it("hides the launcher when launcher='none'", () => {
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false }));
    render(
      <VendoRoot productName="Acme" launcher="none">
        <div />
      </VendoRoot>,
    );
    expect(screen.queryByRole("button", { name: /ask acme/i })).toBeNull();
  });

  it("hides the assistant surface when the server reports chat is unavailable", async () => {
    vi.stubGlobal("fetch", stubFetch({ chat: false, integrations: false, voice: false }));
    render(
      <VendoRoot productName="Acme">
        <div data-testid="app3" />
      </VendoRoot>,
    );
    // still renders children, but the launcher disappears once chat:false lands
    expect(screen.getByTestId("app3")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /ask acme/i })).toBeNull(),
    );
  });

  it("picks localStorage optimistically, then switches to the server-backed store once capabilities report storage:true", async () => {
    const webStorageSpy = vi.spyOn(shell, "createWebStorage");
    const serverStoreSpy = vi.spyOn(serverStore, "createServerVendoStore");
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false, storage: true }));
    render(
      <VendoRoot productName="Acme" basePath="/api/vendo">
        <div data-testid="app4" />
      </VendoRoot>,
    );
    // Optimistic first render (capabilities still null): localStorage.
    expect(webStorageSpy).toHaveBeenCalledWith({ namespace: "vendo:vendo" });
    await waitFor(() => expect(serverStoreSpy).toHaveBeenCalledWith("/api/vendo"));
    webStorageSpy.mockRestore();
    serverStoreSpy.mockRestore();
  });

  it("stays on localStorage when the server reports storage:false", async () => {
    const serverStoreSpy = vi.spyOn(serverStore, "createServerVendoStore");
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false, storage: false }));
    render(
      <VendoRoot productName="Acme">
        <div data-testid="app5" />
      </VendoRoot>,
    );
    await waitFor(() => expect(screen.getByTestId("app5")).toBeDefined());
    expect(serverStoreSpy).not.toHaveBeenCalled();
    serverStoreSpy.mockRestore();
  });

  it("rehydrates the durable thread on mount (GET /threads/:threadId)", async () => {
    const fetchMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <VendoRoot productName="Acme" basePath="/api/vendo" threadId="my thread">
        <div />
      </VendoRoot>,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes("/api/vendo/threads/my%20thread")),
      ).toBe(true),
    );
  });

  it("tolerates an invalid theme by falling back to the default brand", () => {
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <VendoRoot productName="Acme" theme={{ nope: true }} tools={{ tools: [] }}>
        <div data-testid="app2" />
      </VendoRoot>,
    );
    expect(screen.getByTestId("app2")).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
