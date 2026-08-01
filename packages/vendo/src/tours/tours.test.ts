import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "@vendoai/core";
import type { UIMessage } from "ai";
import { createTourScript, type TourEntry } from "./index.js";
import { progressivePayloads, replayTour, seededRoll, type TourApps } from "./replay.js";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

type Chunk = Record<string, unknown>;

function recorder(): { writer: never; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  const writer = {
    write: (chunk: Chunk) => chunks.push(chunk),
    merge: () => undefined,
  };
  return { writer: writer as never, chunks };
}

const ctx = { principal: { kind: "user", subject: "u1" }, venue: "chat" } as unknown as RunContext;

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as UIMessage;
}

/** A tree small enough to read, big enough for progressivePayloads to split. */
const TREE = {
  formatVersion: "vendo-genui/v2",
  root: "n0",
  nodes: [
    { id: "n0", component: "Stack", children: ["n1", "n2"] },
    { id: "n1", component: "Hero", source: "generated" },
    { id: "n2", component: "List", source: "generated" },
  ],
  components: { Hero: "export default () => null", List: "export default () => null" },
};

const APP_DOCUMENT = { format: "vendo/app@1", name: "Late rent", description: "Units behind on rent" };

function fakeApps(overrides: Partial<Record<"open", unknown>> = {}): {
  apps: TourApps;
  imported: unknown[];
} {
  const imported: unknown[] = [];
  const apps = {
    importApp: async (source: unknown) => {
      imported.push(source);
      return { ...(source as object), id: "app_replayed" };
    },
    open: async () => overrides.open ?? { kind: "tree", payload: TREE },
    get: async () => null,
  } as unknown as TourApps;
  return { apps, imported };
}

/* ------------------------------------------------------------------ */
/* the seam                                                            */
/* ------------------------------------------------------------------ */

const TOURS: TourEntry[] = [
  { prompt: "Which units are behind on rent?", respond: "Five units are behind." },
  { prompt: "Ping me on Slack when rent goes late", respond: "I'll ping you." },
];

describe("the tour seam decides a turn without touching it", () => {
  const script = createTourScript({ tours: TOURS, apps: fakeApps().apps });

  it("returns a play for a frozen prompt", async () => {
    const message = userMessage("m1", "Which units are behind on rent?");
    expect(await script({ message, messages: [message], ctx })).toBeTypeOf("function");
  });

  it("returns a play for a typo'd variant of it", async () => {
    const message = userMessage("m1", "which units are behnid on rent");
    expect(await script({ message, messages: [message], ctx })).toBeTypeOf("function");
  });

  it("falls through for an improvised ask", async () => {
    const message = userMessage("m1", "which leases end in the next 90 days?");
    expect(await script({ message, messages: [message], ctx })).toBeUndefined();
  });

  /** A resumed approval is posted back as the ASSISTANT message it parked on.
   *  It belongs to whichever turn parked it, never to a tour. */
  it("falls through for an assistant message, whatever it says", async () => {
    const message = assistantMessage("m1", "Which units are behind on rent?");
    expect(await script({ message, messages: [message], ctx })).toBeUndefined();
  });

  it("falls through when no tours are configured", async () => {
    const empty = createTourScript({ tours: [], apps: fakeApps().apps });
    const message = userMessage("m1", "Which units are behind on rent?");
    expect(await empty({ message, messages: [message], ctx })).toBeUndefined();
  });
});

/**
 * ONCE PER THREAD, reconstructed from the transcript rather than stored —
 * because the thread is not the tour's alone: the live agent rewrites the same
 * row on the very next (fall-through) turn, and would drop any bookkeeping
 * field the tour had added.
 */
