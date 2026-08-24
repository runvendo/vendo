/**
 * The front door's routing seam — blueprint §1 point 2 and §4.5.
 *
 * `vendo_make` starts every request in the screen agent, and the answer it gets
 * back is the answer the person gets. `escalate` is a request for the builder,
 * and what it gets depends on one thing — whether this deployment has a sandbox
 * to build in. Everything else is assembly coming back empty, which is now the
 * end of the ask rather than a quiet hand-off to a second engine. Three
 * properties make that safe rather than merely intended:
 *
 * 1. **One app id, whichever way an escalation lands.** The screen agent was
 *    handed an id and the person is already watching that stream. A build that
 *    minted its own id would paint the finished app onto a SECOND stream and
 *    leave the first as a card that builds forever; a failure reported against a
 *    different id would leave the same orphan.
 * 2. **A deployment that cannot build says so, BEFORE it spends anything.** No
 *    builder means nowhere to build, so the receipt fails honestly rather than
 *    asking and reporting it late. Nothing re-plans the ask on the
 *    way either: the person's own words and the escalation's one-line `why` are
 *    the whole brief the build gets.
 * 3. **An unwired or unserving assembler surfaces LOUDLY.** Composition forgetting
 *    the slot, an assembler that threw, an `unavailable`, and an `assembled` that
 *    left no row are four different bugs and four failed receipts — never a
 *    "ready" served by an engine nobody chose.
 */
import { VendoError } from "@vendoai/core";
import type {
  AppId,
  RunContext,
  ToolRegistry,
  VendoViewPart,
} from "@vendoai/core";
import type {
  ScreenAssembler,
  ScreenRequest,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/server/doors/agent-tools.js";
import { authoringAssembler, scriptedAssembler } from "../src/server/testing/screen-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_screen" },
  venue: "chat",
  presence: "present",
  sessionId: "session_screen",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

/** Every prompt a MODEL was handed. The brain is gone, so on the escalation path
 *  this must stay empty: the ASK is the brief and nothing re-plans it. */
const briefs: string[] = [];

const runtimeWith = (screen?: ScreenAssembler, options: {
  /** Configure a builder — the ONE thing that decides whether an escalation
   *  becomes an ask. Its presence is the opt-in; there is no flag. */
  sandbox?: boolean;
} = {}) => {
  briefs.length = 0;
  // `LanguageModel` includes a bare model-id string, which cannot be spread.
  const model = basicLanguageModel() as Exclude<ReturnType<typeof basicLanguageModel>, string>;
  const watched = {
    ...model,
    doStream: async (call: { prompt: unknown }) => {
      briefs.push(JSON.stringify(call.prompt));
      return await (model as unknown as { doStream(c: unknown): Promise<unknown> }).doStream(call);
    },
    doGenerate: async (call: { prompt: unknown }) => {
      briefs.push(JSON.stringify(call.prompt));
      return await (model as unknown as { doGenerate(c: unknown): Promise<unknown> }).doGenerate(call);
    },
  } as typeof model;
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: watched,
    ...(options.sandbox === true
      ? {
        // S3 — a composed builder is what makes the escalation an honest ASK.
        // It is never reached here: the card stands undecided.
        build: {
          available: () => true,
          build: async () => ({ kind: "failed" as const, why: "never reached" }),
        },
        // The other half of the same capability: `build.available()` is false
        // without somewhere to seal the bytes, so a builder alone is not a
        // deployment that can be asked to build.
        files: {
          put: async () => {},
          get: async () => undefined,
          delete: async () => {},
        },
      }
      : {}),
    ...(screen === undefined ? {} : { screen }),
  });
  return {
    runtime,
    store,
    briefs,
    agentTools: createAgentTools(runtime, {
      data: {} as never,
      requireOwned: async () => { throw new Error("unused"); },
      claimSlot: async () => { throw new Error("unused"); },
      markUnbuilt: async () => { throw new Error("unused"); },
      ...(screen === undefined ? {} : { screen }),
    }),
  };
};

/** A store whose `vendo_apps` writes are refused while `refusing()` says so, with
 *  reads left healthy — the write-only refusal an edit actually meets. */
