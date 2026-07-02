import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { type UINode } from "@flowlet/core";
import { createStubAgent } from "@flowlet/core/testing";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";

describe("ApprovalCard", () => {
  it("calls onApprove and onDecline", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<ApprovalCard toolName="budgetCreate" input={{ cap: 2000 }} onApprove={onApprove} onDecline={onDecline} />);
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Decline"));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it("shows a friendly request title — never the raw tool slug or raw JSON", () => {
    const { container } = render(
      <ApprovalCard
        toolName="GMAIL_CREATE_EMAIL_DRAFT"
        input={{ recipient_email: "a@b.com", subject: "Hi", body: "Hello", cc: [], is_html: false }}
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Create Gmail email draft")).toBeTruthy();
    expect(container.textContent).not.toContain("GMAIL_CREATE_EMAIL_DRAFT");
    expect(container.textContent).not.toContain("{");
  });

  it("renders parameters as labelled fields and hides empty ones", () => {
    render(
      <ApprovalCard
        toolName="GMAIL_CREATE_EMAIL_DRAFT"
        input={{ recipient_email: "a@b.com", subject: "Hi", cc: [], bcc: [], extra_recipients: [] }}
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByText("Recipient email")).toBeTruthy();
    expect(screen.getByText("a@b.com")).toBeTruthy();
    expect(screen.getByText("Subject")).toBeTruthy();
    expect(screen.queryByText("Cc")).toBeNull();
    expect(screen.queryByText("Bcc")).toBeNull();
  });

  it("renders a bare title card for empty input", () => {
    const { container } = render(
      <ApprovalCard toolName="SLACK_API_TEST" input={{}} onApprove={() => {}} onDecline={() => {}} />,
    );
    expect(screen.getByText("Check Slack")).toBeTruthy();
    expect(container.querySelector(".fl-approval-fields")).toBeNull();
  });
});

describe("UINodeView", () => {
  it("delegates rendering to the shell renderNode", () => {
    const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered">ok</div>}>
          <UINodeView node={node} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });
});
