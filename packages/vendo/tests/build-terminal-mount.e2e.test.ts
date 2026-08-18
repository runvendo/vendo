/**
 * NOBODY MOUNTS A DRAFT THE BUILD IS ABOUT TO CORRECT.
 *
 * A screen saves as it goes, so its app ROW lands at the first save that paints —
 * and the mandatory reviewer pass and its one repair round run AFTER that
 * (`assembleScreen`, packages/vendo/src/screen-agent.ts). Every surface that
 * mounts from the row (`useApp` → VendoSlot's MountedApp and Remixable's fork,
 * and VendoAppEmbed's poll) stops looking the moment `open()` answers, so a
 * person could be shown the draft — a wrong NUMBER included — while the server
 * already held the corrected version, with nothing but a page reload to fix it.
 *
 * So this walks a REAL composed deployment — real store, real render seam, real
 * checks floor, real reviewer verb, real host tools — and reads the app back
 * through the REAL `open()` and the REAL wire route AT THE INSTANT the draft has
 * painted and the repair has not run. Only the model is scripted; both sides of
 * the seam are the shipped ones.
 *
 * The two that must be able to fail:
 * - drop the `buildInFlight(app.building)` gate from `openSurface`
 *   (packages/apps/src/server/persistence/open.ts) and BOTH mid-build reads go
 *   red — `open()` serves the double-counted draft and the wire hands it to the
 *   embed, which is the incident.
 * - stamp `building` only when the row is new (`previous === undefined` in
 *   `screenDocument`, packages/apps/src/server/doors/write-surface.ts) and the
 *   EDIT's read goes red on its own. That was the shipped gap: a ✦ remix and an
 *   edit both build onto a row that already exists, so a create-only gate left
 *   the number-changing repair the person actually watches unguarded.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  VendoError,
  type Json,
  type Principal,
  type RunContext,
  type ToolDefinition,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_build_terminal" };
const ctx: RunContext = {
  principal,
  venue: "mcp",
  presence: "present",
  sessionId: "ses_build_terminal",
};

/** Three of the five bills ARE the subscriptions, by id — the overlap only
 *  something holding both row sets at once can see. */
const BILLS = [
  { id: "bill_rent", name: "Rent", amount_cents: 180_000, due_at: "2026-08-01" },
  { id: "bill_power", name: "Power", amount_cents: 9_600, due_at: "2026-08-04" },
  { id: "bill_netflix", name: "Netflix", amount_cents: 1_999, due_at: "2026-08-09" },
  { id: "bill_adobe", name: "Adobe Creative Cloud", amount_cents: 5_999, due_at: "2026-08-12" },
  { id: "bill_aws", name: "AWS", amount_cents: 12_000, due_at: "2026-08-18" },
] as const;
const SUBSCRIPTIONS = BILLS.filter(({ id }) => ["bill_netflix", "bill_adobe", "bill_aws"].includes(id));

/** The headlines, as they reach the payload: a draft double counts the three
 *  shared bills; the create's repair sums the bills alone, and the edit's sums
 *  the subscriptions alone. Three distinct numbers, so which one a mount is
 *  showing is never ambiguous. */
const DRAFT_TOTAL = 2295.96;
const REPAIRED_TOTAL = 2095.98;
const EDITED_TOTAL = 199.98;

const hostTools: ToolDefinition[] = [
  {
    name: "host_upcomingBills",
    title: "Upcoming bills",
    description: "Every bill due in the next 30 days.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: BILLS as unknown as Json }) as unknown as Json,
  },
  {
    name: "host_subscriptions",
    title: "Subscriptions",
    description: "The recurring subscriptions on this account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: SUBSCRIPTIONS as unknown as Json }) as unknown as Json,
  },
];

const screen = (total: string) => `import { Stack, Stat, useQuery } from "@vendo/screen";

export default function UpcomingBills() {
  const bills = useQuery("host_upcomingBills");
  const subs = useQuery("host_subscriptions");
  const total = ${total};
  return (
    <Stack gap={12}>
      <Stat label="Due this month" value={total / 100} format="money" />
    </Stack>
  );
}
`;

