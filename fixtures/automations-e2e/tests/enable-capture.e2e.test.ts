/** Arming a RECORD is the consent moment, against the real store and the real
 * guard. What a yes mints is authority over THAT automation and nothing else:
 * the grant is keyed to the record's id, it names no app (a record has none),
 * and a second record of the same owner declaring the same tools is asked in
 * full.
 */
import type { CreateAutomationInput } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomation, createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, BOB, approve } from "../src/support.js";

/** Two tools a standing grant can really buy. Neither is destructive,
 *  `ungraded`, or confirm-each on purpose: arming captures only the powers a
 *  firing could hold, so `host_invoices_send` — which this record declared
 *  until 2026-08-18 — is never carded and never granted, THE LAW refusing it
 *  away whatever the owner answers. What a yes MINTS is this file's subject, so
 *  the surface has to be two tools a yes can actually mint. */
const surface = ["host_invoices_list", "host_invoices_update"];

/** A disarmed steps record, so `enable` is what arms it and captures for it. */
const stepsRecord = (event: string): CreateAutomationInput => ({
  owner: ADA,
  when: { event },
  task: {
    kind: "steps",
    steps: [
      { id: "list", tool: "host_invoices_list" },
      { id: "update", tool: "host_invoices_update", args: { id: "event.id" } },
    ],
  },
  authoredBy: "chat",
  armed: false,
});

const create = (stack: Stack, input: CreateAutomationInput) =>
  createAutomation(stack, input, ownerCtx(ADA.subject));

