/**
 * THE DEAD SEAM — the screen agent's way of asking for a build, and where it
 * lands.
 *
 * `RunRecord.escalated` was READ by the outcome gate and WRITTEN by nobody, so
 * `screen.assemble()` could never answer `escalate`, `vendo_make`'s escalate arm
 * was dead code, and no chat ask could reach the build lane at all. Live in
 * Maple (2026-08-24) an ask that genuinely needed a real build produced a
 * degraded screen and "this product's screen-building tool isn't that" — no
 * card, no build, no box.
 *
 * So nothing on either side of that seam is faked here: a REAL composed
 * deployment, the real front door, the real screen loop with its real loadout,
 * the real build door and the REAL guard, whose parked ask IS the standing card.
 * Two things are stand-ins, both of them the things a test cannot have: the
 * MODEL (scripted, so the loadout is what is measured rather than a provider's
 * mood) and the sandbox PROVIDER — a stub that refuses to hand out a machine,
 * because the one thing this whole flow must not do before the person's yes is
 * claim a box.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  type Principal,
  type RunContext,
  type ToolResult,
} from "@vendoai/core";
import { makeReceiptSchema } from "@vendoai/apps/contract";
import type { SandboxAdapter } from "@vendoai/apps";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { ESCALATE_TOOL, SAVE_APP_TOOL } from "../src/screen-agent.js";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_escalate" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "ses_escalate" };

/** The ask a screen cannot serve — the one this whole lane exists for. */
const ASK = "a QR code generator that really encodes my account details with the qrcode package";
const WHY = "this needs a real npm package running real code, which a screen cannot do";

/** Not a TSX module at all, so the gauntlet refuses it and the seam paints
 *  nothing: an assembly FAILURE, which must never become a build proposal. */
const BROKEN = "not a document at all";

/** A screen every stage of the gauntlet passes — the smallest thing that can
 *  legitimately paint, so a save reaching the workspace really would land. */
const SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

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

/** A model that replays scripted turns and records WHICH TOOLS it was offered —
 *  the only place a composed loadout is readable from outside the loop. */
function scripted(turns: Chunk[][]): LanguageModel & { toolNamesPerCall: string[][] } {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  }) as unknown as LanguageModel & { toolNamesPerCall: string[][] };
  model.toolNamesPerCall = toolNamesPerCall;
  return model;
}

/** The sandbox slot filled by something that will not give a machine up. Its
 *  PRESENCE is what makes `build.available()` true; every method is a tripwire,
 *  because nothing in this file may reach a box. */
const noBoxes = (): SandboxAdapter & { claims: number } => {
  const adapter = {
    claims: 0,
    async create() {
      adapter.claims += 1;
      throw new Error("a box was claimed");
    },
    async resume() {
      adapter.claims += 1;
      throw new Error("a box was claimed");
    },
    async destroy() {},
  };
  return adapter as unknown as SandboxAdapter & { claims: number };
};

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-escalate-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

interface Walked {
  receipt: ReturnType<typeof makeReceiptSchema.parse> | undefined;
  result: ToolResult | undefined;
  vendo: ReturnType<typeof createVendo>;
  model: LanguageModel & { toolNamesPerCall: string[][] };
  sandbox: ReturnType<typeof noBoxes>;
}

/** One real turn whose harness does what a calling agent does: ask `vendo_make`
 *  in words, and hand back the receipt. */
