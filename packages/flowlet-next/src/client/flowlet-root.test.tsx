import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as shell from "@flowlet/shell";
import * as serverStore from "./server-store";
import { FlowletRoot } from "./flowlet-root";

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

describe("FlowletRoot", () => {
  it("renders children, the launcher pill and fetches capabilities", async () => {
    const fetchMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FlowletRoot productName="Acme" theme={undefined} tools={undefined}>
        <div data-testid="app">app content</div>
      </FlowletRoot>,
    );
    expect(screen.getByTestId("app")).toBeDefined();
    expect(screen.getByRole("button", { name: /ask acme/i })).toBeDefined();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/capabilities"))).toBe(true),
    );
  });

  it("mounts FlowletToasts by default (deliveries poll) and not when toasts={false}", async () => {
    const fetchMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FlowletRoot productName="Acme">
        <div />
      </FlowletRoot>,
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/deliveries"))).toBe(true),
    );
    cleanup();

    const offMock = stubFetch({ chat: true, integrations: false, voice: false });
    vi.stubGlobal("fetch", offMock);
    render(
      <FlowletRoot productName="Acme" toasts={false}>
        <div />
      </FlowletRoot>,
    );
    await waitFor(() =>
      expect(offMock.mock.calls.some(([u]) => String(u).includes("/capabilities"))).toBe(true),
    );
    expect(offMock.mock.calls.some(([u]) => String(u).includes("/deliveries"))).toBe(false);
  });

  it("hides the launcher when launcher='none'", () => {
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false }));
    render(
      <FlowletRoot productName="Acme" launcher="none">
        <div />
      </FlowletRoot>,
    );
    expect(screen.queryByRole("button", { name: /ask acme/i })).toBeNull();
  });

  it("hides the assistant surface when the server reports chat is unavailable", async () => {
    vi.stubGlobal("fetch", stubFetch({ chat: false, integrations: false, voice: false }));
    render(
      <FlowletRoot productName="Acme">
        <div data-testid="app3" />
      </FlowletRoot>,
    );
    // still renders children, but the launcher disappears once chat:false lands
    expect(screen.getByTestId("app3")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /ask acme/i })).toBeNull(),
    );
  });

  it("picks localStorage optimistically, then switches to the server-backed store once capabilities report storage:true", async () => {
    const webStorageSpy = vi.spyOn(shell, "createWebStorage");
    const serverStoreSpy = vi.spyOn(serverStore, "createServerFlowletStore");
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false, storage: true }));
    render(
      <FlowletRoot productName="Acme" basePath="/api/flowlet">
        <div data-testid="app4" />
      </FlowletRoot>,
    );
    // Optimistic first render (capabilities still null): localStorage.
    expect(webStorageSpy).toHaveBeenCalledWith({ namespace: "flowlet:flowlet" });
    await waitFor(() => expect(serverStoreSpy).toHaveBeenCalledWith("/api/flowlet"));
    webStorageSpy.mockRestore();
    serverStoreSpy.mockRestore();
  });

  it("stays on localStorage when the server reports storage:false", async () => {
    const serverStoreSpy = vi.spyOn(serverStore, "createServerFlowletStore");
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false, storage: false }));
    render(
      <FlowletRoot productName="Acme">
        <div data-testid="app5" />
      </FlowletRoot>,
    );
    await waitFor(() => expect(screen.getByTestId("app5")).toBeDefined());
    expect(serverStoreSpy).not.toHaveBeenCalled();
    serverStoreSpy.mockRestore();
  });

  it("tolerates an invalid theme by falling back to the default brand", () => {
    vi.stubGlobal("fetch", stubFetch({ chat: true, integrations: false, voice: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <FlowletRoot productName="Acme" theme={{ nope: true }} tools={{ tools: [] }}>
        <div data-testid="app2" />
      </FlowletRoot>,
    );
    expect(screen.getByTestId("app2")).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
