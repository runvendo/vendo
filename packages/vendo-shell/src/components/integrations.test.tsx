import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IntegrationsPicker } from "./IntegrationsPicker";
import { ConnectCard } from "./ConnectCard";
import type { Integration } from "../seams/integrations";

const list: Integration[] = [
  { id: "plaid", name: "Plaid", connected: true },
  { id: "gmail", name: "Gmail", connected: false },
];

describe("IntegrationsPicker", () => {
  it("connects a disconnected integration", () => {
    const onConnect = vi.fn();
    render(<IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    expect(onConnect).toHaveBeenCalledWith("gmail");
  });

  it("shows a connecting state while the OAuth flow runs, then blooms green on success", async () => {
    let settle!: () => void;
    const onConnect = vi.fn(() => new Promise<void>((r) => { settle = r; }));
    const { rerender, container } = render(
      <IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    // In flight: the row shows a live connecting indicator, the + is gone.
    expect(container.querySelector(".fl-picker-item .fl-picker-connecting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Gmail/ })).toBeNull();
    // The flow lands: host refreshes the list, Gmail arrives connected.
    settle();
    const connected = list.map((i) => (i.id === "gmail" ? { ...i, connected: true } : i));
    rerender(
      <IntegrationsPicker integrations={connected} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => {
      const row = [...container.querySelectorAll(".fl-picker-item")].find((r) => r.textContent?.includes("Gmail"));
      expect(row?.className).toContain("is-connected");
      // Observed transition = celebration class; plain reopens never get it.
      expect(row?.className).toContain("is-just-connected");
    });
  });

  it("returns to the + affordance when the flow does not connect", async () => {
    let settle!: () => void;
    const onConnect = vi.fn(() => new Promise<void>((r) => { settle = r; }));
    render(<IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    settle(); // resolved, but the list still says disconnected (declined/failed)
    await waitFor(() => expect(screen.getByRole("button", { name: /Connect Gmail/ })).toBeTruthy());
  });

  it("drops the celebration when a just-connected row is disconnected with the tray open", async () => {
    let settle!: () => void;
    const onConnect = vi.fn(() => new Promise<void>((r) => { settle = r; }));
    const { rerender, container } = render(
      <IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    settle();
    const connected = list.map((i) => (i.id === "gmail" ? { ...i, connected: true } : i));
    rerender(
      <IntegrationsPicker integrations={connected} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector(".is-just-connected")).toBeTruthy());
    // Disconnect without closing: the + row must come back bloom-free.
    rerender(
      <IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector(".is-just-connected")).toBeNull();
    expect(screen.getByRole("button", { name: /Connect Gmail/ })).toBeTruthy();
  });

  it("connected rows on a fresh mount get no celebration class", () => {
    const connected = list.map((i) => ({ ...i, connected: true }));
    const { container } = render(
      <IntegrationsPicker integrations={connected} onConnect={() => {}} onDisconnect={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector(".is-just-connected")).toBeNull();
  });
});

describe("ConnectCard", () => {
  it("renders reason and triggers connect", () => {
    const onConnect = vi.fn();
    render(<ConnectCard integration={list[1]!} reason="read your invoices" onConnect={onConnect} />);
    expect(screen.getByText("So I can read your invoices.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("strips a leading 'To ' from an LLM reason instead of rendering 'So I can To …'", () => {
    // The reason field's own canonical examples are purpose clauses ("to
    // read the receipt"); the template supplies "So I can", so a leading
    // to-infinitive must be folded in, not concatenated (browser-observed:
    // "So I can To send you a weekly emailed summary…").
    render(
      <ConnectCard
        integration={list[1]!}
        reason="To send you a weekly emailed summary"
        onConnect={() => {}}
      />,
    );
    expect(screen.getByText("So I can send you a weekly emailed summary.")).toBeTruthy();

    render(<ConnectCard integration={list[1]!} reason="to read the receipt" onConnect={() => {}} />);
    expect(screen.getByText("So I can read the receipt.")).toBeTruthy();
  });

  it("leaves a reason that merely STARTS with 'to…' letters intact", () => {
    render(<ConnectCard integration={list[1]!} reason="total up your invoices" onConnect={() => {}} />);
    expect(screen.getByText("So I can total up your invoices.")).toBeTruthy();
  });
});

describe("IntegrationsPicker — loading state", () => {
  it("shows glass shimmer placeholder rows while the first list is in flight", () => {
    const { container } = render(
      <IntegrationsPicker integrations={[]} loading onConnect={() => {}} onDisconnect={() => {}} onClose={() => {}} />,
    );
    const placeholders = container.querySelectorAll(".fl-picker-grid .fl-glass-shimmer");
    expect(placeholders.length).toBeGreaterThan(0);
    expect(container.querySelector(".fl-picker-loading")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("never blanks an already-listed tray during a background refresh", () => {
    const { container } = render(
      <IntegrationsPicker integrations={list} loading onConnect={() => {}} onDisconnect={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector(".fl-picker-loading")).toBeNull();
    expect(screen.getByText("Gmail")).toBeTruthy();
  });

  it("shows no placeholders once loading settles on an empty catalog", () => {
    const { container } = render(
      <IntegrationsPicker integrations={[]} onConnect={() => {}} onDisconnect={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector(".fl-picker-loading")).toBeNull();
  });
});
