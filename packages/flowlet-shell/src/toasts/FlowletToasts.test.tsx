import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import type { AutomationNotice, FlowletNotifications, ResumeOutcome } from "../seams/notifications";
import { FlowletToasts, OPEN_OVERLAY_EVENT } from "./FlowletToasts";

function fakeNotifications(seed: AutomationNotice[], resume: ResumeOutcome = "resumed") {
  const notices = [...seed];
  const resumeCalls: Array<{ runId: string; approved: boolean }> = [];
  const client: FlowletNotifications = {
    listSince: async (since) => notices.filter((n) => n.cursor > since),
    resume: async (runId, approved) => {
      resumeCalls.push({ runId, approved });
      return resume;
    },
  };
  return { client, notices, resumeCalls };
}

const completed = (cursor: number): AutomationNotice => ({
  cursor,
  kind: "completed",
  runId: `r${cursor}`,
  summary: `run r${cursor}`,
  text: `Automation "Chase" finished (r${cursor}).`,
});

const approval = (cursor: number): AutomationNotice => ({
  cursor,
  kind: "approval-required",
  runId: `r${cursor}`,
  stepId: "s1",
  summary: "wants to email Henderson",
  text: "Invoice chase needs your approval.",
});

function mount(client: FlowletNotifications, props: Partial<Parameters<typeof FlowletToasts>[0]> = {}) {
  return render(
    <FlowletProvider agent={createStubAgent()} components={[]}>
      <FlowletShellProvider notifications={client}>
        <FlowletToasts pollMs={40} dismissMs={30_000} namespace="test" {...props} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("FlowletToasts", () => {
  it("first-ever mount baselines silently (history never spams a fresh install)", async () => {
    const { client } = fakeNotifications([completed(1), completed(2)]);
    mount(client);
    await waitFor(() => expect(localStorage.getItem("flowlet:toasts-cursor:test")).toBe("2"));
    expect(document.querySelector(".fl-toasts")).toBeNull();
  });

  it("collapses a backlog of completions into one while-you-were-away digest", async () => {
    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1), completed(2), completed(3)]);
    mount(client);
    await waitFor(() => expect(document.querySelectorAll(".fl-toasts-card")).toHaveLength(1));
    expect(screen.getByText(/While you were away: 3 automations ran/)).toBeTruthy();
  });

  it("shows new deliveries as they arrive and dismisses on ✕", async () => {
    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const { client, notices } = fakeNotifications([completed(1)]);
    mount(client);
    await waitFor(() => expect(screen.getByText(/finished \(r1\)/)).toBeTruthy());

    notices.push(completed(2)); // arrives on a later poll
    await waitFor(() => expect(screen.getByText(/finished \(r2\)/)).toBeTruthy());

    fireEvent.click(screen.getAllByLabelText("Dismiss")[0]!);
    await waitFor(() => expect(screen.queryByText(/finished \(r1\)/)).toBeNull());
  });

  it("auto-dismisses completions but keeps approvals until acted on", async () => {
    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1), approval(2)]);
    mount(client, { dismissMs: 40 });
    await waitFor(() => expect(document.querySelectorAll(".fl-toasts-card")).toHaveLength(2));
    // The completion decays; the approval persists.
    await waitFor(() => expect(screen.queryByText(/finished \(r1\)/)).toBeNull());
    expect(screen.getByText(/needs your approval/)).toBeTruthy();
  });

  it("Approve resumes the run and dismisses; a stale run flips the toast instead", async () => {
    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const fresh = fakeNotifications([approval(1)]);
    const { unmount } = mount(fresh.client);
    fireEvent.click(await screen.findByText("Approve"));
    await waitFor(() => expect(fresh.resumeCalls).toEqual([{ runId: "r1", approved: true }]));
    await waitFor(() => expect(document.querySelector(".fl-toasts")).toBeNull());
    unmount();

    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const stale = fakeNotifications([approval(1)], "stale");
    mount(stale.client);
    fireEvent.click(await screen.findByText("Approve"));
    await waitFor(() => expect(screen.getByText(/no longer waiting/)).toBeTruthy());
  });

  it("View summons the shared overlay via the open event", async () => {
    localStorage.setItem("flowlet:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1)]);
    const opened = vi.fn();
    window.addEventListener(OPEN_OVERLAY_EVENT, opened);
    mount(client);
    fireEvent.click(await screen.findByText("View"));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_OVERLAY_EVENT, opened);
  });
});
