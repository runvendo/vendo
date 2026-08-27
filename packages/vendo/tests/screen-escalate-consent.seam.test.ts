// @vitest-environment jsdom
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
 *
 * The last test closes the seam on the READ side too: the shipped `VendoThread`
 * reads that same turn back over the real client and paints the real
 * `ApprovalCard`. The producer and the consumer disagreeing about one wire part
 * is exactly how this ask reached a person mis-graded, so neither side gets to
 * hold its own copy of it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_BUILD_TOOL,
  VENDO_MAKE_TOOL,
  vendoApprovalPartSchema,
  type AppId,
  type Principal,
  type RunContext,
  type ToolResult,
  type VendoApprovalPart,
} from "@vendoai/core";
import { makeReceiptSchema } from "@vendoai/apps/contract";
import type { SandboxAdapter } from "@vendoai/apps";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import { VendoProvider, createVendoClient } from "@vendoai/ui";
import { VendoThread } from "@vendoai/ui/chrome";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ESCALATE_TOOL, SAVE_APP_TOOL } from "../src/screen-agent.js";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.innerHTML = "";
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
  /** The turn's whole wire, as the browser receives it. */
  stream: string;
  vendo: ReturnType<typeof createVendo>;
  model: LanguageModel & { toolNamesPerCall: string[][] };
  sandbox: ReturnType<typeof noBoxes>;
}

/** The `data-vendo-approval` part off that wire, parsed with core's own schema —
 *  the one shape every native surface builds the in-thread ApprovalCard from. */
const approvalPartIn = (stream: string): VendoApprovalPart => {
  const chunk = stream.split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> })
    .find((part) => part.type === "data-vendo-approval");
  if (chunk === undefined) throw new Error("no data-vendo-approval part was published");
  return vendoApprovalPartSchema.parse({ type: chunk.type, ...chunk.data });
};

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
  const stream = await response.text();
  return {
    receipt: result?.status === "ok" ? makeReceiptSchema.parse(result.output) : undefined,
    result,
    stream,
    vendo,
    model,
    sandbox,
  };
}

// --- the READ side: the shipped thread, painting that same turn --------------

const BASE = "https://host.test/api/vendo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The client's fetch IS the door — every read the thread makes is answered by
 *  the composition that just wrote the turn, so nothing painted is arranged. */
function serve(vendo: Walked["vendo"]): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // jsdom's AbortSignal is not undici's, and undici's Request rejects it
    // outright; nothing here aborts, so it is dropped at the boundary.
    const { signal: _signal, ...rest } = init ?? {};
    const url = typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url;
    return await vendo.handler(new Request(url, rest as RequestInit));
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });
}

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => { root.render(element); });
}

/** Poll the painted DOM. The budget is the TEST's own — a tighter inner clock
 *  would report a product bug whenever the machine is merely busy. */
