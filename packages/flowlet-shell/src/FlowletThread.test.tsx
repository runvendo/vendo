import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ConsentResponse } from "@flowlet/core";
import { createStubAgent } from "@flowlet/core/testing";
import { z } from "zod";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "./context";
import { FlowletThread } from "./FlowletThread";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

describe("FlowletThread composer placement", () => {
  const mount = (heroComposer: boolean) =>
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <FlowletThread heroComposer={heroComposer} />
        </FlowletShellProvider>
      </FlowletProvider>,
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

describe("FlowletThread end-to-end", () => {
  it("send -> approval -> approve -> renders the node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <FlowletShellProvider impls={{ DemoCard: DemoCard as never }}>
          <FlowletThread suggestions={["show me a card"]} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );

    fireEvent.click(screen.getByText("show me a card")); // suggestion chip sends
    await waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Flowlet");
  });
});

describe("FlowletThread consent channel", () => {
  afterEach(() => vi.useRealTimers());

  const mountWithConsent = (sendConsent: (response: ConsentResponse) => Promise<void>) =>
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <FlowletShellProvider impls={{ DemoCard: DemoCard as never }} sendConsent={sendConsent}>
          <FlowletThread suggestions={["show me a card"]} />
        </FlowletShellProvider>
      </FlowletProvider>,
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

  it("REVIEW FOLLOW-UP: a never-settling consent POST still resolves the SDK approval (4s race timeout) — a HUNG fetch must never block it forever", async () => {
    vi.useFakeTimers();
    const sendConsent = vi.fn(() => new Promise<void>(() => {})); // never settles
    mountWithConsent(sendConsent);
    fireEvent.click(screen.getByText("show me a card"));
    await vi.waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    await vi.waitFor(() => expect(sendConsent).toHaveBeenCalled());
    // The consent POST is still pending — nothing has resolved it yet.
    expect(screen.queryByTestId("demo-card")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    // Past the timeout, the SDK approval response still fires — the resume
    // proceeds even though the consent POST never settled.
    await vi.waitFor(() => screen.getByTestId("demo-card"));
    vi.useRealTimers();
  });
});
