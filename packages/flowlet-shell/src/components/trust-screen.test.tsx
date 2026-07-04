import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { FlowletShellProvider } from "../context";
import type { TrustAuditRow, TrustGrantRow, TrustSeam } from "../context";
import { TrustScreen } from "./TrustScreen";

const GRANTS: TrustGrantRow[] = [
  { id: "g1", tool: "send_email", scopePreview: "to matches *@acme.co", since: "2026-07-01T00:00:00Z", source: "fade" },
  { tool: "GMAIL_SEND_EMAIL", scopePreview: "runs as agreed", since: "2026-07-01T00:00:00Z", source: "automation", automationName: "Morning chase" },
];

const AUDIT: TrustAuditRow[] = [
  { at: "2026-07-01T00:00:00Z", kind: "tool_execution", toolName: "get_x", mutating: false },
  { at: "2026-07-01T01:00:00Z", kind: "tool_execution", toolName: "send_email", mutating: true, dangerous: false },
  { at: "2026-07-01T02:00:00Z", kind: "tool_execution", toolName: "transfer_money", mutating: true, dangerous: true },
  { at: "2026-07-01T03:00:00Z", kind: "automation_firing" },
];

function stubTrust(overrides: Partial<TrustSeam> = {}): TrustSeam {
  return {
    listGrants: async () => GRANTS,
    revokeGrant: vi.fn(async () => {}),
    queryAudit: async () => AUDIT,
    listCriticalTools: async () => [{ name: "transfer_money" }],
    resolveFadeProposal: async () => {},
    ...overrides,
  };
}

describe("TrustScreen (ENG-193 §3 Moment 12)", () => {
  it("renders all five section headings", async () => {
    render(
      <FlowletShellProvider trust={stubTrust()}>
        <TrustScreen onClose={() => {}} />
      </FlowletShellProvider>,
    );
    await waitFor(() => screen.getByText(/Handled without asking/i));
    expect(screen.getByText(/Handled without asking/i)).toBeTruthy();
    expect(screen.getByText(/^Automations$/i)).toBeTruthy();
    expect(screen.getByText(/Always needs you/i)).toBeTruthy();
    expect(screen.getByText(/Activity —/i)).toBeTruthy();
  });

  it("shows an 'Ask me again' button for a standing grant and calls revokeGrant", async () => {
    const revokeGrant = vi.fn(async () => {});
    render(
      <FlowletShellProvider trust={stubTrust({ revokeGrant })}>
        <TrustScreen onClose={() => {}} />
      </FlowletShellProvider>,
    );
    await waitFor(() => screen.getByText(/Ask me again/i));
    fireEvent.click(screen.getByText(/Ask me again/i));
    expect(revokeGrant).toHaveBeenCalledWith("g1");
  });

  it("shows no revoke control for an automation-federated row", async () => {
    render(
      <FlowletShellProvider trust={stubTrust()}>
        <TrustScreen onClose={() => {}} />
      </FlowletShellProvider>,
    );
    await waitFor(() => screen.getByText(/Morning chase/i));
    // Exactly one "Ask me again" button total — the automation row gets none.
    expect(screen.getAllByText(/Ask me again/i)).toHaveLength(1);
  });

  it("renders the diary sentence with the right numbers", async () => {
    render(
      <FlowletShellProvider trust={stubTrust()}>
        <TrustScreen onClose={() => {}} />
      </FlowletShellProvider>,
    );
    await waitFor(() => screen.getByText(/This week I handled/i));
    const diary = screen.getByText(/This week I handled/i).textContent ?? "";
    // 4, not 3 — money moves fold into the total too (review nit: a week of
    // only money moves must not read "handled 0 things").
    expect(diary).toMatch(/4 things/);
    expect(diary).toMatch(/1 reads/);
    expect(diary).toMatch(/1 action you approved/);
    expect(diary).toMatch(/1 ran in/);
    expect(diary).toMatch(/Money moves: 1/);
  });

  it("fires onClose from the close control", async () => {
    const onClose = vi.fn();
    render(
      <FlowletShellProvider trust={stubTrust()}>
        <TrustScreen onClose={onClose} />
      </FlowletShellProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
