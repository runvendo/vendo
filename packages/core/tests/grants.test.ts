/**
 * The ONE mint (01-core §5). The guard's decide path and the automations
 * engine's consent moment both build their grant here, so what a remembered yes
 * BECOMES is decided in one place — the width it covers, the context it is good
 * for, and the refs a listing finds it by.
 */
import { describe, expect, it } from "vitest";
import {
  buildGrant,
  descriptorHash,
  grantRefs,
  USE_SERVICE_TOOL,
  type ApprovalRequest,
  type ToolDescriptor,
} from "../src/index.js";

const descriptor: ToolDescriptor = {
  name: "host_send_email",
  description: "send an email",
  inputSchema: { type: "object" },
  risk: "write",
};

const request = (overrides: Partial<ApprovalRequest["ctx"]> = {}, tool = descriptor.name): ApprovalRequest => ({
  id: "apr_1",
  call: { id: "call_1", tool, args: { slug: "GMAIL_SEND_EMAIL" } },
  descriptor: { ...descriptor, name: tool },
  inputPreview: "send an email",
  ctx: {
    principal: { kind: "user", subject: "user_alice" },
    venue: "chat",
    presence: "present",
    sessionId: "session_1",
    ...overrides,
  },
  createdAt: "2026-08-14T00:00:00.000Z",
});

describe("buildGrant", () => {
  it("reads the subject, tool, descriptor hash and app off the REQUEST, never the caller", () => {
    const approved = request({ appId: "app_1" });
    const grant = buildGrant(
      { request: approved, remember: { duration: "standing" }, source: "automation" },
      "grt_1",
      "2026-08-14T00:00:01.000Z",
    );
    expect(grant).toMatchObject({
      id: "grt_1",
      subject: "user_alice",
      tool: "host_send_email",
      descriptorHash: descriptorHash(approved.descriptor),
      appId: "app_1",
      source: "automation",
      grantedAt: "2026-08-14T00:00:01.000Z",
    });
    expect(grant.triggerId).toBeUndefined();
    expect(grant.contextKey).toBeUndefined();
  });

  it("derives a connector dispatch's width from its SLUG and every other tool's from its name", () => {
    // "allow use_service_tool" would be consent to the broker's whole catalog.
    const dispatch = buildGrant(
      { request: request({}, USE_SERVICE_TOOL), remember: { duration: "standing" }, source: "automation" },
      "grt_2",
      "2026-08-14T00:00:00.000Z",
    );
    expect(dispatch.scope).toEqual({ kind: "service-tool", slug: "GMAIL_SEND_EMAIL" });
    const hostTool = buildGrant(
      { request: request(), remember: { duration: "standing" }, source: "chat" },
      "grt_3",
      "2026-08-14T00:00:00.000Z",
    );
    expect(hostTool.scope).toEqual({ kind: "tool" });
  });

  it("an explicit scope wins over the derived one", () => {
    const grant = buildGrant(
      {
        request: request({}, USE_SERVICE_TOOL),
        remember: { duration: "standing", scope: { kind: "exact", inputHash: "h", inputPreview: "p" } },
        source: "chat",
      },
      "grt_4",
      "2026-08-14T00:00:00.000Z",
    );
    expect(grant.scope).toEqual({ kind: "exact", inputHash: "h", inputPreview: "p" });
  });

  it("binds a session grant to the conversation and a task grant to the RUN", () => {
    const trigger = { id: "main", kind: "schedule" as const, runId: "run_9" };
    const session = buildGrant(
      { request: request({ trigger }), remember: { duration: "session" }, source: "chat" },
      "grt_5",
      "2026-08-14T00:00:00.000Z",
    );
    expect(session.contextKey).toBe("session_1");
    const task = buildGrant(
      { request: request({ trigger }), remember: { duration: "task" }, source: "chat" },
      "grt_6",
      "2026-08-14T00:00:00.000Z",
    );
    expect(task.contextKey).toBe("run_9");
    // No run to speak of and the conversation is the task.
    const chatTask = buildGrant(
      { request: request(), remember: { duration: "task" }, source: "chat" },
      "grt_7",
      "2026-08-14T00:00:00.000Z",
    );
    expect(chatTask.contextKey).toBe("session_1");
  });

  it("an explicit contextKey overrides the request's session — the parked row's own key", () => {
    const grant = buildGrant(
      { request: request(), remember: { duration: "session" }, source: "chat", contextKey: "session_parked" },
      "grt_8",
      "2026-08-14T00:00:00.000Z",
    );
    expect(grant.contextKey).toBe("session_parked");
  });

  it("carries the trigger it was armed for, so a sibling trigger never rides its yes", () => {
    const grant = buildGrant(
      {
        request: request({ appId: "app_1" }),
        remember: { duration: "standing" },
        source: "automation",
        triggerId: "nightly",
      },
      "grt_9",
      "2026-08-14T00:00:00.000Z",
    );
    expect(grant.triggerId).toBe("nightly");
  });
});

describe("grantRefs", () => {
  it("is the one spelling: subject, tool, and the app/trigger a ref-trusting adapter filters on", () => {
    const grant = buildGrant(
      {
        request: request({ appId: "app_1" }),
        remember: { duration: "standing" },
        source: "automation",
        triggerId: "nightly",
      },
      "grt_10",
      "2026-08-14T00:00:00.000Z",
    );
    expect(grantRefs(grant)).toEqual({
      subject: "user_alice",
      tool: "host_send_email",
      app_id: "app_1",
      trigger_id: "nightly",
    });
  });

  it("omits the app and trigger a chat grant does not have", () => {
    const grant = buildGrant(
      { request: request(), remember: { duration: "standing" }, source: "chat" },
      "grt_11",
      "2026-08-14T00:00:00.000Z",
    );
    expect(grantRefs(grant)).toEqual({ subject: "user_alice", tool: "host_send_email" });
  });
});