async function until<T>(what: string, probe: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    let found: T | null | undefined | false;
    await act(async () => {
      found = probe();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}

describe("a chat ask bigger than a screen reaches the build lane", () => {
  it("lands as a standing card, a card part in the thread, and a park, with no box claimed", async () => {
    const walked = await walk({
      turns: [call(ESCALATE_TOOL, { why: WHY }, "c1"), speak("Asked about building it.")],
    });

    // THE DOOR IS ON THE LOADOUT — the fact that was missing.
    expect(walked.model.toolNamesPerCall[0]).toContain(ESCALATE_TOOL);

    // THE STANDING CARD, on the real guard: one undecided ask for the build,
    // carrying this app and the person's own words. STANDING is the whole word:
    // the turn is over and the ask is still there to be answered — an ordinary
    // parked call is swept denied at turn end, and sweeping this one tombstoned
    // the build the moment the turn that asked for it finished.
    const pending = await walked.vendo.guard.approvals.pending(principal);
    expect(pending.map((ask) => ask.call.tool)).toEqual(["vendo_app_build"]);
    expect(pending[0]?.call.args).toMatchObject({ prompt: ASK });
    const appId = (pending[0]?.call.args as { appId: AppId }).appId;

    // THE ANSWER the calling agent got is the standard park, aimed at that card —
    // and its reason is the DOOR's own one line (`say`), not the harness's
    // generic "This still needs approval.": the refusal is the only thing the
    // model reads about this call, so a say that never reached it left the model
    // narrating its own paragraphs under a card already asking the question.
    expect(walked.result).toMatchObject({
      reason: expect.stringContaining("the card above"),
      needs: { kind: "approval", approvalId: pending[0]?.id },
    });

    // THE CARD IN THE THREAD: the wire part the shipped bridge publishes off a
    // `pending-approval` outcome, which is what the receipt could never raise —
    // carrying the ask's OWN descriptor, because the card must speak about the
    // BUILD. Graded off the calling tool it spoke about `vendo_make`, a read,
    // and told the person that spending a build machine reads their data.
    const part = approvalPartIn(walked.stream);
    expect(part.approvalId).toBe(pending[0]?.id);
    expect(part.risk).toBe("write");
    expect(part.descriptor).toMatchObject({
      name: VENDO_APP_BUILD_TOOL,
      title: "Build this app for real",
      risk: "write",
    });

    // THE ROW says "offered, unanswered" — and carries the model's own one line,
    // which is what the person reads on the card.
    const row = await walked.vendo.apps.get(appId, ctx);
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
    const pending = await walked.vendo.guard.approvals.pending(principal);
    // …and the row is still only an OFFER: no screen was written past the ask.
    const row = await walked.vendo.apps.get((pending[0]?.call.args as { appId: AppId }).appId, ctx);
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

describe("the ask reaches the person on the ONE approval card", () => {
  it("paints the shipped ApprovalCard in the thread, in the build's own words", async () => {
    const walked = await walk({
      turns: [call(ESCALATE_TOOL, { why: WHY }, "c1"), speak("Asked about building it.")],
    });
    serve(walked.vendo);
    await mount(createElement(VendoProvider, {
      client: createVendoClient({ baseUrl: BASE }),
      children: createElement(VendoThread, { threadId: "thr_escalate" }),
    }));

    // THE LITERAL CARD — `.fl-approval` is `ApprovalCard`'s own shell, and its
    // machine attributes say which ask it is grading.
    const card = await until("the approval card", () =>
      document.querySelector<HTMLElement>(".fl-approval"));
    expect(card.getAttribute("data-vendo-tool")).toBe(VENDO_APP_BUILD_TOOL);
    expect(card.getAttribute("data-risk")).toBe("write");

    // THE WORDS, off the shared ladder (`consentAsk`) reading the descriptor the
    // door authored — never a second sentence written for this surface.
    expect(card.textContent).toContain("Build this app for real?");
    expect(card.textContent).toContain("This changes something in your account, and it runs as you.");
    // What it said before the descriptor travelled: ungraded, so the note could
    // only say nobody had checked what spending a build machine does.
    expect(card.textContent).not.toContain("This hasn’t been checked");
    expect(card.textContent).not.toContain("Nobody has checked what this changes");

    // Answerable, and NOT rememberable: a grant is a standing yes to a call the
    // person chose to make; this ask is about spending one machine, once.
    const label = (element: Element) => (element.textContent ?? "").trim();
    expect([...card.querySelectorAll("button")].map(label)).toContain("Approve");
    expect(card.textContent).not.toContain("Remember this decision");

    // AND IT SETTLES once they answer. This ask outlives its turn by design, so
    // there is no stream left to retire the part it was painted from: without
    // settling here the buttons stand for good on a question already decided, and
    // pressing them asks the guard again about a record it has already written.
    const deny = [...card.querySelectorAll("button")].find((button) => label(button) === "Deny")!;
    await act(async () => { deny.click(); });
    const settled = await until("the settled card", () =>
      document.querySelector<HTMLElement>(".fl-cardshell--settled"));
    expect(settled.textContent).toContain("Build this app for real");
    expect(settled.textContent).toContain("Declined — nothing ran");
    expect([...settled.querySelectorAll("button")].map(label)).not.toContain("Deny");
    // The person's no reached the real guard, not just the card.
    expect(await walked.vendo.guard.approvals.pending(principal)).toEqual([]);
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
