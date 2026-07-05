import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VendoAgent } from "@vendoai/core";
import { VendoProvider, useVendoChat } from "@vendoai/react";
import { VendoShellProvider } from "./context";
import { VendoThread } from "./VendoThread";

/** An agent whose stream dies immediately with a raw provider-style error. */
function failingAgent(rawMessage: string): VendoAgent {
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
  const chat = useVendoChat();
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

const BILLING_RAW =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function renderThread(raw: string) {
  return render(
    <VendoProvider agent={failingAgent(raw)} components={[]}>
      <VendoShellProvider impls={{}}>
        <ResetButton />
        <VendoThread suggestions={["hi"]} />
      </VendoShellProvider>
    </VendoProvider>,
  );
}

async function firstAlert() {
  return waitFor(() => {
    const el = screen.getAllByRole("alert").find((a) => a.textContent?.trim());
    if (!el) throw new Error("no alert yet");
    return el;
  });
}

describe("thread error banner", () => {
  it("maps a raw provider error to friendly copy — raw text reaches neither text nor attributes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = renderThread(BILLING_RAW);
    fireEvent.click(screen.getByText("hi"));
    const alert = await firstAlert();
    expect(alert.textContent).not.toMatch(/anthropic|billing|credit/i);
    expect(alert.textContent).toMatch(/service limit/i);
    // The DOM as a whole must not carry the provider text (title attrs leak to
    // hover tooltips and the accessibility tree).
    expect(container.innerHTML).not.toContain("Anthropic");
    expect(alert.hasAttribute("title")).toBe(false);
    // Developers still get the raw detail on the console.
    expect(spy.mock.calls.some((c) => c.join(" ").includes("Anthropic"))).toBe(true);
    spy.mockRestore();
  });

  it("billing errors offer no Retry (it would fail again); transport errors do", async () => {
    renderThread(BILLING_RAW);
    fireEvent.click(screen.getByText("hi"));
    await firstAlert();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a retryable error shows Retry", async () => {
    renderThread("Failed to fetch");
    fireEvent.click(screen.getByText("hi"));
    await firstAlert();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not survive a thread reset", async () => {
    renderThread(BILLING_RAW);
    fireEvent.click(screen.getByText("hi"));
    await firstAlert();
    fireEvent.click(screen.getByText("reset-thread"));
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").filter((a) => a.textContent?.trim());
      expect(alerts).toHaveLength(0);
    });
  });
});
