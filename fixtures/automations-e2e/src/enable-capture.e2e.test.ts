import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, BOB, approve } from "./support.js";

const surface = ["host_invoices_list", "host_invoices_send"];

const trigger = {
  on: { kind: "host-event" as const, event: "invoice.ready" },
  run: {
    kind: "steps" as const,
    steps: [
      { id: "list", tool: surface[0] ?? "host_invoices_list" },
      { id: "send", tool: surface[1] ?? "host_invoices_send", args: { id: "event.id" } },
    ],
  },
};

describe("enable capture", () => {
  beforeEach(resetFixture);

  it("arms immediately, captures pending approvals, mints app-bound grants, and never transfers them", async () => {
    const stack = await createStack();
    try {
      const firstId = "app_enable_first";
      await stack.putApp(ADA.subject, automationDoc({ id: firstId, trigger }));

      const enabled = await stack.automations.enable(firstId, ownerCtx(ADA.subject, firstId));
      expect(enabled.enabled).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool).sort()).toEqual([...surface].sort());

      const approvals = await stack.sql<{
        id: string;
        subject: string;
        status: string;
        app_id: string | null;
        venue: string;
        presence: string;
      }>(
        `SELECT id, subject, status,
                request->'ctx'->>'appId' AS app_id,
                request->'ctx'->>'venue' AS venue,
                request->'ctx'->>'presence' AS presence
           FROM vendo_approvals
          WHERE subject = $1 AND status = 'pending'
          ORDER BY id`,
        [ADA.subject],
      );
      expect(approvals).toHaveLength(2);
      expect(approvals.map((row) => row.app_id)).toEqual([firstId, firstId]);
      // Capture approvals are minted FOR the automation (venue "automation")
      // while the user is present — the capture moment of 07 §3.
      expect(approvals.map((row) => [row.venue, row.presence])).toEqual([
        ["automation", "present"],
        ["automation", "present"],
      ]);
      expect((await stack.sql<{ enabled: boolean }>("SELECT enabled FROM vendo_apps WHERE id = $1", [firstId]))[0]?.enabled)
        .toBe(true);

      await approve(stack, enabled.missing);
      const grants = await stack.sql<{
        subject: string;
        tool: string;
        app_id: string | null;
        source: string;
        duration: string;
        scope: unknown;
      }>(
        `SELECT subject, tool, app_id, source, duration, scope
           FROM vendo_grants
          WHERE subject = $1 AND app_id = $2
          ORDER BY tool`,
        [ADA.subject, firstId],
      );
      expect(grants.map(({ subject, tool, app_id, source, duration }) => ({ subject, tool, app_id, source, duration })))
        .toEqual(surface.slice().sort().map((tool) => ({
          subject: ADA.subject,
          tool,
          app_id: firstId,
          source: "automation",
          duration: "standing",
        })));
      expect(grants.map((row) => row.scope)).toEqual([{ kind: "tool" }, { kind: "tool" }]);

      expect((await stack.automations.enable(firstId, ownerCtx(ADA.subject, firstId))).missing).toEqual([]);

      const secondId = "app_enable_second";
      await stack.putApp(ADA.subject, automationDoc({ id: secondId, trigger }));
      const second = await stack.automations.enable(secondId, ownerCtx(ADA.subject, secondId));
      expect(second.missing.map((request) => request.call.tool).sort()).toEqual([...surface].sort());
    } finally {
      await stack.close();
    }
  });

  it("does not mint a grant for a denied enable request", async () => {
    const stack = await createStack();
    try {
      const appId = "app_enable_denied";
      const deniedTool = "host_invoices_update";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.change" },
          run: { kind: "steps", steps: [{ id: "update", tool: deniedTool, args: { id: "event.id" } }] },
        },
      }));
      const result = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      expect(result.missing).toHaveLength(1);
      const request = result.missing[0];
      if (!request) throw new Error("Enable omitted the denied tool approval");
      await stack.guard.approvals.decide(request.id, { approve: false }, ADA);
      expect(await stack.sql("SELECT id FROM vendo_grants WHERE subject = $1 AND app_id = $2 AND tool = $3", [
        ADA.subject,
        appId,
        deniedTool,
      ])).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("lists trigger apps, reflects disable, and rejects non-owner enable without changing state", async () => {
    const stack = await createStack();
    try {
      const appId = "app_enable_owner";
      await stack.putApp(ADA.subject, automationDoc({ id: appId, trigger }));
      await expect(stack.automations.enable(appId, ownerCtx(BOB.subject, appId))).rejects.toBeInstanceOf(Error);
      expect((await stack.sql<{ enabled: boolean }>("SELECT enabled FROM vendo_apps WHERE id = $1", [appId]))[0]?.enabled)
        .toBe(false);

      await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      expect((await stack.automations.list(ownerCtx(ADA.subject))).map(({ app, enabled }) => ({ id: app.id, enabled })))
        .toEqual([{ id: appId, enabled: true }]);
      expect(await stack.automations.list(ownerCtx(BOB.subject))).toEqual([]);

      await stack.automations.disable(appId, ownerCtx(ADA.subject, appId));
      expect((await stack.automations.list(ownerCtx(ADA.subject))).map(({ app, enabled }) => ({ id: app.id, enabled })))
        .toEqual([{ id: appId, enabled: false }]);
    } finally {
      await stack.close();
    }
  });
});