async function walk(options: { turns: Chunk[][]; sandbox?: boolean }): Promise<Walked> {
  const store = await tempStore();
  const model = scripted(options.turns);
  const sandbox = noBoxes();
  let result: ToolResult | undefined;
  const harness = defineHarness({
    name: "escalate-probe",
    async *run(turn) {
      result = await turn.tools.call(VENDO_MAKE_TOOL, { request: ASK });
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    models: { default: model },
    principal: async () => principal,
    store,
    harness: harness as never,
    ...(options.sandbox === false ? {} : { sandbox }),
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_escalate",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: ASK }] },
    }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  return {
    receipt: result?.status === "ok" ? makeReceiptSchema.parse(result.output) : undefined,
    result,
    vendo,
    model,
    sandbox,
  };
}

describe("a chat ask bigger than a screen reaches the build lane", () => {
  it("lands as a standing card and an awaiting-consent receipt, with no box claimed", async () => {
    const walked = await walk({
      turns: [call(ESCALATE_TOOL, { why: WHY }, "c1"), speak("Asked about building it.")],
    });

    // THE DOOR IS ON THE LOADOUT — the fact that was missing.
    expect(walked.model.toolNamesPerCall[0]).toContain(ESCALATE_TOOL);

    // THE RECEIPT: the ask is alive and waiting on the person, not failed.
    expect(walked.receipt?.status).toBe("awaiting-consent");

    // THE STANDING CARD, on the real guard: one undecided ask for the build,
    // carrying this app and the person's own words.
    const pending = await walked.vendo.guard.approvals.pending(principal);
    expect(pending.map((ask) => ask.call.tool)).toEqual(["vendo_app_build"]);
    expect(pending[0]?.call.args).toMatchObject({ appId: walked.receipt?.id, prompt: ASK });

    // THE ROW says "offered, unanswered" — and carries the model's own one line,
    // which is what the person reads on the card.
    const row = await walked.vendo.apps.get(walked.receipt!.id, ctx);
    expect(row?.proposal).toMatchObject({ approvalId: pending[0]?.id, why: WHY });
    expect(row?.building).toBeUndefined();

    // NOTHING WAS SPENT. The turn ended with the sandbox untouched.
    expect(walked.sandbox.claims).toBe(0);
  }, 60_000);

  it("ENDS THE TURN: nothing is offered another step once the escalation is recorded", async () => {
    // The hand's own contract says "This ends your turn", and it has to hold on
    // this side of the model: a drive that keeps going is offered `save_app` and
    // `edit_app` again, so a screen can be written and painted for an app whose
    // build is still waiting on the person's yes.
    const walked = await walk({
      turns: [
        call(ESCALATE_TOOL, { why: WHY }, "c1"),
        call(SAVE_APP_TOOL, { content: SCREEN }, "c2"),
        speak("saved anyway"),
      ],
    });

    // ONE model call: the escalation was the last thing this drive did. The two
    // scripted turns behind it were never reached.
    expect(walked.model.toolNamesPerCall).toHaveLength(1);
    expect(walked.receipt?.status).toBe("awaiting-consent");
    // …and the row is still only an OFFER: no screen was written past the ask.
    const row = await walked.vendo.apps.get(walked.receipt!.id, ctx);
    expect(row?.proposal).toBeDefined();
    expect(row?.source).toBeUndefined();
    expect(walked.sandbox.claims).toBe(0);
  }, 60_000);

  it("does not offer the door where the deployment has no build machine", async () => {
    // An offer nothing can honour is worse than no offer: the model is handed
    // the door only where a box could actually be claimed after the yes.
    const walked = await walk({
      turns: [speak("Assembling a screen out of this product's components cannot serve that.")],
      sandbox: false,
    });

    expect(walked.model.toolNamesPerCall[0]).not.toContain(ESCALATE_TOOL);
    expect(walked.receipt?.status).toBe("failed");
  }, 60_000);
});

describe("an assembly failure is not an escalation", () => {
  it("stays a failed receipt: no card, no proposal, no box", async () => {
    // The owner's line: escalation is the deliberate signal "this ask is bigger
    // than a screen", never a fallback for "something went wrong". A sandbox IS
    // composed here, so a proposal was available and was not taken.
    const walked = await walk({
      turns: [call(SAVE_APP_TOOL, { content: BROKEN }, "c1"), speak("saved")],
    });

    expect(walked.receipt?.status).toBe("failed");
    expect(await walked.vendo.guard.approvals.pending(principal)).toEqual([]);
    expect(await walked.vendo.apps.get(walked.receipt!.id, ctx)).toBeNull();
    expect(walked.sandbox.claims).toBe(0);
  }, 60_000);
});
