// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VendoProvider,
  createVendoClient,
  useActivity,
  useApp,
  useApps,
  useApprovals,
  useAutomations,
  useGrants,
  useVendoStatus,
  useVendoThread,
  type VendoClient,
} from "../src/index.js";
import { createWireServer } from "./wire-server.js";

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

  it("is SSR-safe for every hook and starts from empty transport state", () => {
    function AllHooks() {
      const approvals = useApprovals();
      const grants = useGrants();
      const apps = useApps();
      const app = useApp("app_1");
      const automations = useAutomations();
      const activity = useActivity();
      const status = useVendoStatus();
      const thread = useVendoThread("thr_1");
      return (
        <span>
          {approvals.pending.length +
            grants.grants.length +
            apps.apps.length +
            automations.automations.length +
            activity.events.length +
            thread.messages.length}
          {String(app.app)}
          {String(status.connected)}
        </span>
      );
    }

    expect(() => renderToString(<VendoProvider client={client}><AllHooks /></VendoProvider>)).not.toThrow();
  });

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
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/activity?cursor=aud_2" }));
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
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg_existing"));

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
  });
});