describe("enable capture", () => {
  beforeEach(resetFixture);

  it("arms immediately, captures pending approvals, mints record-bound grants, and never transfers them", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const first = await create(stack, stepsRecord("invoice.ready"));

      const enabled = await stack.automations.enable(first.id, ctx);
      expect(enabled.enabled).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool).sort()).toEqual([...surface].sort());
      // ONE set for the whole consent moment, so a single decision can settle
      // every ask it raised — and it is STABLE while those asks are still open,
      // which is what makes a re-arm join the same decision instead of opening a
      // second one nobody was shown.
      expect(enabled.grantSetId).toMatch(/^gset_/);
      expect((await stack.automations.enable(first.id, ctx)).grantSetId).toBe(enabled.grantSetId);

      const approvals = await stack.sql<{ venue: string; presence: string; app_id: string | null }>(
        `SELECT request->'ctx'->>'venue' AS venue,
                request->'ctx'->>'presence' AS presence,
                request->'ctx'->>'appId' AS app_id
           FROM vendo_approvals
          WHERE subject = $1 AND status = 'pending'
          ORDER BY id`,
        [ADA.subject],
      );
      // Capture approvals are minted FOR the automation (venue "automation")
      // while the user is present — the capture moment of 07 §3 — and they name
      // no app at all, because a record has none to name.
      expect(approvals).toEqual([
        { venue: "automation", presence: "present", app_id: null },
        { venue: "automation", presence: "present", app_id: null },
      ]);
      expect((await stack.sql<{ armed: boolean }>("SELECT armed FROM vendo_automations WHERE id = $1", [first.id]))[0]?.armed)
        .toBe(true);

      await approve(stack, enabled.missing);
      const grants = await stack.sql<{
        subject: string;
        tool: string;
        automation_id: string | null;
        app_id: string | null;
        source: string;
        duration: string;
        scope: unknown;
      }>(
        `SELECT subject, tool, automation_id, app_id, source, duration, scope
           FROM vendo_grants
          WHERE subject = $1
          ORDER BY tool`,
        [ADA.subject],
      );
      expect(grants).toEqual([...surface].sort().map((tool) => ({
        subject: ADA.subject,
        tool,
        automation_id: first.id,
        app_id: null,
        source: "automation",
        duration: "standing",
        scope: { kind: "tool" },
      })));

      // Re-arming asks for nothing…
      expect((await stack.automations.enable(first.id, ctx)).missing).toEqual([]);
      // …and a SECOND record of the same owner, declaring the same tools, is
      // asked in full: authority is the record's and is never handed over.
      const second = await create(stack, stepsRecord("invoice.ready.again"));
      expect((await stack.automations.enable(second.id, ctx)).missing.map((request) => request.call.tool).sort())
        .toEqual([...surface].sort());
    } finally {
      await stack.close();
    }
  });

  it("does not mint a grant for a denied enable request", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const deniedTool = "host_invoices_update";
      const record = await create(stack, {
        owner: ADA,
        when: { event: "invoice.change" },
        task: { kind: "steps", steps: [{ id: "update", tool: deniedTool, args: { id: "event.id" } }] },
        authoredBy: "chat",
        armed: false,
      });
      const result = await stack.automations.enable(record.id, ctx);
      expect(result.missing).toHaveLength(1);
      const request = result.missing[0];
      if (!request) throw new Error("Enable omitted the denied tool approval");
      await stack.guard.approvals.decide(request.id, { approve: false }, ADA);
      expect(await stack.sql(
        "SELECT id FROM vendo_grants WHERE subject = $1 AND automation_id = $2 AND tool = $3",
        [ADA.subject, record.id, deniedTool],
      )).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("lists the owner's records, reflects disable, and rejects a non-owner enable without changing state", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const record = await create(stack, stepsRecord("invoice.owner"));
      await expect(stack.automations.enable(record.id, ownerCtx(BOB.subject)))
        .rejects.toMatchObject({ code: "not-found" });
      expect((await stack.automations.get(record.id, ctx))?.armed).toBe(false);

      await stack.automations.enable(record.id, ctx);
      expect((await stack.automations.list({ owner: ADA.subject }, ctx)).map(({ id, armed }) => ({ id, armed })))
        .toEqual([{ id: record.id, armed: true }]);
      expect(await stack.automations.list({}, ownerCtx(BOB.subject))).toEqual([]);

      // Disable is a PERSON's kill switch, and the row says so — a reconcile
      // reads that stamp and never re-arms behind their back.
      await stack.automations.disable(record.id, ctx);
      expect(await stack.automations.get(record.id, ctx)).toMatchObject({ armed: false, disarmedBy: "user" });
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

  it("asks once per service action, in plain language, and grants each slug alone", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const ctx = ownerCtx(ADA.subject);
      const record = await create(stack, {
        owner: ADA,
        when: { event: "digest.ready" },
        task: {
          kind: "steps",
          steps: [
            { id: "list", tool: "host_invoices_list" },
            // Step args are JSONata, so a declared slug is a string literal.
            { id: "fetch", tool: "use_service_tool", args: { slug: "'GMAIL_FETCH_EMAILS'" } },
            { id: "status", tool: "use_service_tool", args: { slug: "'SLACK_SET_STATUS'" } },
          ],
        },
        authoredBy: "chat",
        armed: false,
      });

      const enabled = await stack.automations.enable(record.id, ctx);
      expect(enabled.enabled).toBe(true);

      // TWO connector asks, not one: the dispatcher's name is the same for both
      // and says nothing about what either does.
      const serviceAsks = enabled.missing.filter((request) => request.call.tool === "use_service_tool");
      expect(serviceAsks.map((request) => (request.call.args as { slug?: string }).slug).sort())
        .toEqual(["GMAIL_FETCH_EMAILS", "SLACK_SET_STATUS"]);
      expect(enabled.missing).toHaveLength(3);

      // The consent sentence names the service action in a person's words —
      // never an identifier (design §3's voice law).
      const previews = serviceAsks.map((request) => request.inputPreview);
      expect(previews.some((preview) => preview.includes("fetch emails in Gmail"))).toBe(true);
      expect(previews.some((preview) => preview.includes("set status in Slack"))).toBe(true);
      for (const preview of previews) {
        expect(preview).toContain("while you're away");
        // The ACTION is said in words: neither the dispatcher's name nor the
        // broker's slug may appear, because neither says what the call does.
        expect(preview).not.toContain("use_service_tool");
        expect(preview).not.toContain("GMAIL_");
        expect(preview).not.toContain("SLACK_");
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
        "SELECT tool, scope FROM vendo_grants WHERE automation_id = $1 ORDER BY tool, scope->>'slug'",
        [record.id],
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
      expect((await stack.automations.enable(record.id, ctx)).missing).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("never asks for the dispatcher itself on a goal task, and never grants it tool-wide", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const ctx = ownerCtx(ADA.subject);
      const record = await create(stack, {
        owner: ADA,
        when: { event: "agentic.service" },
        task: { kind: "goal", prompt: "read the inbox and summarise it" },
        authoredBy: "chat",
        armed: false,
      });

      const enabled = await stack.automations.enable(record.id, ctx);
      const tools = enabled.missing.map((request) => request.call.tool);
      // A goal names no slug, so there is nothing to consent to. A tool-wide
      // grant on the dispatcher would be the broker's whole catalog behind one
      // card, so it is not offered at all — those calls fail loudly at fire time.
      expect(tools).not.toContain("use_service_tool");
      // The fallback is still WIDE — every bound tool the run could really
      // reach away is offered…
      expect(tools).toContain("host_invoices_list");
      // …and `host_invoices_send` is not one of them. It is `destructive`, so
      // THE LAW refuses it away whatever this person answers: asking them to
      // allow it while they are away is a question with no true answer.
      expect(tools).not.toContain("host_invoices_send");

      await approve(stack, enabled.missing);
      expect(await stack.sql("SELECT id FROM vendo_grants WHERE tool = 'use_service_tool'")).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