const storeRefusingAppWritesWhile = (refusing: () => boolean): ReturnType<typeof memoryStore> => {
  const store = memoryStore();
  const records = store.records.bind(store);
  return Object.assign(store, {
    records(collection: string) {
      const inner = records(collection);
      if (collection !== "vendo_apps") return inner;
      return Object.assign(Object.create(Object.getPrototypeOf(inner) ?? {}), inner, {
        async put(...args: Parameters<typeof inner.put>) {
          if (refusing()) throw Object.assign(new Error("Store request failed."), { code: "unavailable" });
          return await inner.put(...args);
        },
      });
    },
  }) as ReturnType<typeof memoryStore>;
};

/** A store whose `vendo_apps` READS fail while `failing()` says so — the
 *  rate-limited read. An absent row and a store that could not answer are
 *  different facts, and only the first one means nothing rendered. */
const storeRefusingAppReadsWhile = (failing: () => boolean): ReturnType<typeof memoryStore> => {
  const store = memoryStore();
  const records = store.records.bind(store);
  return Object.assign(store, {
    records(collection: string) {
      const inner = records(collection);
      if (collection !== "vendo_apps") return inner;
      return Object.assign(Object.create(Object.getPrototypeOf(inner) ?? {}), inner, {
        async get(...args: Parameters<typeof inner.get>) {
          if (failing()) throw new VendoError("unavailable", "Too many requests. Try again shortly.");
          return await inner.get(...args);
        },
      });
    },
  }) as ReturnType<typeof memoryStore>;
};

/** An assembler that records what it was handed and answers however the test says. */
function recordingAssembler(answer: Awaited<ReturnType<ScreenAssembler["assemble"]>>) {
  const seen: ScreenRequest[] = [];
  return {
    seen,
    assembler: { assemble: async (request: ScreenRequest) => { seen.push(request); return answer; } },
  };
}

const make = async (
  agentTools: ReturnType<typeof createAgentTools>,
  request = "Show my spending by category",
) => await agentTools.execute({ id: "call_1", tool: "vendo_make", args: { request } }, ctx);

