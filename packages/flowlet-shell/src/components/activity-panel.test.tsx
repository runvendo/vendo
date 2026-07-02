import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityPanel } from "./ActivityPanel";
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
});
