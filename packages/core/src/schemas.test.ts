import { describe, expect, it } from "vitest";
import {
  agentRunReportSchema,
  approvalDecisionSchema,
  approvalRequestSchema,
  auditEventSchema,
  grantScopeSchema,
  guardDecisionSchema,
  permissionGrantSchema,
  runContextSchema,
  runModelSchema,
  triggerRefSchema,
  vendoErrorCodeSchema,
  toolDescriptorSchema,
  toolOutcomeSchema,
  triggerSourceSchema,
  vendoApprovalPartSchema,
  vendoThemeSchema,
  vendoViewPartSchema,
  type RunContext,
} from "./index.js";

const at = "2026-07-11T16:00:00.000Z";
const principal = { kind: "user" as const, subject: "user_1" };
const descriptor = {
  name: "host_invoices_list",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "read" as const,
};
const call = { id: "call_1", tool: descriptor.name, args: { limit: 10 } };
const approval = {
  id: "apr_1",
  call,
  descriptor,
  inputPreview: "List 10 invoices",
  ctx: { principal, venue: "chat" as const, presence: "present" as const, appId: "app_1" },
  createdAt: at,
};

describe("tool, grant, and approval schemas", () => {
  it("accepts contract-shaped descriptors and rejects names containing dots", () => {
    expect(toolDescriptorSchema.parse({ ...descriptor, future: true })).toMatchObject({ future: true });
    expect(toolDescriptorSchema.safeParse({ ...descriptor, name: "host.invoices.list" }).success).toBe(false);
  });

  it("accepts all grant scopes and a session grant", () => {
    for (const scope of [
      { kind: "tool" },
      { kind: "exact", inputHash: "sha256:abc", inputPreview: "limit 10" },
    ]) expect(grantScopeSchema.safeParse(scope).success).toBe(true);

    expect(permissionGrantSchema.safeParse({
      id: "grt_1",
      subject: "user_1",
      tool: descriptor.name,
      descriptorHash: "sha256:abc",
      scope: { kind: "tool" },
      duration: "session",
      contextKey: "session_1",
      source: "chat",
      grantedAt: at,
    }).success).toBe(true);
    expect(permissionGrantSchema.safeParse({
      id: "grant_1",
      subject: "user_1",
      tool: descriptor.name,
      descriptorHash: "sha256:abc",
      scope: { kind: "tool" },
      duration: "session",
      source: "chat",
      grantedAt: at,
    }).success).toBe(false);
  });

  it("accepts approval requests and remembered decisions", () => {
    expect(approvalRequestSchema.safeParse(approval).success).toBe(true);
    expect(approvalRequestSchema.safeParse({
      ...approval,
      invalidatedGrant: { id: "grt_stale", grantedAt: at },
    }).success).toBe(true);
    expect(approvalRequestSchema.safeParse({
      ...approval,
      invalidatedGrant: { id: "approval_stale", grantedAt: at },
    }).success).toBe(false);
    expect(approvalDecisionSchema.safeParse({
      approve: true,
      remember: { scope: { kind: "exact", inputHash: "sha256:args", inputPreview: "limit 10" }, duration: "task" },
    }).success).toBe(true);
  });
});