/** Every mechanical check passes this: a double count is not a shape error. */
const DOUBLE_COUNT = screen('[...bills.data, ...subs.data].reduce((sum, row) => sum + row.amount_cents, 0)');
/** The same screen, honest — what the create's repair round saves. */
const HONEST = screen('bills.data.reduce((sum, row) => sum + row.amount_cents, 0) + subs.data.length * 0');
/** What the EDIT's repair round saves — a different screen again, so the save
 *  really lands (an identical source is not a save) and the number it paints
 *  cannot be confused with either of the other two. */
const SUBS_ONLY = screen('subs.data.reduce((sum, row) => sum + row.amount_cents, 0) + bills.data.length * 0');

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

type Chunk = Record<string, unknown>;

const call = (toolName: string, input: unknown, toolCallId: string): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const speak = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** The screen agent's own brief (`environmentNote`). */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The reviewer's own rubric (`REVIEWER_SYSTEM`). */
const REVIEWER_MARKER = "You are the last reader of a generated app";

const FINDING = 'the headline adds both queries, and bill_netflix, bill_adobe and bill_aws are in BOTH';

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-build-terminal-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/**
 * One model wearing both hats, split by call KIND: the assembly loop streams
 * (`doStream`), the reviewer's strict tool call generates (`doGenerate`).
 *
 * `onReview` is AWAITED before the verdict is handed back, which is what makes
 * this a reading of the mid-build instant rather than a race with the repair
 * round: the reviewer has not answered yet, so nothing has fixed the draft.
 */