/** Connector discovery (design 2026-08-03) put a whole third-party catalog
 * behind ONE tool name, `use_service_tool`. Arm-time capture is what lets an
 * automation reach it unattended, and the whole question is what the person is
 * asked to allow: the tool name means ~20,000 actions, so consent is captured
 * per SERVICE ACTION instead. */
describe("enable capture — connector service actions", () => {
  beforeEach(resetFixture);

  const serviceTrigger = {
    on: { kind: "host-event" as const, event: "digest.ready" },
    run: {
      kind: "steps" as const,
      steps: [
        { id: "list", tool: "host_invoices_list" },
        // Step args are JSONata, so a declared slug is a string literal.
        { id: "fetch", tool: "use_service_tool", args: { slug: "'GMAIL_FETCH_EMAILS'" } },
        { id: "status", tool: "use_service_tool", args: { slug: "'SLACK_SET_STATUS'" } },
      ],
    },
  };

  it("asks once per service action, in plain language, and grants each slug alone", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const appId = "app_service_capture";
      await stack.putApp(ADA.subject, automationDoc({ id: appId, name: "Morning digest", trigger: serviceTrigger }));

      const enabled = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      expect(enabled.enabled).toBe(true);

      // TWO connector asks, not one: the dispatcher's name is the same for both
      // and says nothing about what either does.
      const serviceAsks = enabled.missing.filter((request) => request.call.tool === "use_service_tool");
      expect(serviceAsks.map((request) => (request.call.args as { slug?: string }).slug).sort())
        .toEqual(["GMAIL_FETCH_EMAILS", "SLACK_SET_STATUS"]);
      expect(enabled.missing).toHaveLength(3);

      // The consent sentence is the existing one, with the service action in a
      // person's words — never an identifier (design §3's voice law).
      const previews = serviceAsks.map((request) => request.inputPreview);
      expect(previews).toContain(
        'Allow "Morning digest" to fetch emails in Gmail while you\'re away (standing, this app only)',
      );
      expect(previews).toContain(
        'Allow "Morning digest" to set status in Slack while you\'re away (standing, this app only)',
      );
      for (const preview of previews) {
        expect(preview).not.toContain("use_service_tool");
        expect(preview).not.toContain("_");
      }

      // The card states the grade the call will really run under — the broker's
      // own per-slug tag, reached through the same resolver the guard uses. The
      // dispatcher's own label is `ungraded` and would be a lie on both rows.
      expect(
        Object.fromEntries(serviceAsks.map((request) => [
          (request.call.args as { slug?: string }).slug,
          request.descriptor.risk,
        ])),
      ).toEqual({ GMAIL_FETCH_EMAILS: "read", SLACK_SET_STATUS: "write" });

      await approve(stack, enabled.missing);
      const grants = await stack.sql<{ tool: string; scope: { kind: string; slug?: string } }>(
        "SELECT tool, scope FROM vendo_grants WHERE subject = $1 ORDER BY tool, scope->>'slug'",
        [ADA.subject],
      );
      // The host tool keeps the tool-wide grant an automation has always minted;
      // each service action gets authority over ITSELF and nothing else.
      expect(grants).toEqual([
        { tool: "host_invoices_list", scope: { kind: "tool" } },
        { tool: "use_service_tool", scope: { kind: "service-tool", slug: "GMAIL_FETCH_EMAILS" } },
        { tool: "use_service_tool", scope: { kind: "service-tool", slug: "SLACK_SET_STATUS" } },
      ]);

      // Re-arming asks for nothing: a per-slug grant is recognised as covering
      // the action it names.
      expect((await stack.automations.enable(appId, ownerCtx(ADA.subject, appId))).missing).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("never asks for the dispatcher itself on an agentic automation", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const appId = "app_service_agentic";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "agentic.service" },
          run: { kind: "agentic", prompt: "read the inbox and summarise it" },
        },
      }));

      const enabled = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      const tools = enabled.missing.map((request) => request.call.tool);
      // An agentic run declares no slug, so there is nothing to consent to. A
      // tool-wide grant on the dispatcher would be the whole catalog behind one
      // card, so it is not offered at all — those calls park at fire time.
      expect(tools).not.toContain("use_service_tool");
      expect(tools).toContain("host_invoices_send");
      expect(await stack.sql("SELECT id FROM vendo_grants WHERE tool = 'use_service_tool'")).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
