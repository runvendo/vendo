import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FlowletAgent } from "@flowlet/core";
import { FlowletProvider, useFlowletChat } from "@flowlet/react";
import { FlowletShellProvider } from "./context";
import { FlowletThread } from "./FlowletThread";

/** An agent whose stream dies immediately with a raw provider-style error. */
function failingAgent(rawMessage: string): FlowletAgent {
  return {
    run: () =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error(rawMessage));
        },
      }),
  };
}

function ResetButton() {
  const chat = useFlowletChat();
  return (
    <button
      type="button"
      onClick={() => {
        chat.stop();
        chat.clearError();
        chat.setMessages([]);
      }}
    >
      reset-thread
    </button>
  );
}

const RAW =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function renderThread() {
  return render(
    <FlowletProvider agent={failingAgent(RAW)} components={[]}>
      <FlowletShellProvider impls={{}}>
        <ResetButton />
        <FlowletThread suggestions={["hi"]} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("thread error banner", () => {
  it("maps a raw provider error to friendly copy with a Retry action", async () => {
    renderThread();
    fireEvent.click(screen.getByText("hi"));
    const alert = await waitFor(() => {
      const el = screen.getAllByRole("alert").find((a) => a.textContent?.trim());
      if (!el) throw new Error("no alert yet");
      return el;
    });
    expect(alert.textContent).not.toMatch(/anthropic|billing|credit/i);
    expect(alert.textContent).toMatch(/try again/i);
    // Raw detail survives for debugging on the title attribute.
    expect(alert.getAttribute("title")).toContain("Anthropic");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not survive a thread reset", async () => {
    renderThread();
    fireEvent.click(screen.getByText("hi"));
    await waitFor(() => screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByText("reset-thread"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });
});
