import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingText } from "./StreamingText";
import { ToolCall } from "./ToolCall";

describe("StreamingText", () => {
  it("renders text and shows a caret while streaming", () => {
    const { rerender, container } = render(<StreamingText text="hello" />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(container.querySelector(".fl-caret")).toBeNull();
    rerender(<StreamingText text="hello" streaming />);
    expect(container.querySelector(".fl-caret")).not.toBeNull();
  });
});

describe("ToolCall", () => {
  it("shows a friendly label instead of the raw slug", () => {
    render(<ToolCall toolName="get_transactions" state="output-available" />);
    expect(screen.getByText("Reading transactions")).toBeTruthy();
    // The raw slug and SDK state string are never surfaced to the user.
    expect(screen.queryByText(/get_transactions/)).toBeNull();
    expect(screen.queryByText(/output-available/)).toBeNull();
  });

  it("maps Gmail/Slack slugs to friendly labels", () => {
    const { rerender } = render(<ToolCall toolName="GMAIL_FETCH_EMAILS" state="input-available" />);
    expect(screen.getByText("Searching Gmail")).toBeTruthy();
    rerender(<ToolCall toolName="SLACK_SEND_MESSAGE" state="input-available" />);
    expect(screen.getByText("Posting to Slack")).toBeTruthy();
  });

  it("reflects the SDK state machine: working -> done -> error", () => {
    const { container, rerender } = render(<ToolCall toolName="set_rule" state="input-streaming" />);
    expect(container.querySelector(".fl-tool-working")).not.toBeNull();

    rerender(<ToolCall toolName="set_rule" state="output-available" />);
    expect(container.querySelector(".fl-tool-done")).not.toBeNull();

    rerender(<ToolCall toolName="set_rule" state="output-error" errorText="nope" />);
    expect(container.querySelector(".fl-tool-error")).not.toBeNull();
    expect(screen.getByText("nope")).toBeTruthy();
  });
});
