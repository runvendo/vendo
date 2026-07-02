/**
 * Embedded automations world: the demo beat as data. The "morning document
 * chase" is created through the authoring tool exactly as the chat agent
 * compiles it, then force-fired — emailing every missing-docs client and
 * booking calls for everyone within 3 days of a deadline, through the
 * (stubbed) Gmail/Calendar senders.
 */
import { describe, expect, it, vi } from "vitest";
import type { Tool, ToolCallOptions } from "ai";
import { createAutomationsWorld } from "./automations";
import type { ComposioFireResult } from "./composio-fire";
import { __reseed } from "@/server/store";

const CALL_OPTS = { toolCallId: "tc", messages: [] } as unknown as ToolCallOptions;

const OK: ComposioFireResult = { ok: true, detail: null };

/** The 8 seeded clients still missing documents (dashboard hero number). */
const MISSING_DOCS_EMAILS = [
  "yousef+rivera@vendo.run",
  "yousef+chen@vendo.run",
  "yousef+delgado@vendo.run",
  "yousef+harborview@vendo.run",
  "yousef+foster@vendo.run",
  "yousef+patel@vendo.run",
  "yousef+kim@vendo.run",
  "yousef+cortez@vendo.run",
];

/** The morning-chase spec exactly as the compiler emits it (the demo beat). */
function morningChaseSpec() {
  return {
    dslVersion: 1,
    name: "Morning document chase",
    description:
      "Every morning, email every client still missing documents, and book a call " +
      "with anyone within 3 days of their filing deadline.",
    prompt:
      "every morning, email any clients missing docs. If anyone is within 3 days of " +
      "a deadline, book a call with them on my calendar",
    trigger: { type: "schedule", cron: "0 8 * * *", timezone: "America/Los_Angeles" },
    execution: {
      mode: "steps",
      steps: [
        { id: "read", type: "tool", tool: "get_deadlines", input: {} },
        {
          id: "chase",
          type: "for_each",
          items: "{{ steps.read.output.clients[status='missing_docs'] }}",
          as: "client",
          steps: [
            {
              id: "email",
              type: "tool",
              tool: "GMAIL_SEND_EMAIL",
              input: {
                recipient_email: "{{ client.contactEmail }}",
                subject: "Documents needed for your 2025 filing — {{ client.businessName }}",
                body:
                  "Hi {{ client.contactName }},\n\nA quick reminder from Hartwell & Associates: " +
                  "we are still missing {{ $join(client.missingDocKinds, ', ') }} for your 2025 " +
                  "filing (deadline {{ $substring(client.filingDeadline, 0, 10) }}). You can " +
                  "upload them through your client portal.\n\nBest,\nMaya Alvarez",
              },
            },
          ],
        },
        {
          id: "book",
          type: "for_each",
          items: "{{ steps.read.output.clients[daysUntilDeadline >= 0 and daysUntilDeadline <= 3] }}",
          as: "client",
          steps: [
            {
              id: "call",
              type: "tool",
              tool: "GOOGLECALENDAR_CREATE_EVENT",
              input: {
                summary: "Deadline call — {{ client.businessName }}",
                description:
                  "Filing deadline {{ $substring(client.filingDeadline, 0, 10) }}; still missing: " +
                  "{{ $join(client.missingDocKinds, ', ') }}",
                start_datetime: "{{ $substring(run.firedAt, 0, 10) & 'T14:00:00' }}",
                event_duration_minutes: 30,
                attendees: "{{ [client.contactEmail] }}",
              },
            },
          ],
        },
      ],
    },
  };
}

async function createChase(
  world: ReturnType<typeof createAutomationsWorld>,
  opts: { granted?: boolean } = {},
) {
  const tools = world.authoringTools();
  const create = tools["create_automation"] as Tool;
  const result = (await create.execute!(
    {
      spec: morningChaseSpec(),
      grantedTools:
        opts.granted === false ? [] : ["GMAIL_SEND_EMAIL", "GOOGLECALENDAR_CREATE_EVENT"],
    } as never,
    CALL_OPTS,
  )) as { ok: boolean; errors?: string[]; automation?: { id: string } };
  expect(result.ok, String(result.errors)).toBe(true);
  return result.automation!.id;
}

