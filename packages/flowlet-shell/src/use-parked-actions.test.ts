import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { FlowletShellProvider } from "./context";
import type { ParkedActionsSeam } from "./context";
import type { ParkedActionRow } from "./components/WaitingList";
import { useParkedActions } from "./use-parked-actions";

const row = (id: string): ParkedActionRow => ({
  id, tool: "GMAIL_SEND_EMAIL", tier: "act", inputPreview: "x", requestedAt: "2026-07-04T00:00:00Z",
});

function wrap(parkedActions?: ParkedActionsSeam) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(FlowletShellProvider, { parkedActions }, children);
  };
}

describe("useParkedActions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches once on mount and exposes the count + rows", async () => {
    const list = vi.fn(async () => [row("p1"), row("p2")]);
    const { result } = renderHook(() => useParkedActions(), {
      wrapper: wrap({ list, resolve: vi.fn() }),
    });
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.actions.map((a) => a.id)).toEqual(["p1", "p2"]);
  });

  it("polls every 30s while mounted", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => [row("p1")]);
    renderHook(() => useParkedActions(), { wrapper: wrap({ list, resolve: vi.fn() }) });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount (no state update after unmount)", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => [row("p1")]);
    const { unmount } = renderHook(() => useParkedActions(), { wrapper: wrap({ list, resolve: vi.fn() }) });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Only the initial fetch — no post-unmount poll fired.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("approve/decline call the seam and re-fetch immediately", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [row("p1")] : [];
    });
    const resolve = vi.fn(async () => undefined);
    const { result } = renderHook(() => useParkedActions(), {
      wrapper: wrap({ list, resolve }),
    });
    await waitFor(() => expect(result.current.count).toBe(1));
    await act(async () => {
      await result.current.approve("p1");
    });
    expect(resolve).toHaveBeenCalledWith("p1", "yes");
    await waitFor(() => expect(result.current.count).toBe(0));
  });

  it("gracefully no-ops when the parkedActions seam is absent (no crash, empty list)", async () => {
    const { result } = renderHook(() => useParkedActions(), { wrapper: wrap(undefined) });
    expect(result.current.actions).toEqual([]);
    expect(result.current.count).toBe(0);
    await expect(result.current.approve("x")).resolves.toBeUndefined();
    await expect(result.current.decline("x")).resolves.toBeUndefined();
  });
});
