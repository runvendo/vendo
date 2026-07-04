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
    fireEvent.click(screen.getByText("Send it"));
    fireEvent.click(screen.getByText("No"));
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
    expect(screen.getByText("Create Gmail email draft?")).toBeTruthy();
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
    expect(screen.getByText("Check Slack?")).toBeTruthy();
    expect(container.querySelector(".fl-approval-fields")).toBeNull();
  });

  it("uses the question-form title, not the imperative request", () => {
    render(<ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{ to: "acme@example.com" }} onApprove={() => {}} onDecline={() => {}} />);
    expect(screen.getByText("Send email?")).toBeTruthy();
  });

  it("renders the ceremony variant for a critical tier: amber class, consequence line, named button", () => {
    const { container } = render(
      <ApprovalCard
        toolName="transfer_money"
        input={{ amount: 1200, recipient: "Vendo Inc" }}
        tier="critical"
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(container.querySelector(".fl-approval--ceremony")).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    expect(screen.getByText("Confirm transfer money")).toBeTruthy();
  });

  it("does not truncate material fields on a critical card even past 160 chars", () => {
    const long = "x".repeat(300);
    render(
      <ApprovalCard toolName="transfer_money" input={{ note: long }} tier="critical" onApprove={() => {}} onDecline={() => {}} />,
    );
    expect(screen.getByText(long)).toBeTruthy();
  });

  it("shows an unverified tag when the tool carries no annotation hints", () => {
    render(
      <ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{}} tier="act" unverified onApprove={() => {}} onDecline={() => {}} />,
    );
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });

  it("act-tier (default) still truncates and keeps the plain 'Send it'/'No' buttons", () => {
    const long = "x".repeat(300);
    render(<ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{ note: long }} onApprove={() => {}} onDecline={() => {}} />);
    expect(screen.queryByText(long)).toBeNull();
    expect(screen.getByText("Send it")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
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
