/**
 * Tour mode — deterministic scripted responses in front of the real agent.
 *
 * Every company that adopts Vendo has to demo it: to its own executives, to a
 * prospect, to a new user on day one. A live agent is the wrong thing to put in
 * front of an audience — it is slow, it is different every time, and the one
 * run that matters is the one where it improvises. So everybody builds the same
 * cache by hand, badly. This is that cache, as a supported feature.
 *
 * A tour is an ordered list of `{ prompt, respond }` entries. An entry fires
 * only on a close variant of its own frozen prompt (./match.ts), and only once
 * per thread. Everything else — every improvised ask, every follow-up about
 * what is on screen — falls through to the live agent, untouched. That is the
 * whole design: a tour answers the questions it was recorded for, and the agent
 * answers the rest, so a demo can be scripted without being fake.
 *
 * Pure OSS config. No key, no Cloud dependency, no hidden branch: a tour
 * behaves identically with and without VENDO_API_KEY.
 */
import type { AppDocument, RunContext } from "@vendoai/core";
import type { ScriptedTurn } from "@vendoai/agent";
import type { UIMessage } from "ai";
import { couldReachTour, matchTour } from "./match.js";
import { replayTour, type TourApps } from "./replay.js";

/**
 * One scripted exchange.
 *
 * ```ts
 * createVendo({
 *   tours: [
 *     { prompt: "Which units are behind on rent?", respond: "Five units are behind." },
 *     {
 *       prompt: ["Build me a late-rent dashboard", "Show me late rent"],
 *       respond: [{ text: "Pulling your rent roll…" }, { app: lateRentApp }],
 *     },
 *   ],
 * })
 * ```
 */
export interface TourEntry {
  /** The frozen prompt this entry answers, and any alternate phrasings of it
   *  (the suggestion chip a host renders beside it is the usual second one).
   *  A typed line matches on close similarity, so typos and small word swaps
   *  still land — but a different ask about the same subject does not. */
  prompt: string | readonly string[];
  /** What to replay. A bare string is prose; an app document is a real app
   *  built on screen; an array is the two in sequence. */
  respond: TourResponse;
}

export type TourResponse = string | TourPart | readonly TourPart[];

/** One beat of a scripted reply. */
export type TourPart =
  | { text: string }
  | {
      /** A recorded app document — the JSON `vendo.apps.exportApp(id, ctx)`
       *  writes for an app the live agent already generated. Replaying it
       *  imports a real, owned copy, so the app opens, pins, and can be edited
       *  by the next (live) turn. Any `id` in the document is ignored: the
       *  import mints a fresh one, exactly as a real generation would. */
      app: TourApp;
      /** How long the build takes, in milliseconds (default 8000). Raise it
       *  toward a real generation's 30–60s when the audience is meant to
       *  believe the app was generated in front of them. */
      buildMs?: number;
    };

export type TourApp = Omit<AppDocument, "id"> & { id?: string };

function phrasingsOf(entry: TourEntry): readonly string[] {
  return typeof entry.prompt === "string" ? [entry.prompt] : entry.prompt;
}

function partsOf(respond: TourResponse): readonly TourPart[] {
  if (typeof respond === "string") return [{ text: respond }];
  return Array.isArray(respond) ? respond : [respond as TourPart];
}

/** The text a user actually typed, as the matcher sees it. */
function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Which entries have already had their turn in this conversation, replayed out
 * of the thread's own history.
 *
 * Derived rather than stored, because the thread is not the tour's alone: every
 * fall-through turn is written by the agent with its own payload, so a
 * bookkeeping field added here would be dropped by the first live turn — which
 * is precisely the turn after an entry plays. The transcript, by contrast, is
 * the one thing both writers preserve.
 *
 * The fold is order-sensitive on purpose: each historical line is matched
 * against what had played BEFORE it, so replaying the history reconstructs the
 * same decisions the live turns made.
 */
function playedEntries(
  messages: readonly UIMessage[],
  entries: readonly (readonly string[])[],
  currentId: string,
): number[] {
  const played: number[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.id === currentId) continue;
    const index = matchTour({ text: userText(message), entries, played });
    if (index !== undefined) played.push(index);
  }
  return played;
}

/**
 * The scripted-turn seam createVendo hands the agent when a host configures
 * `tours`. Returns a replay for a turn a tour owns, and undefined — with
 * nothing written and no state touched — for every other turn.
 */
export function createTourScript(config: {
  tours: readonly TourEntry[];
  apps: TourApps;
}): (input: {
  message: UIMessage;
  messages: readonly UIMessage[];
  ctx: RunContext;
}) => Promise<ScriptedTurn | undefined> {
  const entries = config.tours.map(phrasingsOf);
  return async (input) => {
    // A tour answers typed asks. An assistant message is a resumed approval,
    // which belongs to whichever turn parked it.
    if (input.message.role !== "user") return undefined;
    const text = userText(input.message);
    // The cheap gate, before the history fold. Every improvised ask leaves
    // here, which is why the live path costs what it did before tours existed.
    if (!couldReachTour(text, entries)) return undefined;
    const index = matchTour({
      text,
      entries,
      played: playedEntries(input.messages, entries, input.message.id),
    });
    if (index === undefined) return undefined;
    const entry = config.tours[index]!;
    return async ({ writer, signal }) => {
      try {
        await replayTour({
          writer,
          parts: partsOf(entry.respond),
          // Seeded by the entry's own frozen prompt: same sentence in, same
          // pixels out, every rehearsal.
          seed: entries[index]![0]!,
          apps: config.apps,
          ctx: input.ctx,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        // The wire's error part is deliberately generic (it can carry request
        // internals), so it cannot name the entry that broke. This can — and a
        // tour that fails silently is one a host finds out about on stage.
        console.error("[vendo] tour: replaying an entry failed", {
          prompt: entries[index]![0],
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  };
}
