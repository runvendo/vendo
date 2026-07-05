import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ConsentResponse } from "@vendoai/core";
import { createStubAgent } from "@vendoai/core/testing";
import { z } from "zod";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider, type SendConsentResult } from "./context";
import { VendoThread } from "./VendoThread";
import type { ThreadItem } from "./use-vendo-thread";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

// Batch-consent tests below drive VendoThread's internal approveBatch/
// approveSubset closures WITHOUT a full scripted-agent turn (createStubAgent
// only ever emits one approval at a time) — `useVendoThread` is mocked so
// the test controls `items`/`addToolApprovalResponse` directly, while
// `groupThreadItems` (the real implementation, re-exported below) still does
// the actual sibling-batching MessageList relies on.
const { chatRef } = vi.hoisted(() => ({
  chatRef: { current: null as unknown as {
    items: ThreadItem[];
    status: string;
    error?: unknown;
    addToolApprovalResponse: (r: { id: string; approved: boolean }) => void;
    sendMessage: (...args: unknown[]) => void;
    regenerate: (...args: unknown[]) => void;
    stop: () => void;
    clearError: () => void;
  } | null },
}));
vi.mock("./use-vendo-thread", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-vendo-thread")>();
  return {
    ...actual,
    // Every OTHER describe block in this file drives a real createStubAgent
    // turn through the real useVendoThread (chatRef.current stays null for
    // those) — only the batch-consent tests below opt in by setting it.
    useVendoThread: () => chatRef.current ?? (actual as { useVendoThread: () => unknown }).useVendoThread(),
  };
});

describe("VendoThread composer placement", () => {
  const mount = (heroComposer: boolean) =>
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider>
          <VendoThread heroComposer={heroComposer} />
        </VendoShellProvider>
      </VendoProvider>,
    );

  it("keeps the composer at the bottom by default (overlay/slot surfaces unchanged)", () => {
    const { container } = mount(false);
    expect(container.querySelector(".fl-landing .fl-composer")).toBeNull();
    expect(container.querySelector(".fl-thread > .fl-composer, .fl-thread .fl-composer")).not.toBeNull();
  });

  it("hoists the composer into the Landing hero only when heroComposer is set", () => {
    const { container } = mount(true);
    expect(container.querySelector(".fl-landing .fl-composer")).not.toBeNull();
    // exactly one composer — not duplicated at the bottom
    expect(container.querySelectorAll(".fl-composer")).toHaveLength(1);
  });
});

describe("VendoThread end-to-end", () => {
  it("send -> approval -> approve -> renders the node", async () => {
    render(
      <VendoProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <VendoShellProvider impls={{ DemoCard: DemoCard as never }}>
          <VendoThread suggestions={["show me a card"]} />
        </VendoShellProvider>
      </VendoProvider>,
    );

    fireEvent.click(screen.getByText("show me a card")); // suggestion chip sends
    await waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Vendo");
  });
});