describe("an entry is spent after it plays once in a thread", () => {
  const script = createTourScript({ tours: TOURS, apps: fakeApps().apps });
  const ask = "Which units are behind on rent?";

  it("plays the first time and falls through the second", async () => {
    const first = userMessage("m1", ask);
    expect(await script({ message: first, messages: [first], ctx })).toBeTypeOf("function");

    const second = userMessage("m3", ask);
    const history = [first, assistantMessage("m2", "Five units are behind."), second];
    expect(await script({ message: second, messages: history, ctx })).toBeUndefined();
  });

  it("leaves the entries that have not played alone — one demo is one thread", async () => {
    const slack = userMessage("m3", "Ping me on Slack when rent goes late");
    const history = [userMessage("m1", ask), assistantMessage("m2", "…"), slack];
    expect(await script({ message: slack, messages: history, ctx })).toBeTypeOf("function");
  });

  it("does not count the current message as already played", async () => {
    const only = userMessage("m1", ask);
    expect(await script({ message: only, messages: [only], ctx })).toBeTypeOf("function");
  });

  /** The fall-through turn in between is what this rule exists to protect: it
   *  is an EDIT of what the tour put on screen, and a second replay would
   *  overwrite the thing being edited. */
  it("stays spent across intervening live turns", async () => {
    const again = userMessage("m5", ask);
    const history = [
      userMessage("m1", ask),
      assistantMessage("m2", "Five units are behind."),
      userMessage("m3", "make the late markers purple"),
      assistantMessage("m4", "Done."),
      again,
    ];
    expect(await script({ message: again, messages: history, ctx })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* replay                                                              */
/* ------------------------------------------------------------------ */

const typesOf = (chunks: Chunk[]): string[] => chunks.map((chunk) => String(chunk["type"]));
const textOf = (chunks: Chunk[]): string =>
  chunks.filter((chunk) => chunk["type"] === "text-delta").map((chunk) => String(chunk["delta"])).join("");

describe("replaying prose", () => {
  it("opens and closes its own assistant message", async () => {
    const { writer, chunks } = recorder();
    await replayTour({ writer, parts: [{ text: "Hi." }], seed: "s", apps: fakeApps().apps, ctx });
    expect(typesOf(chunks)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    expect(chunks[0]!["messageId"]).toMatch(/^msg_/);
  });

  it("streams the whole text, in several deltas, at a provider's chunk sizes", async () => {
    const { writer, chunks } = recorder();
    const text = "Five units are behind on rent this month, and Alder Court 3B is the one to call first.";
    await replayTour({ writer, parts: [{ text }], seed: "s", apps: fakeApps().apps, ctx });
    const deltas = chunks.filter((chunk) => chunk["type"] === "text-delta");
    expect(textOf(chunks)).toBe(text);
    expect(deltas.length).toBeGreaterThan(1);
    // A delta carries several words, never one character and never the lot.
    for (const delta of deltas) expect(String(delta["delta"]).length).toBeLessThan(60);
  });

  it("replays several parts in order", async () => {
    const { writer, chunks } = recorder();
    await replayTour({
      writer,
      parts: [{ text: "One." }, { text: "Two." }],
      seed: "s",
      apps: fakeApps().apps,
      ctx,
    });
    expect(textOf(chunks)).toBe("One.Two.");
  });

  it("stops early on an aborted turn", async () => {
    const { writer, chunks } = recorder();
    const controller = new AbortController();
    controller.abort();
    await replayTour({
      writer,
      parts: [{ text: "One." }, { text: "Two." }],
      seed: "s",
      apps: fakeApps().apps,
      ctx,
      signal: controller.signal,
    });
    expect(textOf(chunks)).toBe("");
    expect(typesOf(chunks)).toEqual(["start", "start-step", "finish-step", "finish"]);
  });
});

/**
 * DETERMINISM. A rehearsed demo has to run the same way twice, so every gap and
 * every chunk boundary comes from a stream seeded by the entry's own prompt.
 * `Math.random` would give the same unevenness and lose the repeatability,
 * which is the wrong half to keep.
 */
describe("determinism", () => {
  it("cuts the same deltas in the same places on every run", async () => {
    const text = "Five units are behind. Alder Court 3B is 41 days out and owes $3,400.";
    const run = async (): Promise<unknown[]> => {
      const { writer, chunks } = recorder();
      await replayTour({ writer, parts: [{ text }], seed: "entry-0", apps: fakeApps().apps, ctx });
      return chunks.filter((chunk) => chunk["type"] === "text-delta").map((chunk) => chunk["delta"]);
    };
    expect(await run()).toEqual(await run());
  });

  it("gives two entries different cadences", async () => {
    const text = "Five units are behind. Alder Court 3B is 41 days out and owes $3,400.";
    const run = async (seed: string): Promise<unknown[]> => {
      const { writer, chunks } = recorder();
      await replayTour({ writer, parts: [{ text }], seed, apps: fakeApps().apps, ctx });
      return chunks.filter((chunk) => chunk["type"] === "text-delta").map((chunk) => chunk["delta"]);
    };
    expect(await run("entry-0")).not.toEqual(await run("entry-1"));
  });

  it("never draws from Math.random", async () => {
    const random = vi.spyOn(Math, "random");
    const { writer } = recorder();
    await replayTour({
      writer,
      parts: [{ text: "Five units are behind." }, { app: APP_DOCUMENT, buildMs: 1 }],
      seed: "entry-0",
      apps: fakeApps().apps,
      ctx,
    });
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("seededRoll stays inside its range and repeats for the same seed", () => {
    const draws = (seed: string): number[] => {
      const roll = seededRoll(seed);
      return Array.from({ length: 20 }, () => roll(10, 20));
    };
    for (const value of draws("a")) {
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThan(20);
    }
    expect(draws("a")).toEqual(draws("a"));
    expect(draws("a")).not.toEqual(draws("b"));
  });
});

/**
 * An app part is a REAL app row, not painted pixels: imported for this
 * principal so it opens, pins, and — the point — can be EDITED by the next,
 * live turn, which reads its id out of the create tool's output.
 */
describe("replaying an app", () => {
  it("imports the document, then streams it like a generation", async () => {
    const { apps, imported } = fakeApps();
    const { writer, chunks } = recorder();
    await replayTour({ writer, parts: [{ app: APP_DOCUMENT, buildMs: 1 }], seed: "s", apps, ctx });
    expect(imported).toEqual([APP_DOCUMENT]);
    expect(typesOf(chunks)).toEqual([
      "start",
      "start-step",
      "tool-input-start",
      "tool-input-available",
      // three partials, then the settled payload
      "data-vendo-view",
      "data-vendo-view",
      "data-vendo-view",
      "data-vendo-view",
      "tool-output-available",
      "finish-step",
      "finish",
    ]);
  });

  it("names the create tool and marks every tool chunk dynamic, exactly as the live loop does", async () => {
    const { writer, chunks } = recorder();
    await replayTour({ writer, parts: [{ app: APP_DOCUMENT, buildMs: 1 }], seed: "s", apps: fakeApps().apps, ctx });
    const toolChunks = chunks.filter((chunk) => String(chunk["type"]).startsWith("tool-"));
    for (const chunk of toolChunks) expect(chunk["dynamic"]).toBe(true);
    expect(toolChunks[0]!["toolName"]).toBe("vendo_apps_create");
  });

  /** The id the next turn edits. Shaped exactly like the runtime's own outcome,
   *  so nothing downstream can tell this apart from a real create. */
  it("returns the imported document as the tool's output, id included", async () => {
    const { writer, chunks } = recorder();
    await replayTour({ writer, parts: [{ app: APP_DOCUMENT, buildMs: 1 }], seed: "s", apps: fakeApps().apps, ctx });
    const output = chunks.find((chunk) => chunk["type"] === "tool-output-available")!["output"];
    expect(output).toEqual({ status: "ok", output: { ...APP_DOCUMENT, id: "app_replayed" } });
  });

  it("streams partials under one reconciling id, the last one settled", async () => {
    const { writer, chunks } = recorder();
    await replayTour({ writer, parts: [{ app: APP_DOCUMENT, buildMs: 1 }], seed: "s", apps: fakeApps().apps, ctx });
    const views = chunks.filter((chunk) => chunk["type"] === "data-vendo-view");
    for (const view of views) expect(view["id"]).toBe("vendo-view:app_replayed");
    const payloads = views.map((view) => (view["data"] as { payload: Record<string, unknown> }).payload);
    // Every partial is flagged streaming; the settled one is not — that flag is
    // what flips the bar to ready and puts the pin affordance on screen.
    expect(payloads.slice(0, -1).every((payload) => payload["streaming"] === true)).toBe(true);
    expect(payloads.at(-1)!["streaming"]).toBeUndefined();
    // Node count never regresses: the renderer reconciles a growing prefix.
    const counts = payloads.map((payload) => (payload["nodes"] as unknown[]).length);
    expect(counts).toEqual([...counts].sort((left, right) => left - right));
  });

  it("fails loudly when the app cannot be opened as a tree", async () => {
    const { apps } = fakeApps({ open: { kind: "failed", reason: "nope" } });
    const { writer } = recorder();
    await expect(
      replayTour({ writer, parts: [{ app: APP_DOCUMENT, buildMs: 1 }], seed: "s", apps, ctx }),
    ).rejects.toThrow(/opened as "failed"/);
  });
});

describe("progressivePayloads", () => {
  it("grows the node prefix and lands each island's source one stage late", () => {
    const prefixes = progressivePayloads(TREE as unknown as Record<string, unknown>);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes[0]!["components"]).toEqual({});
    for (const prefix of prefixes) expect(prefix["streaming"]).toBe(true);
  });

  it("trims a node's children to the nodes that have arrived", () => {
    const prefixes = progressivePayloads(TREE as unknown as Record<string, unknown>);
    for (const prefix of prefixes) {
      const nodes = prefix["nodes"] as { id: string; children?: string[] }[];
      const ids = new Set(nodes.map((node) => node.id));
      for (const node of nodes) for (const child of node.children ?? []) expect(ids.has(child)).toBe(true);
    }
  });

  it("has nothing to deal for a one-node app", () => {
    expect(progressivePayloads({ nodes: [{ id: "n0", component: "Card" }] })).toEqual([]);
  });
});

/**
 * The three `respond` shapes are one ladder: a string for the common case, one
 * part when it is an app, an array when it is a sequence.
 */
describe("respond shapes", () => {
  const play = async (respond: TourEntry["respond"]): Promise<Chunk[]> => {
    const script = createTourScript({ tours: [{ prompt: "go", respond }], apps: fakeApps().apps });
    const message = userMessage("m1", "go");
    const turn = await script({ message, messages: [message], ctx });
    const { writer, chunks } = recorder();
    await turn!({ writer });
    return chunks;
  };

  it("takes a bare string as prose", async () => {
    expect(textOf(await play("Just prose."))).toBe("Just prose.");
  });

  it("takes a single part", async () => {
    expect(textOf(await play({ text: "One part." }))).toBe("One part.");
  });

  it("takes a sequence", async () => {
    const chunks = await play([{ text: "First." }, { app: APP_DOCUMENT, buildMs: 1 }, { text: "Done." }]);
    expect(textOf(chunks)).toBe("First.Done.");
    expect(typesOf(chunks)).toContain("tool-output-available");
  });
});
