import type {
  ApprovalRequest,
  AutomationId,
  Json,
  Principal,
  ToolOutcome,
} from "@vendoai/core";
import type { RunRecord, RunStatus } from "@vendoai/automations";
import { expect } from "vitest";
import {
  ADA,
  fixtureBaseUrl,
  fixtureFetch,
  loginCookie,
  type Stack,
} from "./harness.js";

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
  table: "vendo_runs" | "vendo_approvals" | "vendo_audit" | "vendo_automations",
): Promise<number> {
  return rowsCount(await stack.sql<{ count: unknown }>(`SELECT COUNT(*)::int AS count FROM ${table}`));
}

/** Runs of ONE automation, off the row rather than the door — the "it really
 *  fired" probe a run-list filter could not fake. */
export async function runCount(stack: Stack, automationId: AutomationId): Promise<number> {
  return rowsCount(await stack.sql<{ count: unknown }>(
    "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE automation_id = $1",
    [automationId],
  ));
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
  automationId: AutomationId,
  ctx: Parameters<Stack["automations"]["enable"]>[1],
): Promise<ApprovalRequest[]> {
  const enabled = await stack.automations.enable(automationId, ctx);
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
  // The test timeout is the hang-detector; this budget stays well inside it so
  // a busy machine reports a slow run, never a product bug.
  const deadline = Date.now() + 60_000;
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
