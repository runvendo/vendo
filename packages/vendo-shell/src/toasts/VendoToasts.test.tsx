import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import type { AutomationNotice, VendoNotifications, ResumeOutcome } from "../seams/notifications";
import { VendoToasts, OPEN_OVERLAY_EVENT } from "./VendoToasts";

function fakeNotifications(seed: AutomationNotice[], resume: ResumeOutcome = "resumed") {
  const notices = [...seed];
  const resumeCalls: Array<{ runId: string; approved: boolean; stepId?: string }> = [];
  const client: VendoNotifications = {
    listSince: async (since) => notices.filter((n) => n.cursor > since),
    resume: async (runId, approved, stepId) => {
      resumeCalls.push({ runId, approved, ...(stepId !== undefined ? { stepId } : {}) });
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

function mount(client: VendoNotifications, props: Partial<Parameters<typeof VendoToasts>[0]> = {}) {
  return render(
    <VendoProvider agent={createStubAgent()} components={[]}>
      <VendoShellProvider notifications={client}>
        <VendoToasts pollMs={40} dismissMs={30_000} namespace="test" {...props} />
      </VendoShellProvider>
    </VendoProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("VendoToasts", () => {
  it("first-ever mount baselines silently (history never spams a fresh install)", async () => {
    const { client } = fakeNotifications([completed(1), completed(2)]);
    mount(client);
    await waitFor(() => expect(localStorage.getItem("vendo:toasts-cursor:test")).toBe("2"));
    expect(document.querySelector(".fl-toasts")).toBeNull();
  });

  it("an empty first poll consumes the baseline: the NEXT delivery toasts (fresh install, live event)", async () => {
    const { client, notices } = fakeNotifications([]);
    mount(client);
    await waitFor(() => expect(localStorage.getItem("vendo:toasts-cursor:test")).toBe("0"));
    notices.push(completed(1)); // first real event after install
    await waitFor(() => expect(screen.getByText(/finished \(r1\)/)).toBeTruthy());
  });

  it("collapses a backlog of completions into one while-you-were-away digest", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1), completed(2), completed(3)]);
    mount(client);
    await waitFor(() => expect(document.querySelectorAll(".fl-toasts-card")).toHaveLength(1));
    expect(screen.getByText(/While you were away: 3 automations ran/)).toBeTruthy();
  });

  it("shows new deliveries as they arrive and dismisses on ✕", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const { client, notices } = fakeNotifications([completed(1)]);
    mount(client);
    await waitFor(() => expect(screen.getByText(/finished \(r1\)/)).toBeTruthy());

    notices.push(completed(2)); // arrives on a later poll
    await waitFor(() => expect(screen.getByText(/finished \(r2\)/)).toBeTruthy());

    fireEvent.click(screen.getAllByLabelText("Dismiss")[0]!);
    await waitFor(() => expect(screen.queryByText(/finished \(r1\)/)).toBeNull());
  });

  it("auto-dismisses completions but keeps approvals until acted on", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1), approval(2)]);
    mount(client, { dismissMs: 40 });
    await waitFor(() => expect(document.querySelectorAll(".fl-toasts-card")).toHaveLength(2));
    // The completion decays; the approval persists.
    await waitFor(() => expect(screen.queryByText(/finished \(r1\)/)).toBeNull());
    expect(screen.getByText(/needs your approval/)).toBeTruthy();
  });

  it("Approve resumes the run and dismisses; a stale run flips the toast instead", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const fresh = fakeNotifications([approval(1)]);
    const { unmount } = mount(fresh.client);
    fireEvent.click(await screen.findByText("Approve"));
    // stepId rides along so a run paused on a DIFFERENT step answers stale.
    await waitFor(() =>
      expect(fresh.resumeCalls).toEqual([{ runId: "r1", approved: true, stepId: "s1" }]),
    );
    await waitFor(() => expect(document.querySelector(".fl-toasts")).toBeNull());
    unmount();

    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const stale = fakeNotifications([approval(1)], "stale");
    mount(stale.client);
    fireEvent.click(await screen.findByText("Approve"));
    await waitFor(() => expect(screen.getByText(/no longer waiting/)).toBeTruthy());
  });

  it("View summons the shared overlay via the open event", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const { client } = fakeNotifications([completed(1)]);
    const opened = vi.fn();
    window.addEventListener(OPEN_OVERLAY_EVENT, opened);
    mount(client);
    fireEvent.click(await screen.findByText("View"));
    expect(opened).toHaveBeenCalledTimes(1);
    // A non-persistent (completed) toast is done once viewed.
    await waitFor(() => expect(document.querySelector(".fl-toasts")).toBeNull());
    window.removeEventListener(OPEN_OVERLAY_EVENT, opened);
  });

  it("View keeps a pending approval toast on screen (peeking must not discard the decision)", async () => {
    localStorage.setItem("vendo:toasts-cursor:test", "0");
    const { client } = fakeNotifications([approval(1)]);
    mount(client);
    fireEvent.click(await screen.findByText("View"));
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(document.querySelectorAll(".fl-toasts-card")).toHaveLength(1);
  });

  it("stops polling for good once the feed reports it is disabled", async () => {
    let calls = 0;
    const client: VendoNotifications = {
      listSince: async () => {
        calls += 1;
        return "disabled";
      },
      resume: async () => "stale",
    };
    mount(client, { pollMs: 20 });
    await waitFor(() => expect(calls).toBe(1));
    // Several poll intervals later: still exactly one call — a host with
    // automations disabled must not 404 the feed every 2 seconds forever.
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(1);
    expect(document.querySelector(".fl-toasts")).toBeNull();
  });
});
