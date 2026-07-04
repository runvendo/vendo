import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { FlowletShellProvider } from "./context";
import type { TrustAuditRow, TrustGrantRow, TrustRuleRow, TrustSeam } from "./context";
import { useTrustData } from "./use-trust-data";

function wrap(trust?: TrustSeam) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(FlowletShellProvider, { trust }, children);
  };
}

describe("useTrustData", () => {
  it("empty/no-op when trust is absent", async () => {
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(undefined) });
    expect(result.current.grants).toEqual([]);
    expect(result.current.diary.total).toBe(0);
  });

  it("splits standing grants from automation-federated rows", async () => {
    const grants: TrustGrantRow[] = [
      { id: "g1", tool: "send_email", scopePreview: "to matches *@acme.co", since: "2026-07-01T00:00:00Z", source: "fade" },
      { tool: "GMAIL_SEND_EMAIL", scopePreview: "runs as agreed", since: "2026-07-01T00:00:00Z", source: "automation", automationName: "Morning chase" },
    ];
    const trust: TrustSeam = {
      listGrants: async () => grants, revokeGrant: async () => {}, queryAudit: async (): Promise<TrustAuditRow[]> => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      listRules: async () => [], revokeRule: async () => {},
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    await waitFor(() => expect(result.current.grants).toHaveLength(1));
    expect(result.current.automationGrants).toHaveLength(1);
    expect(result.current.automationGrants[0]?.automationName).toBe("Morning chase");
  });

  it("summarizes the diary from audit rows (reads/approved/automation runs/money moves)", async () => {
    const rows: TrustAuditRow[] = [
      { at: "1", kind: "tool_execution", toolName: "get_x", mutating: false },
      { at: "2", kind: "tool_execution", toolName: "send_email", mutating: true, dangerous: false },
      { at: "3", kind: "tool_execution", toolName: "transfer_money", mutating: true, dangerous: true },
      { at: "4", kind: "automation_firing" },
    ];
    const trust: TrustSeam = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => rows,
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      listRules: async () => [], revokeRule: async () => {},
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    // 1 read + 1 approved + 1 automation run + 1 money move — money moves
    // fold into the total too (review nit: a week of only money moves must
    // not read "handled 0 things").
    await waitFor(() => expect(result.current.diary.total).toBe(4));
    expect(result.current.diary).toMatchObject({ reads: 1, approved: 1, automationRuns: 1, moneyMoves: 1 });
  });

  it("a week of ONLY money moves is never counted as 0 (review nit)", async () => {
    const rows: TrustAuditRow[] = [
      { at: "1", kind: "tool_execution", toolName: "transfer_money", mutating: true, dangerous: true },
      { at: "2", kind: "tool_execution", toolName: "transfer_money", mutating: true, dangerous: true },
    ];
    const trust: TrustSeam = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => rows,
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      listRules: async () => [], revokeRule: async () => {},
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    await waitFor(() => expect(result.current.diary.moneyMoves).toBe(2));
    expect(result.current.diary.total).toBe(2);
  });

  it("fetches rules and exposes them alongside grants (ENG-193 item 6)", async () => {
    const rules: TrustRuleRow[] = [
      { id: "r1", toolPattern: "sendClientMessage", plainText: "emailing anyone at Acme", since: "2026-07-01T00:00:00Z" },
    ];
    const trust: TrustSeam = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      listRules: async () => rules, revokeRule: vi.fn().mockResolvedValue(undefined),
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    expect(result.current.rules[0]?.plainText).toBe("emailing anyone at Acme");
  });

  it("revokeRule calls trust.revokeRule and refreshes (ENG-193 item 6)", async () => {
    const listRules = vi.fn().mockResolvedValue([]);
    const revokeRule = vi.fn().mockResolvedValue(undefined);
    const trust: TrustSeam = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      listRules, revokeRule,
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    await result.current.revokeRule("r1");
    expect(revokeRule).toHaveBeenCalledWith("r1");
    expect(listRules).toHaveBeenCalledTimes(2); // initial + post-revoke refresh
  });

  it("empty/no-op for rules when trust is absent (ENG-193 item 6)", () => {
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(undefined) });
    expect(result.current.rules).toEqual([]);
  });

  it("revoke calls trust.revokeGrant and refreshes", async () => {
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    const listGrants = vi.fn().mockResolvedValue([]);
    const trust: TrustSeam = { listGrants, revokeGrant, queryAudit: async () => [], listCriticalTools: async () => [], resolveFadeProposal: async () => {}, listRules: async () => [], revokeRule: async () => {} };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrap(trust) });
    await result.current.revoke("g1");
    expect(revokeGrant).toHaveBeenCalledWith("g1");
    expect(listGrants).toHaveBeenCalledTimes(2); // initial + post-revoke refresh
  });
});
