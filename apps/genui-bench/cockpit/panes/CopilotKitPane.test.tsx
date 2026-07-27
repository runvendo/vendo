// @vitest-environment jsdom
/**
 * Pane contract: CopilotKitPane renders the adapter's harness intents through
 * our registered components and always carries its asymmetry footnote.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import CopilotKitPane from "./CopilotKitPane";
import type { CopilotKitRaw } from "../../lanes/copilotkit";
import type { LaneResult } from "../../runner/types";


const raw: CopilotKitRaw = {
  model: "anthropic/claude-sonnet-4.5",
  text: "Here are your account balances at a glance.",
  toolCalls: [
    { id: "call_ck_1", name: "host_listAccounts", arguments: {}, result: "[]" },
    {
      id: "call_ck_2",
      name: "chart",
      arguments: { title: "Account balances", data: [{ label: "Everyday Checking", value: 4280.12 }] },
      result: "rendered",
    },
  ],
  intents: [
    {
      name: "chart",
      props: {
        title: "Account balances",
        data: [
          { label: "Everyday Checking", value: 4280.12 },
          { label: "High-Yield Savings", value: 12904.55 },
        ],
      },
    },
  ],
  events: [],
};

const okResult: LaneResult = { status: "ok", startedAt: 0, durationMs: 900, raw };

afterEach(cleanup);

describe("CopilotKitPane", () => {
  it("renders intents through the harness registry with the asymmetry footnote", () => {
    const { container } = render(<CopilotKitPane lane="copilotkit" result={okResult} host="maple" runId="run_test" />);
    expect(container.querySelector('[data-harness="chart"]')).toBeTruthy();
    expect(screen.getByText("Account balances")).toBeTruthy();
    expect(screen.getByText("Everyday Checking")).toBeTruthy();
    expect(screen.getByText(/registered-components paradigm/)).toBeTruthy();
    // Host tool trace is visible; harness picks are not double-listed.
    expect(screen.getByText(/tool calls:/).textContent).toContain("host_listAccounts");
  });

  it("renders the no-key state", () => {
    render(<CopilotKitPane lane="copilotkit" result={{ status: "no-key" }} host="maple" runId="run_test" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state", () => {
    render(
      <CopilotKitPane
        lane="copilotkit"
        result={{ status: "failed", startedAt: 0, durationMs: 5, error: "runtime down" }}
        host="maple"
        runId="run_test"
      />,
    );
    expect(screen.getByText(/failed: runtime down/)).toBeTruthy();
  });
});
