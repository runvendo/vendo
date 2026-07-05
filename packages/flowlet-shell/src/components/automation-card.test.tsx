import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationCard, isAutomationApproval } from "./AutomationCard";

const snitchSpec = {
  dslVersion: 1,
  name: "Late-night delivery snitch",
  description: "Post to #general when a late-night food delivery charge posts",
  prompt: "snitch on me in #general if I order food delivery late at night",
  trigger: { type: "host_event", event: "transaction.created" },
  if: "trigger.direction = 'debit' and trigger.hour < 5",
  execution: {
    mode: "steps",
    steps: [
      {
        id: "snitch",
        type: "tool",
        tool: "SLACK_SEND_MESSAGE",
        input: { channel: "#general", text: "Late-night alert: {{ trigger.merchant }}" },
      },
    ],
  },
};

describe("isAutomationApproval", () => {
  it("matches only the automation authoring tools", () => {
    expect(isAutomationApproval("create_automation")).toBe(true);
    expect(isAutomationApproval("update_automation")).toBe(true);
    expect(isAutomationApproval("GMAIL_SEND_EMAIL")).toBe(false);
  });
});

describe("AutomationCard (proposal state)", () => {
  it("shows name, tier, trigger, guard, step targets, and the original ask", () => {
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ spec: snitchSpec, grantedTools: ["SLACK_SEND_MESSAGE"] }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText("Late-night delivery snitch")).toBeTruthy();
    expect(screen.getByText(/deterministic/i)).toBeTruthy();
    expect(screen.getAllByText(/transaction\.created/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/trigger\.hour < 5/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#general/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/snitch on me in #general/i).length).toBeGreaterThan(0);
  });

  it("marks granted tools as run-without-asking and ungated ones as ask-each-time", () => {
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ spec: snitchSpec, grantedTools: ["SLACK_SEND_MESSAGE"] }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/runs without asking/i)).toBeTruthy();
  });

  it("shows the un-granted state truthfully", () => {
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ spec: snitchSpec, grantedTools: [] }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/asks you each time/i)).toBeTruthy();
  });

  it("renders a hybrid spec's agent step with its goal and allowlist", () => {
    const hybrid = {
      ...snitchSpec,
      name: "Weekly digest",
      execution: {
        mode: "steps",
        steps: [
          { id: "fetch", type: "tool", tool: "maple_list_transactions", input: { limit: 200 } },
          {
            id: "digest",
            type: "agent",
            goal: "Write a friendly weekly digest",
            tools: [],
            input: {},
          },
        ],
      },
    };
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ spec: hybrid, grantedTools: [] }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/hybrid/i)).toBeTruthy();
    expect(screen.getAllByText(/Write a friendly weekly digest/).length).toBeGreaterThan(0);
  });

  it("approve and decline fire the callbacks", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ spec: snitchSpec, grantedTools: [] }}
        onApprove={onApprove}
        onDecline={onDecline}
      />,
    );
    fireEvent.click(screen.getByText("Approve automation"));
    fireEvent.click(screen.getByText("Decline"));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it("falls back to the generic approval card when the spec is malformed", () => {
    render(
      <AutomationCard
        toolName="create_automation"
        input={{ nonsense: true }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    // The generic ApprovalCard (post-#20 redesign, question-form title —
    // ENG-193 §3 Moment 3): the input rendered as labelled fields.
    expect(screen.getByText("Create an automation?")).toBeTruthy();
    expect(screen.getByText("Nonsense")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
  });
});
