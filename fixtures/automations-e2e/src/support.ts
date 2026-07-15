import type {
  AppId,
  ApprovalRequest,
  Json,
  Principal,
  ToolOutcome,
} from "@vendoai/core";
import type { RunRecord, RunStatus } from "@vendoai/automations";
import { expect } from "vitest";
import {
  fixtureBaseUrl,
  fixtureFetch,
  loginCookie,
  type Stack,
} from "./harness.js";

export const ADA: Principal = { kind: "user", subject: "user_ada" };
export const BOB: Principal = { kind: "user", subject: "user_bob" };

export interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: string;
  memo: string;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export function rowsCount(rows: Array<{ count: unknown }>): number {
  return Number(rows[0]?.count ?? 0);
}

export async function tableCount(
  stack: Stack,
  table: "vendo_runs" | "vendo_approvals" | "vendo_audit",
): Promise<number> {
  return rowsCount(await stack.sql<{ count: unknown }>(`SELECT COUNT(*)::int AS count FROM ${table}`));
}

export async function approve(
  stack: Stack,
  requests: ApprovalRequest[],
  principal: Principal = ADA,
): Promise<void> {
  if (requests.length === 0) return;
  await stack.guard.approvals.decide(
    requests.map((request) => request.id),
    { approve: true },
    principal,
  );
}

export async function enableAndApprove(
  stack: Stack,
  appId: AppId,
  ctx: Parameters<Stack["automations"]["enable"]>[1],
): Promise<ApprovalRequest[]> {
  const enabled = await stack.automations.enable(appId, ctx);
  await approve(stack, enabled.missing, ctx.principal);
  return enabled.missing;
}

export async function fixtureInvoices(subject = ADA.subject): Promise<Invoice[]> {
  const cookie = await loginCookie(subject);
  const response = await fixtureFetch(`${fixtureBaseUrl()}/api/invoices`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const body = record(await response.json());
  const invoices = body.invoices;
  if (!Array.isArray(invoices)) throw new Error("Fixture response omitted invoices[]");
  return invoices.map((value) => {
    const invoice = record(value);
    return {
      id: String(invoice.id),
      customerId: String(invoice.customerId),
      amountCents: Number(invoice.amountCents),
      currency: String(invoice.currency),
      status: String(invoice.status),
      memo: String(invoice.memo),
    };
  });
}

export async function waitForRun(
  stack: Stack,
  runId: string,
  ctx: Parameters<Stack["automations"]["runs"]["get"]>[1],
  status: RunStatus,
): Promise<RunRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    const run = await stack.automations.runs.get(runId, ctx);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const latest = await stack.automations.runs.get(runId, ctx);
  throw new Error(`Run ${runId} did not reach ${status}; last status was ${latest?.status ?? "missing"}`);
}

export function outcomeStatus(outcome: ToolOutcome): ToolOutcome["status"] {
  return outcome.status;
}

export function asJson(value: unknown): Json {
  return value as Json;
}
