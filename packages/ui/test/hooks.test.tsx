// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VendoProvider,
  createVendoClient,
  useActivity,
  useApp,
  useApps,
  useApprovals,
  useAutomations,
  useConnections,
  useGrants,
  useThreads,
  useVendoStatus,
  useVendoThread,
  type VendoClient,
} from "../src/index.js";
import type { AppDocument } from "@vendoai/core";
import { createWireServer } from "./wire-server.js";

const extraApp: AppDocument = {
  format: "vendo/app@1",
  id: "app_extra",
  name: "Extra",
  ui: "tree",
  tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [{ id: "root", component: "Text", props: { text: "x" } }] },
};

describe("headless hooks", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url, headers: { "X-Hook-Test": "true" } });
  });

  afterEach(async () => {
    await wire.close();
  });

  function wrapper({ children }: PropsWithChildren) {
    return <VendoProvider client={client}>{children}</VendoProvider>;
  }

  it("loads and decides approvals, then refetches pending", async () => {
    const { result } = renderHook(() => useApprovals(), { wrapper });
    expect(result.current.pending).toEqual([]);
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    await act(() => result.current.decide("apr_1", { approve: false }));
    expect(result.current.pending).toEqual([]);
    expect(wire.requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/approvals/decide",
        body: { ids: ["apr_1"], decision: { approve: false } },
      }),
    );
  });

  it("loads and revokes grants, then refetches", async () => {
    const { result } = renderHook(() => useGrants(), { wrapper });
    expect(result.current.grants).toEqual([]);
    await waitFor(() => expect(result.current.grants).toHaveLength(1));
    await act(() => result.current.revoke("grt_1"));
    expect(result.current.grants).toEqual([]);
  });

  it("loads apps and refetches after create, remove, and fork", async () => {
    const { result } = renderHook(() => useApps(), { wrapper });
    expect(result.current.apps).toEqual([]);
    await waitFor(() => expect(result.current.apps).toHaveLength(2));

    let createdId = "";
    await act(async () => {
      createdId = (await result.current.create("Forecast")).id;
    });
    expect(result.current.apps).toHaveLength(3);
    await act(() => result.current.remove(createdId));
    expect(result.current.apps).toHaveLength(2);
    await act(() => result.current.fork("app_1"));
    expect(result.current.apps).toHaveLength(3);
  });

  it("loads an app and surface, proxies calls/history, and refreshes after edit and undo", async () => {
    const { result } = renderHook(() => useApp("app_1"), { wrapper });
    expect(result.current.app).toBeUndefined();
    expect(result.current.surface).toBeUndefined();
    await waitFor(() => expect(result.current.app?.id).toBe("app_1"));
    expect(result.current.surface?.kind).toBe("tree");

    await expect(result.current.call("fn:refresh", { month: 7 })).resolves.toMatchObject({ status: "ok" });
    await expect(result.current.history.list()).resolves.toHaveLength(1);
    await act(() => result.current.edit("Add totals"));
    expect(result.current.app?.name).toBe("Edited");
    await act(() => result.current.history.undo());
    expect(result.current.app?.name).toBe("Undone");
    await act(() => result.current.refresh());
    expect(result.current.surface?.kind).toBe("tree");
  });

  it("ignores a stale app response after appId changes", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstRequests = 0;
    const racingClient = {
      ...client,
      apps: {
        ...client.apps,
        get: async (id: string) => {
          if (id === "app_first") {
            firstRequests += 1;
            await firstGate;
          }
          return { format: "vendo/app@1" as const, id, name: id === "app_first" ? "First" : "Second" };
        },
        open: async (id: string) => {
          if (id === "app_first") {
            firstRequests += 1;
            await firstGate;
          }
          return {
            kind: "tree" as const,
            payload: {
              formatVersion: "vendo-genui/v2",
              root: id,
              nodes: [{ id, component: "Text", props: { text: id } }],
            },
          };
        },
      },
    } satisfies VendoClient;
    const racingWrapper = ({ children }: PropsWithChildren) => (
      <VendoProvider client={racingClient}>{children}</VendoProvider>
    );
    const { result, rerender } = renderHook(
      ({ appId }: { appId: string }) => useApp(appId),
      { wrapper: racingWrapper, initialProps: { appId: "app_first" } },
    );
    await waitFor(() => expect(firstRequests).toBe(2));

    rerender({ appId: "app_second" });
    await waitFor(() => expect(result.current.app?.id).toBe("app_second"));
    expect(result.current.surface).toMatchObject({ kind: "tree", payload: { root: "app_second" } });

    await act(async () => { releaseFirst(); });
    await waitFor(() => expect(result.current.app?.id).toBe("app_second"));
    expect(result.current.surface).toMatchObject({ kind: "tree", payload: { root: "app_second" } });
  });

  it("keeps the newest app state when overlapping refreshes resolve out of order", async () => {
    // Refresh #2 is gated (a slow round trip); refresh #3 resolves first. The
    // late #2 response — served pre-mutation — must NOT clobber #3's state.
    let refreshIndex = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const racingClient = {
      ...client,
      apps: {
        ...client.apps,
        get: async (id: string) => {
          refreshIndex += 1;
          const index = refreshIndex;
          if (index === 2) await secondGate;
          return { format: "vendo/app@1" as const, id, name: index === 2 ? "stale" : index === 3 ? "fresh" : "initial" };
        },
        open: async (id: string) => {
          const index = refreshIndex;
          if (index === 2) await secondGate;
          return {
            kind: "tree" as const,
            payload: {
              formatVersion: "vendo-genui/v2",
              root: `r${index}`,
              nodes: [{ id: `r${index}`, component: "Text", props: { text: id } }],
            },
          };
        },
      },
    } satisfies VendoClient;
    const racingWrapper = ({ children }: PropsWithChildren) => (
      <VendoProvider client={racingClient}>{children}</VendoProvider>
    );
    const { result } = renderHook(() => useApp("app_1"), { wrapper: racingWrapper });
    await waitFor(() => expect(result.current.app?.name).toBe("initial"));

    let second!: Promise<void>;
    let third!: Promise<void>;
    act(() => {
      second = result.current.refresh();
      third = result.current.refresh();
    });
    await act(async () => { await third; });
    expect(result.current.app?.name).toBe("fresh");

    await act(async () => {
      releaseSecond();
      await second;
    });
    // The stale response must be dropped: the newer refresh already landed.
    expect(result.current.app?.name).toBe("fresh");
    expect(result.current.surface).toMatchObject({ kind: "tree", payload: { root: "r3" } });
  });

  it("loads automations and proxies enable, disable, dry-run, filtered runs, and stop", async () => {
    const { result } = renderHook(() => useAutomations(), { wrapper });
    expect(result.current.automations).toEqual([]);
    await waitFor(() => expect(result.current.automations).toHaveLength(1));

    let enabled: Awaited<ReturnType<typeof result.current.enable>> | undefined;
    await act(async () => {
      enabled = await result.current.enable("app_auto");
    });
    expect(enabled).toMatchObject({ enabled: true });
    expect(result.current.automations[0]?.enabled).toBe(true);
    await act(async () => {
      await result.current.disable("app_auto");
    });
    expect(result.current.automations[0]?.enabled).toBe(false);
    await expect(result.current.dryRun("app_auto")).resolves.toMatchObject({ grantsMissing: [] });
    await expect(result.current.runs({ appId: "app_auto", status: "running" })).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: "run_1" })],
    });
    await act(async () => {
      await result.current.stopRun("run_1");
    });
    expect(wire.state.runs[0]?.status).toBe("stopped");
  });

  it("loads audit pages, passes the last id as cursor, and de-duplicates appended events", async () => {
    const { result } = renderHook(() => useActivity(), { wrapper });
    expect(result.current.events).toEqual([]);
    await waitFor(() => expect(result.current.events.map(event => event.id)).toEqual(["aud_1", "aud_2"]));
    await act(() => result.current.loadMore());
    expect(result.current.events.map(event => event.id)).toEqual(["aud_1", "aud_2", "aud_3"]);
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/activity?cursor=eyJjIjoiMjAyNi0wNy0xMVQxMjowMDowMC4wMDBaIiwiaSI6ImF1ZF8yIn0" }));
  });

  it("signals the end of the list once a page adds no new events", async () => {
    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    // A first page arrived — there may still be more behind the cursor.
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(result.current.hasMore).toBe(true);

    // The next page repeats already-seen rows (nothing older remains), so the
    // hook resolves to the end of the list and the panel can retire "Load more".
    await act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.events).toHaveLength(3);
  });

  it("loads posture and transitions to disconnected after the server is killed", async () => {
    let latest: ReturnType<typeof useVendoStatus> | undefined;
    function Probe({ value }: { value: VendoClient }) {
      return <VendoProvider client={value}><Status /></VendoProvider>;
    }
    function Status() {
      latest = useVendoStatus();
      return null;
    }

    const view = render(<Probe value={client} />);
    expect(latest).toEqual({ posture: "unconfigured", connected: false });
    await waitFor(() => expect(latest).toEqual({ posture: "rules", connected: true }));

    await wire.close();
    const disconnectedClient = createVendoClient({ baseUrl: wire.url });
    view.rerender(<Probe value={disconnectedClient} />);
    await waitFor(() => expect(latest).toEqual({ posture: "unconfigured", connected: false }));
  });

  it("resumes a thread and consumes a full ai-SDK turn with native and Vendo approvals", async () => {
    const { result } = renderHook(() => useVendoThread("thr_1"), { wrapper });
    expect(result.current.messages).toEqual([]);
    expect(result.current.threadId).toBe("thr_1");
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg_existing"));
    expect(result.current.threadId).toBe("thr_1");
    expect(wire.requests.filter(request => request.method === "GET" && request.path.startsWith("/threads")))
      .toEqual([
        expect.objectContaining({ path: "/threads" }),
        expect.objectContaining({ path: "/threads/thr_1" }),
      ]);

    await act(() => result.current.sendMessage({ text: "Send the email" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const assistant = result.current.messages.filter(message => message.role === "assistant").at(-1);
    expect(assistant?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Turn complete" }));
    expect(result.current.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dynamic-tool", state: "approval-requested" }),
        expect.objectContaining({ type: "data-vendo-approval", approvalId: "apr_stream" }),
      ]),
    );

    const turn = wire.requests.find(request => request.method === "POST" && request.path === "/threads");
    expect(Object.keys(turn?.body as object).sort()).toEqual(["message", "threadId"]);
    expect(turn?.body).toMatchObject({
      threadId: "thr_1",
      message: { role: "user", parts: [{ type: "text", text: "Send the email" }] },
    });
    expect(typeof result.current.addToolApprovalResponse).toBe("function");
    expect(typeof result.current.stop).toBe("function");
    // ENG-214 — headless parity for the chrome's retry affordance.
    expect(typeof result.current.regenerate).toBe("function");
    expect(typeof result.current.clearError).toBe("function");
  });

  it("degrades a stale supplied thread id without requesting its missing history", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() => useVendoThread("thr_stale"), { wrapper });
      expect(result.current.threadId).toBe("thr_stale");

      await waitFor(() => expect(result.current.threadId).toBeUndefined());
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeUndefined();
      expect(wire.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/threads" }));
      expect(wire.requests).not.toContainEqual(expect.objectContaining({ path: "/threads/thr_stale" }));

      await act(() => result.current.sendMessage({ text: "Start fresh" }));
      await waitFor(() => {
        expect(result.current.status).toBe("ready");
        expect(result.current.threadId).toBe("thr_minted");
      });

      const turn = wire.requests.find(request => request.method === "POST" && request.path === "/threads");
      expect(turn?.body).toMatchObject({
        message: { role: "user", parts: [{ type: "text", text: "Start fresh" }] },
      });
      expect(turn?.body).not.toHaveProperty("threadId");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("adopts a server-minted default thread id for the next user turn", async () => {
    const { result } = renderHook(() => useVendoThread(), { wrapper });
    expect(result.current.threadId).toBeUndefined();

    await act(() => result.current.sendMessage({ text: "My name is Farouk." }));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
      expect(result.current.threadId).toBe("thr_minted");
    });
    await act(() => result.current.sendMessage({ text: "What is my name?" }));
    await waitFor(() => {
      expect(wire.requests.filter(request => request.method === "POST" && request.path === "/threads"))
        .toHaveLength(2);
      expect(result.current.status).toBe("ready");
    });

    const turns = wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
    expect(turns[0]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "My name is Farouk." }] },
    });
    expect(turns[0]?.body).not.toHaveProperty("threadId");
    expect(turns[1]?.body).toMatchObject({
      threadId: "thr_minted",
      message: { role: "user", parts: [{ type: "text", text: "What is my name?" }] },
    });
  });

  it("uses the adopted default thread id for approval auto-resume", async () => {
    const { result } = renderHook(() => useVendoThread(), { wrapper });

    await act(() => result.current.sendMessage({ text: "Send the email" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const nativeApproval = result.current.approvals.find(part => part.type === "dynamic-tool");
    expect(nativeApproval).toMatchObject({ state: "approval-requested" });

    await act(() => result.current.addToolApprovalResponse({
      id: (nativeApproval as { approval: { id: string } }).approval.id,
      approved: true,
    }));
    await waitFor(() => {
      expect(wire.requests.filter(request => request.method === "POST" && request.path === "/threads"))
        .toHaveLength(2);
      expect(result.current.status).toBe("ready");
    });

    const resume = wire.requests.filter(
      request => request.method === "POST" && request.path === "/threads",
    )[1];
    expect(resume?.body).toMatchObject({
      threadId: "thr_minted",
      message: {
        role: "assistant",
      },
    });
    const resumeParts = (resume?.body as { message?: { parts?: unknown[] } } | undefined)?.message?.parts;
    expect(resumeParts).toContainEqual(expect.objectContaining({
      type: "dynamic-tool",
      state: "approval-responded",
      approval: { id: "apr_stream", approved: true },
    }));
  });
});

describe("ENG-219 — consistent { data, error, isLoading, refresh } + polling + headless parity", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url, headers: { "X-Hook-Test": "true" } });
  });

  afterEach(async () => {
    await wire.close();
  });

  function wrapper({ children }: PropsWithChildren) {
    return <VendoProvider client={client}>{children}</VendoProvider>;
  }

  it("exposes data, error, isLoading, and refresh on every data hook", () => {
    const hooks = [
      () => useApps(),
      () => useApprovals(),
      () => useGrants(),
      () => useActivity(),
      () => useConnections(),
      () => useAutomations(),
      () => useApp("app_1"),
      () => useThreads(),
    ];
    for (const hook of hooks) {
      const { result, unmount } = renderHook(hook, { wrapper });
      expect(result.current).toHaveProperty("data");
      expect(result.current).toHaveProperty("error");
      expect(result.current.isLoading).toBe(true);
      expect(typeof result.current.refresh).toBe("function");
      unmount();
    }
  });

  it("keeps useApp isLoading settled through an edit refresh (only the first load flickers)", async () => {
    const { result } = renderHook(() => useApp("app_1"), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.app?.id).toBe("app_1"));
    expect(result.current.isLoading).toBe(false);

    await act(() => result.current.edit("Add totals"));
    // The edit refresh must not re-flip isLoading true.
    expect(result.current.isLoading).toBe(false);
  });

  it("surfaces an initial fetch failure instead of swallowing it", async () => {
    wire.state.failures.push({ method: "GET", path: "/grants", code: "boom", message: "kaboom", status: 500 });
    const { result } = renderHook(() => useGrants(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.data).toEqual([]);
    expect(result.current.grants).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("clears a prior error and finishes loading on a successful first fetch", async () => {
    const { result } = renderHook(() => useApps(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.apps).toEqual(result.current.data);
  });

  it("refresh re-fetches the collection", async () => {
    const { result } = renderHook(() => useApps(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    wire.state.apps.push(extraApp);
    await act(() => result.current.refresh());
    expect(result.current.data).toHaveLength(3);
  });

  it("re-fetches on the opt-in polling interval without a remount", async () => {
    const { result } = renderHook(() => useApprovals({ pollMs: 25 }), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // A new pending approval appears server-side after the initial fetch.
    wire.state.approvals.push({ ...wire.state.approvals[0]!, id: "apr_2" });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
  });

  it("lists, gets, and deletes threads headlessly", async () => {
    const { result } = renderHook(() => useThreads(), { wrapper });
    await waitFor(() => expect(result.current.data.map(thread => thread.id)).toEqual(["thr_1"]));
    await expect(result.current.get("thr_1")).resolves.toMatchObject({ id: "thr_1" });
    await act(() => result.current.remove("thr_1"));
    expect(result.current.data).toEqual([]);
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "DELETE", path: "/threads/thr_1" }));
  });

  it("exposes app export and import via the hook", async () => {
    const { result } = renderHook(() => useApps(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    const bytes = await result.current.exportApp("app_1");
    expect(Array.from(bytes)).toEqual([0, 1, 255]);

    let imported: AppDocument | undefined;
    await act(async () => {
      imported = await result.current.importApp(new Uint8Array([9, 9]));
    });
    expect(imported).toMatchObject({ id: "app_imported" });
    expect(result.current.data).toHaveLength(3);
  });
});
