import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
});

describe("ConnectCard", () => {
  it("renders reason and triggers connect", () => {
    const onConnect = vi.fn();
    render(<ConnectCard integration={list[1]!} reason="read your invoices" onConnect={onConnect} />);
    expect(screen.getByText(/read your invoices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