/** The app's name is its default export's, split on camel case. */
const SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return <Stack gap={12}><Text text="This month" variant="heading" /></Stack>;
}
`;
const EDITED = SCREEN.replace("This month", "Last month");

describe("an escalation and the build that finishes it share ONE app id", () => {
  it("the ASK is offered at the id the screen agent was handed, holding the ask itself, with nothing spent", async () => {
    const { seen, assembler } = recordingAssembler({ kind: "escalate", why: "this needs real code" });
    const { agentTools, briefs, store } = runtimeWith(assembler, { sandbox: true });

    const outcome = await make(agentTools);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string } }).output;
    // The assembler was consulted ONCE, before anything was built — the seam
    // routes, the caller does not, and an escalation carries its `why` into the
    // proposal so the build never runs a second agent over the same ask.
    expect(seen).toHaveLength(1);
    // …and that consultation, plus the build the person is being asked about,
    // is at ONE id. This is the assertion that stops a stranded second stream.
    expect(seen[0]?.appId).toBe(receipt.id);
    // S3 — an escalation with somewhere to build is an ASK, not a build.
    expect(receipt.status).toBe("awaiting-consent");
    // THE ASK IS THE BRIEF, and it is held as written — the person's own words
    // rather than a second, unrelated answer to the same ask. It waits on the
    // proposal because the yes may land long after this turn.
    const row = await store.records("vendo_apps").get(receipt.id);
    const proposal = (row?.data as { doc: { proposal?: { prompt: string; why: string } } }).doc.proposal;
    expect(proposal?.prompt).toContain("Show my spending by category");
    // The escalation's one-line `why` travels beside it: the box will hear why
    // this cannot happen in the browser, and nothing else was decided for it.
    expect(proposal?.why).toContain("this needs real code");
    // NOTHING RE-PLANNED IT and NOTHING WAS SPENT: no model call.
    expect(briefs).toHaveLength(0);
  });

  it("with no sandbox the escalation FAILS honestly at the same id, and nothing is generated", async () => {
    // An escalation asks for a machine. Answering it with a second pass at
    // assembly would spend a full build's latency to arrive at a worse version of
    // the screen the person already saw.
    const { seen, assembler } = recordingAssembler({ kind: "escalate", why: "this needs real code" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const outcome = await make(agentTools);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string; say: string } }).output;
    expect(receipt.status).toBe("failed");
    // Same id: the failure is ABOUT the app the person's stream is aimed at.
    expect(receipt.id).toBe(seen[0]?.appId);
    // The say names the capability gap in the person's terms, not the flag's.
    expect(receipt.say).toContain("real build");
    // Nothing was generated: not one model call went out.
    expect(briefs).toHaveLength(0);
  });

  it("`create` honours a caller-minted id and paints every view on it", async () => {
    let runtime: AppsRuntime;
    const composed = runtimeWith(authoringAssembler(() => runtime, SCREEN));
    runtime = composed.runtime;
    const appId = "app_caller_minted" as AppId;
    const parts: VendoViewPart[] = [];

    const app = await runtime.create({ appId, prompt: "Show my spending", onView: (part) => parts.push(part) }, ctx);

    expect(app.id).toBe(appId);
    expect(parts.length).toBeGreaterThan(0);
    expect(new Set(parts.map((part) => part.appId))).toEqual(new Set([appId]));
  });
});

/** The four ways assembly comes back with no screen. Each one used to be
 *  absorbed by a second engine; each one is now the answer. */
describe("assembly that produces no screen fails honestly", () => {
  const unbuilt = (outcome: Awaited<ReturnType<typeof make>>) => {
    expect(outcome.status).toBe("ok");
    return (outcome as { output: { id: string; status: string; title: string; say: string } }).output;
  };

  it("an unwired assembler is a composition bug, and it says so", async () => {
    const { agentTools, briefs } = runtimeWith();

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("nothing in this deployment builds screens");
    // The ask, so the sentence and the card are about the same thing.
    expect(receipt.title).toBe("Show my spending by category");
    // Nothing was generated behind the person's back: not one model call.
    expect(briefs).toHaveLength(0);
  });

  it("an `unavailable` hands the assembler's own `why` to the person", async () => {
    const { assembler } = recordingAssembler({ kind: "unavailable", why: "no workspace here" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    // Verbatim — a generic apology is nothing the person can act on.
    expect(receipt.say).toContain("no workspace here");
    expect(briefs).toHaveLength(0);
  });

  it("an assembler that THROWS reports the throw, not a rescue", async () => {
    const throwing: ScreenAssembler = { assemble: async () => { throw new Error("assembler exploded"); } };
    const { agentTools, briefs } = runtimeWith(throwing);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("assembler exploded");
    expect(briefs).toHaveLength(0);
  });

  it("a store that could not ANSWER is not a build that produced nothing", async () => {
    // The row is the proof that something painted, but only a MISSING row is that
    // proof: a read the store refused says nothing about the screen. Reporting it
    // as "nothing renderable" tells the person their build failed and sends them
    // to rebuild a screen that assembled and painted fine.
    let failing = false;
    const runtime = createApps({
      store: storeRefusingAppReadsWhile(() => failing),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      screen: { assemble: async () => { failing = true; return { kind: "assembled" }; } },
    });

    const rejection = await runtime.create({ prompt: "Show my spending" }, ctx)
      .then(() => undefined, (error: unknown) => error as VendoError);

    expect(rejection?.message).not.toContain("nothing renderable");
    expect(rejection?.detail).toMatchObject({ reason: "busy, try again shortly", retryable: true });
  });

  it("an `assembled` that left no ROW behind is not an app — a picture of one is not one", async () => {
    // The screen agent said it assembled, but nothing renderable ever reached the
    // store, so `authored` upserted no row. The front door checks the row rather
    // than trusting the answer.
    const { assembler } = recordingAssembler({ kind: "assembled" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("the build produced nothing renderable");
    expect(briefs).toHaveLength(0);
  });
});

/**
 * The PUBLIC API, not the front door.
 *
 * `create` and `edit` sit behind the HTTP wire, the React client and every seed
 * script, and they were the conductor's last two callers. They are the same one
 * engine now — "the seam routes, not the caller" is not a `vendo_make` property,
 * it is the runtime's — so every one of those callers gets assembly first, the
 * build only when assembly asks for it by name, and an honest failure when this
 * deployment composed nothing that builds screens.
 */
describe("the public create/edit API runs the one engine", () => {
  it("`create` assembles, and the row that lands is the app it returns", async () => {
    let runtime: AppsRuntime;
    const composed = runtimeWith(authoringAssembler(() => runtime, SCREEN));
    runtime = composed.runtime;

    const app = await runtime.create({ prompt: "Show my spending" }, ctx);

    expect(app.name).toBe("Spending");
    // The ROW, read back through the real door — a returned document nobody
    // stored is exactly the failure the one-engine rule exists to stop.
    expect((await runtime.get(app.id, ctx))?.name).toBe("Spending");
    expect((await runtime.list(ctx)).map(({ id }) => id)).toContain(app.id);
  });

  it("`create` with no assembler composed fails honestly — it never quietly finds another engine", async () => {
    const { runtime, briefs } = runtimeWith();

    await expect(runtime.create({ prompt: "Show my spending" }, ctx)).rejects.toMatchObject({
      code: "not-implemented",
    });
    expect(briefs).toHaveLength(0);
  });

  it("`edit` is the assembler opening the app's own document and saving it back", async () => {
    let runtime: AppsRuntime;
    const composed = runtimeWith(scriptedAssembler(
      () => runtime,
      (_request, current) => current === null ? SCREEN : EDITED,
    ));
    runtime = composed.runtime;
    const app = await runtime.create({ prompt: "Show my spending" }, ctx);

    const edited = await runtime.edit(app.id, "say last month instead", ctx);

    expect(edited.failure).toBeUndefined();
    // IN PLACE, and it really changed.
    expect(edited.app.id).toBe(app.id);
    expect(JSON.stringify(await runtime.get(app.id, ctx))).toContain("Last month");
    // The recorded version carries the person's own words, not "Saved app.vendo" —
    // which is what keeps a remix's replayable trail replayable.
    expect((await runtime.history(app.id, ctx).list()).map(({ intent }) => intent))
      .toContain("say last month instead");
  });

  it("`edit` whose save was REFUSED fails — it never reports the pre-edit app as the edit", async () => {
    // A whole-store outage self-reports (the read fails and the door throws), so
    // what an edit really meets is a refused WRITE: the `assertCurrent` conflict
    // when a skill's timer-save lands inside the save's window, or a write the
    // store rejects on its own. Both arrive in the same place — `authored`
    // catches them, logs, and returns as if it had saved. Assembly then says
    // "assembled", the row still holds the PRE-edit document, and reading it back
    // as this edit's result is a success receipt for a change that never
    // happened: the agent moves on and the person's ask is silently lost.
    let runtime: AppsRuntime;
    let refusing = false;
    runtime = createApps({
      store: storeRefusingAppWritesWhile(() => refusing),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      screen: scriptedAssembler(() => runtime, (_request, current) => current === null ? SCREEN : EDITED),
    });
    const app = await runtime.create({ prompt: "Show my spending" }, ctx);

    refusing = true;
    const edited = await runtime.edit(app.id, "say last month instead", ctx);

    expect(edited.failure?.code).toBe("edit-rejected");
    expect(edited.issues?.join(" ")).toContain("Store request failed.");
    // And the app the caller is handed is the one that is really stored.
    expect(JSON.stringify(edited.app)).toContain("This month");
    expect(JSON.stringify(await runtime.get(app.id, ctx))).toContain("This month");
  });

  it("`edit` whose store went busy after the save says the store did, not that nothing rendered", async () => {
    // The read that fetches the saved app back is the last thing an edit does. A
    // store that refuses it has said nothing about the screen — the save landed —
    // so "the build produced nothing renderable" is a lie about the person's work.
    let runtime: AppsRuntime;
    /** Armed between the create and the edit; the store goes busy the moment the
     *  edit's own save has landed. */
    let armed = false;
    let failing = false;
    const inner = scriptedAssembler(() => runtime, (_request, current) => current === null ? SCREEN : EDITED);
    runtime = createApps({
      store: storeRefusingAppReadsWhile(() => failing),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      screen: {
        assemble: async (request, runCtx) => {
          const outcome = await inner.assemble(request, runCtx);
          failing = armed;
          return outcome;
        },
      },
    });
    const app = await runtime.create({ prompt: "Show my spending" }, ctx);

    armed = true;
    const edited = await runtime.edit(app.id, "say last month instead", ctx);

    expect(edited.issues?.join(" ")).not.toContain("nothing renderable");
    expect(edited.issues?.join(" ")).toContain("Too many requests");
  });

  it("`edit` with no assembler composed refuses, and the stored app is untouched", async () => {
    let runtime: AppsRuntime;
    const composed = runtimeWith(authoringAssembler(() => runtime, SCREEN));
    runtime = composed.runtime;
    const app = await runtime.create({ prompt: "Show my spending" }, ctx);
    const bare = createApps({
      store: composed.store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
    });

    const edited = await bare.edit(app.id, "say last month instead", ctx);

    expect(edited.failure?.code).toBe("edit-rejected");
    expect(edited.issues?.join(" ")).toContain("nothing in this deployment builds screens");
    expect(JSON.stringify(await bare.get(app.id, ctx))).toContain("This month");
  });
});
