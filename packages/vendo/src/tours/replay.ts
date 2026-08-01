/**
 * Replaying one tour entry — what makes a recording read as a live turn.
 *
 * A tour's whole value is that the audience cannot tell it from the real
 * thing, and the two ways to lose that are BOTH about time:
 *
 *  - too even. A live provider flushes a few words, stalls, bursts. A
 *    metronome-even drip is the loudest tell there is, so every gap is drawn
 *    from a seeded stream — uneven, and the same unevenness on every run.
 *    `Math.random` would give the unevenness and lose the repeatability, which
 *    is the wrong half to keep: a rehearsed demo has to run the same way twice.
 *  - too fast. Every mark below is an ABSOLUTE offset from the moment the
 *    stream opened, and `at()` sleeps only the remainder. A fixed sleep per
 *    step ADDS to whatever the I/O under it costs, so the same replay that
 *    takes 13s against a hosted store finishes in 8s against a local one, and
 *    a beat that outruns its own narration reads as a recording. Offsets spend
 *    the store's latency INSIDE the budget instead of on top of it.
 *
 * Everything else about the turn is real: the chunk vocabulary is the one the
 * agent's own loop emits, an app part is a REAL app row imported for this
 * principal (openable, pinnable, and editable by the next, live turn), and the
 * turn persists through the same path a model turn does.
 */