function scripted(steps: Chunk[][], onReview: () => Promise<void>): {
  model: LanguageModel;
  /** How many times the reviewer was called — the mid-build read rides inside
   *  it, so exactly one is what says it happened, once, at that instant. */
  state: { reviews: number };
} {
  const remaining = [...steps];
  const state = { reviews: 0 };
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-build-terminal",
    modelId: "vendo-build-terminal",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      if (!textOf(request).includes(REVIEWER_MARKER)) {
        return {
          content: [{ type: "text", text: "" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      state.reviews += 1;
      await onReview();
      return {
        content: [{
          type: "tool-call",
          toolCallId: "review_1",
          toolName: "report_findings",
          input: JSON.stringify({
            findings: [{ severity: "block", where: '<Stat> labeled "Due this month"', message: FINDING }],
          }),
        }],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      const chunks = prompt.includes(SCREEN_BRIEF_MARKER)
        ? remaining.shift() ?? speak("nothing more to do")
        : speak("nothing to do here");
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as unknown as LanguageModel, state };
}

/** What the payload's headline reads, off the surface the person would mount. */
const headline = (surface: { kind: string }): string => {
  expect(surface.kind).toBe("tree");
  return JSON.stringify((surface as unknown as { payload: unknown }).payload);
};

describe("a screen mounts only once its build is terminal", () => {
  /** What one mid-build read saw, taken from inside the reviewer call — the
   *  instant the draft has painted and its repair has not run. */
  interface MidBuild {
    listed: number;
    open: string;
    wireStatus: number;
    wireBody: string;
  }

  it("gates a CREATE and an EDIT alike, and serves the version each repair left", async () => {
    const store = await tempStore();
    const seen: MidBuild[] = [];
    let vendo: ReturnType<typeof createVendo>;

    // Everything below is the shipped read path, with nothing stubbed on either
    // side of the seam.
    const onReview = async (): Promise<void> => {
      const listed = await vendo.apps.list(ctx);
      const appId = listed[0]?.id;
      if (appId === undefined) throw new Error("the build left no row to read");
      // The runtime door…
      const open = await vendo.apps.open(appId, ctx)
        .then((surface) => headline(surface))
        .catch((error: unknown) => (error instanceof VendoError ? error.code : String(error)));
      // …and the wire the browser actually polls, under the embed's own flag.
      const response = await vendo.handler(
        new Request(`https://host.test/api/vendo/apps/${appId}/open?pending=1`),
      );
      seen.push({ listed: listed.length, open, wireStatus: response.status, wireBody: await response.text() });
    };

    const { model, state } = scripted([
      // THE CREATE, on no row at all: draft, then the repair the reviewer's
      // finding asks for.
      call("save_app", { content: DOUBLE_COUNT }, "c1"),
      speak("Your upcoming bills are on your screen."),
      call("save_app", { content: HONEST }, "c2"),
      speak("Fixed the double count."),
      // THE EDIT, on the row the create just left — the shape a ✦ remix's build
      // also takes, because a remix is `runtime.edit` over a row its gesture
      // already wrote (`seed-surface.ts`). Same draft-then-repair.
      call("save_app", { content: DOUBLE_COUNT }, "c3"),
      speak("Updated."),
      call("save_app", { content: SUBS_ONLY }, "c4"),
      speak("Fixed it again."),
    ], onReview);

    const harness = defineHarness({
      name: "build-terminal-probe",
      async *run(turn) {
        await turn.tools.call(VENDO_MAKE_TOOL, {
          request: "make me a dashboard for my upcoming bills and subscriptions",
        });
        const built = (await vendo.apps.list(ctx))[0];
        await turn.tools.call(VENDO_MAKE_TOOL, {
          request: "just the subscriptions, please",
          app: built?.id,
        });
        yield { type: "text", delta: "ok" };
      },
    });
    vendo = createVendo({
      models: { default: model },
      principal: async () => principal,
      store,
      tools: hostTools,
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);

    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_build_terminal",
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "my upcoming bills" }] },
      }),
    }));
    expect(response.status).toBe(200);
    await response.text();

    // TWO builds, two reviewer passes, two mid-build reads: the create's, on no
    // row, and the edit's, on a row that already exists and already mounts. The
    // second is the one a create-only gate got wrong.
    expect(state.reviews).toBe(2);
    expect(seen).toHaveLength(2);
    for (const [index, midBuild] of seen.entries()) {
      // The premise: the ROW really is there mid-build, so this is a gate rather
      // than an app that simply did not exist yet.
      expect(midBuild.listed, `build ${index}`).toBe(1);
      // THE MOUNT GATE. Not the draft's headline — the same not-found the app
      // gave before it had a screen at all…
      expect(midBuild.open, `build ${index}`).toBe("not-found");
      // …which the wire turns into the `{kind:"pending"}` every embed already
      // keeps polling on (`use-app.ts`, `chrome/embeds.tsx`).
      expect(midBuild.wireStatus, `build ${index}`).toBe(200);
      // S4 made this answer ADDITIVE (a `tree` of pure geometry may ride it), and
      // a screen build now fills it: the shape of the render the build ALREADY
      // paid for (`persistence/forming.ts`), so the embed paints this app taking
      // shape. What may never ride is a FIGURE — this build's draft carries a
      // double count its repair round replaces — so the geometry is asserted to be
      // geometry, and the body is asserted not to contain the number.
      const pending = JSON.parse(midBuild.wireBody) as { kind: string; tree?: { nodes?: object[] } };
      expect(pending.kind, `build ${index}`).toBe("pending");
      // The geometry must BE there before "no props" says anything: an absent
      // tree satisfies the line below on its own.
      expect(pending.tree?.nodes?.length, `build ${index}`).toBeGreaterThan(0);
      expect(pending.tree?.nodes?.some((node) => "props" in node) ?? false, `build ${index}`).toBe(false);
      expect(midBuild.wireBody, `build ${index}`).not.toContain(String(DRAFT_TOTAL));
    }

    // And once both builds are terminal, what mounts is the LAST repair — never
    // a draft, and never the version the edit replaced.
    const apps = await vendo.apps.list(ctx);
    expect(apps).toHaveLength(1);
    const painted = headline(await vendo.apps.open(apps[0]!.id, ctx));
    expect(painted).toContain(String(EDITED_TOTAL));
    expect(painted).not.toContain(String(DRAFT_TOTAL));
    expect(painted).not.toContain(String(REPAIRED_TOTAL));
  }, 180_000);
});