describe("outcome, guard, and audit schemas", () => {
  it("accepts exactly the five tool outcome variants", () => {
    for (const outcome of [
      { status: "ok", output: { invoices: [] } },
      { status: "error", error: { code: "upstream", message: "Unavailable", future: true } },
      { status: "pending-approval", approvalId: "apr_1" },
      { status: "blocked", reason: "Policy" },
      {
        status: "connect-required",
        connect: { connector: "composio", toolkit: "gmail", message: "Connect your gmail account" },
      },
    ]) expect(toolOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(toolOutcomeSchema.safeParse({ status: "waiting" }).success).toBe(false);
    expect(toolOutcomeSchema.safeParse({ status: "connect-required" }).success).toBe(false);
    expect(toolOutcomeSchema.safeParse({
      status: "connect-required",
      connect: { connector: "composio" },
    }).success).toBe(false);
  });

  it("enforces decidedBy sets on each guard action", () => {
    expect(guardDecisionSchema.safeParse({ action: "run", decidedBy: "grant", grantId: "grt_1" }).success).toBe(true);
    expect(guardDecisionSchema.safeParse({ action: "ask", decidedBy: "critical", approval }).success).toBe(true);
    expect(guardDecisionSchema.safeParse({ action: "block", decidedBy: "rule", reason: "Unsafe" }).success).toBe(true);
    expect(guardDecisionSchema.safeParse({ action: "run", decidedBy: "breaker" }).success).toBe(false);
    expect(guardDecisionSchema.safeParse({ action: "block", decidedBy: "grant", reason: "No" }).success).toBe(false);
  });

  it("accepts all audit decision sources and requires aud_ ids", () => {
    const base = {
      id: "aud_1",
      at,
      kind: "tool-call",
      principal,
      venue: "automation",
      presence: "away",
      outcome: "pending-approval",
    };
    for (const decidedBy of ["grant", "rule", "judge", "default", "critical", "breaker"]) {
      expect(auditEventSchema.safeParse({ ...base, decidedBy }).success).toBe(true);
    }
    expect(auditEventSchema.safeParse({ ...base, id: "event_1" }).success).toBe(false);
  });
});

describe("context, triggers, host reports, theme, and stream schemas", () => {
  it("validates run context and exactly-one schedule fields", () => {
    expect(runContextSchema.safeParse({
      principal,
      venue: "app",
      presence: "present",
      sessionId: "session_1",
      trigger: { runId: "run_1", kind: "schedule" },
    }).success).toBe(true);
    expect(triggerSourceSchema.safeParse({ kind: "schedule", cron: "0 9 * * 1" }).success).toBe(true);
    expect(triggerSourceSchema.safeParse({ kind: "schedule" }).success).toBe(false);
    expect(triggerSourceSchema.safeParse({ kind: "schedule", cron: "* * * * *", every: "1h" }).success).toBe(false);
  });

  it("error codes, trigger kinds, and run models are closed enums: unknown variants fail validation", () => {
    // Error codes: an unrecognized code is a parse failure, not a generic error.
    expect(vendoErrorCodeSchema.safeParse("rate-limited").success).toBe(false);
    expect(vendoErrorCodeSchema.safeParse("").success).toBe(false);
    expect(vendoErrorCodeSchema.safeParse(42).success).toBe(false);
    // Trigger kinds: an unknown kind fails; known kinds still validate their shape.
    expect(triggerSourceSchema.safeParse({ kind: "geo-fence", region: "EU" }).success).toBe(false);
    expect(triggerSourceSchema.safeParse({ kind: "host-event" }).success).toBe(false);
    // Run models: an unknown kind fails; a malformed KNOWN model still fails.
    expect(runModelSchema.safeParse({ kind: "workflow", graph: [] }).success).toBe(false);
    expect(runModelSchema.safeParse({ kind: "steps", steps: "nope" }).success).toBe(false);
    // TriggerRef rejects an unknown kind while still requiring a run id.
    expect(triggerRefSchema.safeParse({ runId: "run_1", kind: "geo-fence" }).success).toBe(false);
    expect(triggerRefSchema.safeParse({ runId: "job_1", kind: "geo-fence" }).success).toBe(false);
  });

  it("CORE-2: run context carries typed optional grant and mcpConsent (no structural twins)", () => {
    const base = {
      principal,
      venue: "automation",
      presence: "away",
      sessionId: "session_grant",
    };
    const grant = {
      id: "grt_1",
      subject: principal.subject,
      tool: "send_echo",
      descriptorHash: "sha256:abc",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: "2026-07-16T00:00:00.000Z",
    };
    expect(runContextSchema.safeParse({ ...base, grant }).success).toBe(true);
    expect(runContextSchema.safeParse({ ...base, grant: { id: "grt_1" } }).success).toBe(false);
    expect(runContextSchema.safeParse({
      ...base,
      venue: "mcp",
      mcpConsent: { clientId: "client_1", scopes: ["tools:run"] },
    }).success).toBe(true);
    expect(runContextSchema.safeParse({
      ...base,
      venue: "mcp",
      mcpConsent: { clientId: "client_1" },
    }).success).toBe(false);
    // Type-level: the fields are first-class on RunContext.
    const typed: RunContext = {
      principal,
      venue: "mcp",
      presence: "present",
      sessionId: "session_typed",
      mcpConsent: { clientId: "client_1", scopes: ["tools:run"] },
    };
    expect(typed.mcpConsent?.scopes).toEqual(["tools:run"]);
  });

  it("validates agent reports", () => {
    expect(agentRunReportSchema.safeParse({
      status: "ok",
      summary: "Listed invoices",
      toolCalls: [{ call, outcome: "ok" }],
    }).success).toBe(true);
  });

  it("validates a complete theme", () => {
    expect(vendoThemeSchema.safeParse({
      colors: {
        background: "#fff", surface: "#fff", text: "#111", muted: "#777",
        accent: "#00f", accentText: "#fff", danger: "#f00", border: "#ddd",
      },
      typography: { fontFamily: "Inter", baseSize: "16px" },
      radius: { small: "4px", medium: "8px", large: "16px" },
      density: "comfortable",
      motion: "reduced",
    }).success).toBe(true);
  });

  it("validates view and approval stream parts", () => {
    expect(vendoViewPartSchema.safeParse({
      type: "data-vendo-view",
      appId: "app_1",
      payload: { formatVersion: "future-ui/v2", opaque: true },
    }).success).toBe(true);
    expect(vendoApprovalPartSchema.safeParse({
      type: "data-vendo-approval",
      toolCallId: "call_1",
      risk: "destructive",
      approvalId: "apr_1",
    }).success).toBe(true);
    expect(vendoApprovalPartSchema.safeParse({
      type: "data-vendo-approval",
      toolCallId: "call_1",
      risk: "critical",
    }).success).toBe(false);
  });
});