async function forceFire(
  world: ReturnType<typeof createAutomationsWorld>,
  id: string,
  live = true,
) {
  const runNow = world.authoringTools()["run_automation_now"] as Tool;
  return (await runNow.execute!({ id, live } as never, CALL_OPTS)) as {
    ok: boolean;
    run?: { status: string; steps: Array<{ id: string; status: string }> };
  };
}

describe("cadence automations world — the morning document chase", () => {
  it("force-fire (live): emails all 8 missing-docs clients and books calls for the 2 inside the 3-day window", async () => {
    __reseed(new Date());
    const gmail = vi.fn(async () => OK);
    const calendar = vi.fn(async () => OK);
    const world = createAutomationsWorld({ gmail, calendar });
    const id = await createChase(world);

    const result = await forceFire(world, id, true);
    expect(result.ok).toBe(true);
    expect(result.run!.status).toBe("succeeded");

    expect(gmail).toHaveBeenCalledTimes(8);
    const recipients = gmail.mock.calls.map((c) => (c as unknown[])[0] as { recipient_email: string });
    expect(recipients.map((r) => r.recipient_email).sort()).toEqual([...MISSING_DOCS_EMAILS].sort());
    // Interpolation produced real content, not template leftovers.
    const first = (gmail.mock.calls[0] as unknown[])[0] as { subject: string; body: string };
    expect(first.subject).not.toContain("{{");
    expect(first.body).toMatch(/still missing .*(W-2|1099|Bank statements|Receipts|Prior-year|Payroll|Mileage)/);

    expect(calendar).toHaveBeenCalledTimes(2);
    const events = calendar.mock.calls.map((c) => (c as unknown[])[0] as { summary: string; attendees?: string[]; start_datetime: string });
    expect(events.map((e) => e.summary).sort()).toEqual([
      "Deadline call — Chen Consulting",
      "Deadline call — Rivera Landscaping LLC",
    ]);
    expect(events.every((e) => Array.isArray(e.attendees) && e.attendees.length === 1)).toBe(true);
    expect(events.every((e) => /^\d{4}-\d{2}-\d{2}T14:00:00$/.test(e.start_datetime))).toBe(true);
  });

  it("dry run (default): simulates the gated sends without calling Composio", async () => {
    __reseed(new Date());
    const gmail = vi.fn(async () => OK);
    const calendar = vi.fn(async () => OK);
    const world = createAutomationsWorld({ gmail, calendar });
    const id = await createChase(world);

    const result = await forceFire(world, id, false);
    expect(result.ok).toBe(true);
    expect(gmail).not.toHaveBeenCalled();
    expect(calendar).not.toHaveBeenCalled();
  });

  it("without grants, the gated for_each send never executes (grant-required failure, not a silent send)", async () => {
    __reseed(new Date());
    const gmail = vi.fn(async () => OK);
    const calendar = vi.fn(async () => OK);
    const world = createAutomationsWorld({ gmail, calendar });
    const id = await createChase(world, { granted: false });

    await forceFire(world, id, true);
    expect(gmail).not.toHaveBeenCalled();
    expect(calendar).not.toHaveBeenCalled();
    // A gated tool inside for_each cannot pause per-iteration (not resumable
    // in v1) — the run fails loudly, telling the user to grant the tool. The
    // AutomationCard's approval is what mints those grants.
    const runs = await world.store.listRuns(world.scope, id);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toMatch(/requires a grant/);
  });

  it("a failed real send surfaces as a failed run — never fake success", async () => {
    __reseed(new Date());
    const gmail = vi.fn(async (): Promise<ComposioFireResult> => ({ ok: false, detail: null, error: "quota" }));
    const calendar = vi.fn(async () => OK);
    const world = createAutomationsWorld({ gmail, calendar });
    const id = await createChase(world);

    const result = await forceFire(world, id, true);
    const runs = await world.store.listRuns(world.scope, id);
    expect(result.run?.status ?? runs[0]!.status).not.toBe("succeeded");
  });

  it("registers the cron schedule on create (the scheduler owns the morning firing)", async () => {
    __reseed(new Date());
    const world = createAutomationsWorld({ gmail: vi.fn(async () => OK), calendar: vi.fn(async () => OK) });
    const id = await createChase(world);
    const automation = await world.store.get(world.scope, id);
    expect(automation?.spec.trigger).toMatchObject({ type: "schedule", cron: "0 8 * * *" });
    expect(automation?.status).toBe("enabled");
  });
});