import {
  toVendoWirePart,
  vendoViewStreamId,
  VENDO_APPS_CREATE_TOOL,
  type AppDocument,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import type { UIMessage, UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { TourPart } from "./index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The thinking silence before the first part — the panel's own indicator,
 *  alone, for about as long as a real turn takes to decide its first move. */
const THINKING_MS = 900;

/** The pause between two parts of one reply. */
const BETWEEN_PARTS_MS = 500;

/**
 * How long an app part takes to build, unless the entry says otherwise.
 *
 * A REAL generation of a dashboard-sized app takes 51–60s on a production host,
 * with its first partial painting at 26–28s (measured 2026-07-31, three runs).
 * A replay that settles in one second is therefore not a faithful recording —
 * it is four times faster than the thing it claims to be, which an audience
 * that has seen the honest one will notice.
 *
 * 8 seconds is the compromise: long enough to read as work being done, short
 * enough that a first-time developer wiring their first tour does not think the
 * feature is broken. Raise `buildMs` toward a real generation's clock when the
 * audience is meant to believe it was generated in front of them.
 */
const DEFAULT_BUILD_MS = 8_000;

/** Where in the build window the first partial lands — before it, the status
 *  ribbon counts up with nothing on screen yet, which is exactly what a real
 *  generation shows while it streams its brief into the paint lane. */
const FIRST_PARTIAL_FRACTION = 0.35;

type Writer = UIMessageStreamWriter<UIMessage>;

function write(writer: Writer, chunk: UIMessageChunk): void {
  writer.write(chunk as never);
}

/** A deterministic draw in [min, max). */
export type Roll = (min: number, max: number) => number;

/**
 * Per-entry seeded jitter (mulberry32 over the entry's own frozen prompt).
 *
 * Seeded by the prompt and restarted at the top of every replay, so the same
 * sentence in gives the same pixels out on every rehearsal — while the cadence
 * inside the reply stays as uneven as a live provider's.
 */
export function seededRoll(seed: string): Roll {
  let state = 0x02f6e2b1;
  for (let index = 0; index < seed.length; index += 1) {
    state = (Math.imul(state ^ seed.charCodeAt(index), 0x85ebca6b) + 0x9e3779b9) >>> 0;
  }
  return (min, max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + (((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000) * (max - min);
  };
}

/** The beat clock: absolute offsets from the moment the replay opened. */
export function beatClock(now: () => number = Date.now): {
  at: (offsetMs: number) => Promise<void>;
  elapsed: () => number;
} {
  const started = now();
  return {
    at: (offsetMs) => sleep(offsetMs - (now() - started)),
    elapsed: () => now() - started,
  };
}

/**
 * One inter-delta gap: mostly the provider's steady flush, sometimes two
 * arriving together, occasionally a stall. The three cases and their weights
 * are measured against real turns, not invented.
 *
 * `steady` forces the middle case for a block's FIRST gap: a burst there
 * flashes a short sentence onto the screen almost whole, which no live turn
 * does.
 */
function deltaGap(roll: Roll, steady: boolean): number {
  const dice = steady ? 0.5 : roll(0, 1);
  if (dice < 0.16) return roll(80, 140);
  if (dice < 0.26) return roll(480, 640);
  return roll(280, 480);
}

/**
 * Prose at a live provider's cadence.
 *
 * Measured against real turns: a delta carries 20–55 characters — several
 * words, not one — and lands 76–530ms after the last, averaging ~120 characters
 * a second, with the odd burst and the odd stall. A word every 24ms is 200
 * characters a second in a metronome-even drip, and that drip is what gives a
 * recording away.
 */
export async function streamTourText(
  writer: Writer,
  text: string,
  roll: Roll,
  signal?: AbortSignal,
): Promise<void> {
  const id = `txt_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  write(writer, { type: "text-start", id });
  const words = text.split(/(?<=\s)/);
  let index = 0;
  let gaps = 0;
  let opening = true;
  while (index < words.length) {
    if (signal?.aborted) break;
    // A delta is however many whole words land inside one flush's worth of
    // characters, so the chunk boundaries fall where a provider's would.
    const flush = roll(16, 38);
    let delta = "";
    while (index < words.length && delta.length < flush) {
      delta += words[index];
      index += 1;
    }
    // The gap goes BEFORE every delta but the first: the wait for the first
    // token is the caller's thinking silence, not this loop's business.
    if (!opening) {
      await sleep(deltaGap(roll, gaps === 0));
      gaps += 1;
    }
    opening = false;
    write(writer, { type: "text-delta", id, delta });
  }
  write(writer, { type: "text-end", id });
}

interface TreeNode {
  id: string;
  component: string;
  source?: string;
  props?: Record<string, unknown>;
  children?: string[];
}

/**
 * Valid-while-partial prefixes of a settled payload, shaped like the paint
 * lane's own partial emissions: a growing node prefix (children trimmed to the
 * nodes that have arrived), each generated island's source landing one stage
 * AFTER its node so the shape-aware skeleton gets a beat on screen, every
 * prefix flagged `streaming`.
 *
 * This is what makes a replayed app FEEL generated. Without it the app snaps in
 * whole, which reads as a mock.
 */
export function progressivePayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  const nodes = (Array.isArray(payload["nodes"]) ? payload["nodes"] : []) as TreeNode[];
  const components = (payload["components"] ?? {}) as Record<string, string>;
  if (nodes.length < 2) return [];
  const stages = Math.min(5, nodes.length);
  const arrivedSources = (cut: number): Record<string, string> =>
    Object.fromEntries(
      Object.entries(components).filter(([name]) =>
        nodes.slice(0, cut).some((node) => node.source === "generated" && node.component === name),
      ),
    );
  const seen = new Set<string>();
  const prefixes: Record<string, unknown>[] = [];
  for (let stage = 1; stage <= stages; stage += 1) {
    const cut = Math.max(1, Math.ceil((nodes.length * stage) / stages));
    const previousCut = stage === 1 ? 0 : Math.max(1, Math.ceil((nodes.length * (stage - 1)) / stages));
    const included = nodes.slice(0, cut);
    const ids = new Set(included.map((node) => node.id));
    const arrived = arrivedSources(previousCut);
    const signature = `${cut}:${Object.keys(arrived).sort().join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    prefixes.push({
      ...payload,
      streaming: true,
      nodes: included.map((node) =>
        node.children === undefined ? node : { ...node, children: node.children.filter((child) => ids.has(child)) },
      ),
      components: arrived,
    });
  }
  return prefixes;
}

/** The apps doors a replay needs — narrow on purpose, so a tour can be tested
 *  without composing a runtime. */
export type TourApps = Pick<AppsRuntime, "importApp" | "open" | "get">;

function emitView(writer: Writer, appId: string, payload: unknown): void {
  write(
    writer,
    toVendoWirePart(
      { type: "data-vendo-view", appId, payload } as never,
      vendoViewStreamId(appId as AppId),
    ) as UIMessageChunk,
  );
}

/**
 * An app part: a REAL app row, imported for this principal, streamed in the
 * shape a real generation streams.
 *
 * Importing rather than emitting view parts alone is what makes the tour's own
 * follow-up work. A real generation leaves a finished AppDocument, id included,
 * in the `vendo_apps_create` output; the agent reads the id from there and can
 * edit the app on the NEXT turn — the one that falls through to the live model.
 * A replay that only painted pixels would leave the transcript naming no app
 * anywhere, and "make the late markers purple" would land on an agent with
 * nothing to target. (Measured on production 2026-07-31: asked with no appId in
 * the transcript, the agent answers "I don't have a reference to it in this
 * session to edit"; asked while naming the app, it guesses the NAME as the id
 * and the edit fails.)
 */
async function replayApp(input: {
  writer: Writer;
  apps: TourApps;
  ctx: RunContext;
  document: Omit<AppDocument, "id"> & { id?: string };
  buildMs: number;
  roll: Roll;
  at: (offsetMs: number) => Promise<void>;
  from: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { writer, roll, at, from, buildMs } = input;
  // Imported BEFORE the tool part opens: the id the part carries has to be the
  // real one, and an import that fails must not leave a half-opened tool call
  // on the transcript.
  const imported = await input.apps.importApp(input.document as AppDocument, input.ctx);
  const surface = await input.apps.open(imported.id, input.ctx);
  if (surface.kind !== "tree") {
    throw new Error(`tour app ${imported.id} opened as "${surface.kind}", which has no tree to stream`);
  }
  // `name` rides the payload so the app card titles itself.
  const payload = { name: imported.name, ...surface.payload } as unknown as Record<string, unknown>;
  const toolCallId = `call_${globalThis.crypto.randomUUID()}`;
  // `dynamic: true` on all three, because the agent registers EVERY tool
  // through the ai-SDK's `dynamicTool` — without it the client assembles a
  // static `tool-vendo_apps_create` part where a live turn produces a
  // `dynamic-tool` one, and the chrome renders the two differently.
  write(writer, { type: "tool-input-start", toolCallId, toolName: VENDO_APPS_CREATE_TOOL, dynamic: true });
  await sleep(roll(60, 140));
  write(writer, {
    type: "tool-input-available",
    toolCallId,
    toolName: VENDO_APPS_CREATE_TOOL,
    input: { prompt: imported.description ?? imported.name },
    dynamic: true,
  });
  const prefixes = progressivePayloads(payload);
  const firstAt = from + buildMs * FIRST_PARTIAL_FRACTION;
  const readyAt = from + buildMs;
  const step = prefixes.length === 0 ? 0 : (readyAt - firstAt) / (prefixes.length + 1);
  for (const [index, partial] of prefixes.entries()) {
    if (input.signal?.aborted) return;
    await at(firstAt + index * step + roll(-0.16, 0.16) * step);
    emitView(writer, imported.id, partial);
  }
  await at(readyAt);
  emitView(writer, imported.id, payload); // no `streaming` flag — the bar flips ready, the pin appears
  // Shaped exactly like the runtime's own outcome, so nothing downstream can
  // tell this apart from a real create.
  write(writer, {
    type: "tool-output-available",
    toolCallId,
    output: { status: "ok", output: imported },
    dynamic: true,
  });
}

/** Replay one entry's parts onto the turn's stream. */
export async function replayTour(input: {
  writer: Writer;
  parts: readonly TourPart[];
  seed: string;
  apps: TourApps;
  ctx: RunContext;
  signal?: AbortSignal;
}): Promise<void> {
  const { writer, signal } = input;
  const { at, elapsed } = beatClock();
  const roll = seededRoll(input.seed);
  // A manually written turn opens and closes its own message: without these the
  // stream carries parts that belong to no assistant message, and `onFinish`
  // has nothing to persist.
  write(writer, { type: "start", messageId: `msg_${globalThis.crypto.randomUUID()}` });
  write(writer, { type: "start-step" });
  let cursor = THINKING_MS;
  for (const part of input.parts) {
    if (signal?.aborted) break;
    await at(cursor);
    if ("text" in part) {
      await streamTourText(writer, part.text, roll, signal);
      cursor = elapsed() + BETWEEN_PARTS_MS;
      continue;
    }
    const buildMs = part.buildMs ?? DEFAULT_BUILD_MS;
    await replayApp({
      writer,
      apps: input.apps,
      ctx: input.ctx,
      document: part.app,
      buildMs,
      roll,
      at,
      from: cursor,
      ...(signal === undefined ? {} : { signal }),
    });
    cursor = cursor + buildMs + BETWEEN_PARTS_MS;
  }
  write(writer, { type: "finish-step" });
  write(writer, { type: "finish" });
}
