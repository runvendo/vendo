import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityPanel } from "./ActivityPanel";
import { ActivityStep } from "./ActivityStep";
import type { ToolItem } from "../use-flowlet-thread";

const tool = (name: string, state: string, output?: unknown): ToolItem => ({
  kind: "tool", key: `k-${name}`, messageId: "m", toolName: name, state, output,
});

describe("ActivityPanel", () => {
  it("is collapsed by default and shows the live step in parentheses while working", () => {
    render(<ActivityPanel steps={[tool("GMAIL_SEARCH", "input-available")]} working />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("(Searching Gmail…)")).toBeTruthy();
    // Collapsed: steps are not shown until expanded.
    expect(screen.queryByTestId("activity-step")).toBeNull();
  });

  it("settles to a last-action summary with a +N more suffix", () => {
    render(
      <ActivityPanel
        steps={[tool("GMAIL_SEARCH", "output-available"), tool("SLACK_POST", "output-available")]}
      />,
    );
    expect(screen.getByText("Posted to Slack")).toBeTruthy();
    expect(screen.getByText("· +1 more")).toBeTruthy();
  });

  it("expands to reveal steps and a result peek", () => {
    render(
      <ActivityPanel
        steps={[tool("get_transactions", "output-available", [{ merchant: "Amazon", amount: "$87.00" }])]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /show activity/i }));
    expect(screen.getByTestId("activity-step")).toBeTruthy();
    expect(screen.getByText("Amazon")).toBeTruthy();
    expect(screen.getByText("$87.00")).toBeTruthy();
  });

  it("surfaces an error state in the header", () => {
    render(<ActivityPanel steps={[tool("SLACK_POST", "output-error")]} />);
    expect(screen.getByText("Ran into an issue")).toBeTruthy();
  });

  it("shows a declined header for a denied tool call — never a success tick", () => {
    render(<ActivityPanel steps={[tool("GMAIL_SEND_EMAIL", "output-denied")]} />);
    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
  });

  it("a denied step row is terminal: no spinner, marked declined", () => {
    render(<ActivityPanel steps={[tool("GMAIL_SEND_EMAIL", "output-denied")]} />);
    fireEvent.click(screen.getByRole("button", { name: /show activity/i }));
    const step = screen.getByTestId("activity-step");
    expect(step.querySelector(".fl-act-spin")).toBeNull();
    expect(step.textContent).toContain("Sending email");
    expect(step.textContent).toContain("Declined");
  });

  it("denied counts as settled — a working turn with only a denied step shows no live header", () => {
    render(<ActivityPanel steps={[tool("GMAIL_SEND_EMAIL", "output-denied")]} working />);
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.getByText("Declined")).toBeTruthy();
  });

  it("a mixed turn (success + denied) reads Partly done, not Declined", () => {
    render(
      <ActivityPanel
        steps={[tool("get_transactions", "output-available"), tool("GMAIL_SEND_EMAIL", "output-denied")]}
      />,
    );
    expect(screen.getByText("Partly done")).toBeTruthy();
    expect(screen.queryByText("Declined")).toBeNull();
  });

  it("shows an expandable receipt row for a settled mutating call, reusing approvalRows fields", () => {
    const { container } = render(
      <ActivityStep
        step={{
          kind: "tool", key: "s1", messageId: "m", toolName: "GMAIL_SEND_EMAIL",
          toolCallId: "c1", state: "output-available", input: { to: "acme@example.com" }, output: "sent",
          tier: "act",
        }}
        showPeek
      />,
    );
    expect(screen.getByText("Sent email")).toBeTruthy();
    expect(container.querySelector(".fl-receipt")).toBeTruthy();
    fireEvent.click(screen.getByText("details"));
    expect(screen.getByText("acme@example.com")).toBeTruthy();
  });

  it("shows NO receipt affordance for a settled READ call (no tier)", () => {
    const { container } = render(
      <ActivityStep
        step={{ kind: "tool", key: "s2", messageId: "m", toolName: "get_dashboard", state: "output-available", output: {} }}
        showPeek
      />,
    );
    expect(container.querySelector(".fl-receipt")).toBeNull();
  });
});