describe("VendoThread consent channel", () => {
  afterEach(() => vi.useRealTimers());

  const mountWithConsent = (sendConsent: (response: ConsentResponse) => Promise<void>) =>
    render(
      <VendoProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <VendoShellProvider impls={{ DemoCard: DemoCard as never }} sendConsent={sendConsent}>
          <VendoThread suggestions={["show me a card"]} />
        </VendoShellProvider>
      </VendoProvider>,
    );

  it("approve posts a yes consent; a REJECTED post never blocks the SDK approval (no unhandled rejection)", async () => {
    const sendConsent = vi.fn(() => Promise.reject(new Error("consent endpoint down")));
    mountWithConsent(sendConsent);
    fireEvent.click(screen.getByText("show me a card"));
    await waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    // The approval resume proceeds even though the consent POST rejected.
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(sendConsent).toHaveBeenCalledWith(
      { id: "call-1", decision: "yes" },
      { toolName: "renderDemoCard" },
    );
  });

  it("decline posts a no-decision consent (audit records every decision) before answering the SDK boolean", async () => {
    const sendConsent = vi.fn(() => Promise.resolve());
    mountWithConsent(sendConsent);
    fireEvent.click(screen.getByText("show me a card"));
    await waitFor(() => screen.getByText("No"));
    fireEvent.click(screen.getByText("No"));
    // The settled text also echoes into the SR-only announcer, hence getAllByText.
    await waitFor(() =>
      expect(screen.getAllByText("No problem — I won't render the card.").length).toBeGreaterThan(0),
    );
    expect(sendConsent).toHaveBeenCalledWith(
      { id: "call-1", decision: "no" },
      { toolName: "renderDemoCard" },
    );
  });

  it("ENG-193 PR #40 review — item B: a never-settling consent POST does NOT delay the SDK approval resume — it fires immediately, in parallel", async () => {
    vi.useFakeTimers();
    const sendConsent = vi.fn(() => new Promise<void>(() => {})); // never settles
    mountWithConsent(sendConsent);
    fireEvent.click(screen.getByText("show me a card"));
    await vi.waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    await vi.waitFor(() => expect(sendConsent).toHaveBeenCalled());
    // The consent POST is still pending (never settles) — but the SDK resume
    // never waited on it in the first place, so the render already happened.
    await vi.waitFor(() => screen.getByTestId("demo-card"));
    // Advancing past the old 4s race window changes nothing further — this
    // pins that the timeout no longer gates anything observable here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByTestId("demo-card")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("VendoThread batch consent — fade proposal surfacing (review follow-up)", () => {
  function batchItems(): ThreadItem[] {
    return [
      // MessageList only mounts FadeProposalCard beside an "activity" render
      // unit (grouped from "tool" items) for the matching messageId — a
      // settled, DIFFERENT-tool call in the same turn gives the fade proposal
      // somewhere to render, same as it would beside whatever else the turn
      // already did before offering to stop asking about this batch's tool.
      { kind: "tool", key: "m1:x", messageId: "m1", toolName: "OTHER_TOOL", state: "output-available" },
      { kind: "approval", key: "m1:0", messageId: "m1", approvalId: "ap1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL", input: {}, tier: "act" },
      { kind: "approval", key: "m1:1", messageId: "m1", approvalId: "ap2", toolCallId: "call-2", toolName: "GMAIL_SEND_EMAIL", input: {}, tier: "act" },
    ];
  }

  const mountBatch = (sendConsent: (response: ConsentResponse) => Promise<SendConsentResult | void>) => {
    chatRef.current = {
      items: batchItems(),
      status: "ready",
      addToolApprovalResponse: vi.fn(),
      sendMessage: vi.fn(),
      regenerate: vi.fn(),
      stop: vi.fn(),
      clearError: vi.fn(),
    };
    return render(
      <VendoShellProvider sendConsent={sendConsent}>
        <VendoThread />
      </VendoShellProvider>,
    );
  };

  it("REVIEW FOLLOW-UP: approveBatch surfaces the fadeEligible earned by ONE of the batch's consent responses — previously discarded entirely", async () => {
    // call-1's response carries no fadeEligible; call-2's does (the 3rd yes
    // inside this batch, say) — before the fix, approveBatch fired both
    // POSTs and threw away every result, so this never rendered.
    const sendConsent = vi.fn((response: ConsentResponse) =>
      response.id === "call-2"
        ? Promise.resolve({ fadeEligible: { shape: { kind: "tool" as const }, proposalId: "prop-1", count: 3 } })
        : Promise.resolve(undefined),
    );
    mountBatch(sendConsent);

    fireEvent.click(await screen.findByText("Approve all 2"));

    await waitFor(() => expect(sendConsent).toHaveBeenCalledTimes(2));
    await screen.findByRole("group", { name: "Handle this without asking?" });
    expect(screen.getByText(/That's the third time you've okayed/)).toBeTruthy();
  });

  it("REVIEW FOLLOW-UP: approveSubset surfaces a fadeEligible from the accepted subset the same way", async () => {
    const sendConsent = vi.fn((response: ConsentResponse) =>
      response.id === "call-2" && response.decision === "subset"
        ? Promise.resolve({ fadeEligible: { shape: { kind: "tool" as const }, proposalId: "prop-2", count: 4 } })
        : Promise.resolve(undefined),
    );
    mountBatch(sendConsent);

    fireEvent.click(await screen.findByText("Pick which…"));
    // Both are checked by default (untouched state) — "Approve selected"
    // approves the full subset, exercising approveSubset's accepted path.
    fireEvent.click(screen.getByText("Approve selected"));

    await waitFor(() => expect(sendConsent).toHaveBeenCalledTimes(2));
    await screen.findByRole("group", { name: "Handle this without asking?" });
    expect(screen.getByText(/4th time you've okayed/)).toBeTruthy();
  });
});
