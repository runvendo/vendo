import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
import { z } from "zod";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "./context";
import { FlowletThread } from "./FlowletThread";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function renderThread() {
  return render(
    <FlowletProvider
      agent={createStubAgent()}
      components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
    >
      <FlowletShellProvider impls={{ DemoCard: DemoCard as never }}>
        <FlowletThread suggestions={["show me a card"]} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

/** Occurrences of `text` in the visible transcript (excludes the SR-only
 *  aria-live announcer, which legitimately echoes the final assistant text). */
function visibleCount(container: HTMLElement, text: string): number {
  return Array.from(container.querySelectorAll(".fl-msglist *")).filter(
    (n) => n.childElementCount === 0 && n.textContent === text,
  ).length;
}

describe("approval resume does not duplicate the turn", () => {
  it("approve: pre-approval text, chip, and rendered node each appear once", async () => {
    const { container } = renderThread();
    fireEvent.click(screen.getByText("show me a card"));
    await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => screen.getByTestId("demo-card"));
    // Let the resumed stream fully settle before counting.
    await waitFor(() => expect(visibleCount(container, "Here is your demo card.")).toBeGreaterThan(0));

    expect(visibleCount(container, "Let me render a demo card.")).toBe(1);
    expect(visibleCount(container, "Here is your demo card.")).toBe(1);
    expect(screen.getAllByTestId("demo-card")).toHaveLength(1);
    expect(screen.getAllByTestId("activity-panel")).toHaveLength(1);
  });

  it("decline: pre-approval text and chip each appear once", async () => {
    const { container } = renderThread();
    fireEvent.click(screen.getByText("show me a card"));
    await waitFor(() => screen.getByText("Decline"));
    fireEvent.click(screen.getByText("Decline"));
    await waitFor(() =>
      expect(visibleCount(container, "No problem — I won't render the card.")).toBeGreaterThan(0),
    );

    expect(visibleCount(container, "Let me render a demo card.")).toBe(1);
    expect(visibleCount(container, "No problem — I won't render the card.")).toBe(1);
    expect(screen.queryByTestId("demo-card")).toBeNull();
  });
});
