/**
 * The workbench — a DEV-ONLY diagnostics channel for one turn.
 *
 * The machine talking about itself is never a product surface, so it rides the
 * wire the way `status` does: a TRANSIENT `data-vendo-debug` part, which the
 * ai-SDK delivers to the client and never adds to message history (see
 * `VENDO_STATUS_PART` in ./wire.ts). Nothing here is ever persisted.
 *
 * The whole gate is `VENDO_WORKBENCH=1` on the SERVER, read once per turn by
 * {@link openWorkbench}. Unset, no channel is registered, so every {@link
 * emitWorkbench} is a map miss and returns — there is no second flag to check and
 * no part can reach the wire.
 */
import type { TurnId } from "@vendoai/core";

/** Which loop is speaking. The resident is the turn's own thinker; `screen` is
 *  the closed-loadout drive that paints; `subagent` is a hire, which shares the
 *  resident's turn and therefore its channel. */
export type WorkbenchAgent = "resident" | "screen" | "subagent";

/** One diagnostic fact. Additive by design — a new member is a pane that has not
 *  learned to render it yet, never a break. */
export type WorkbenchEvent =
  | { kind: "step-start"; step: number; maxSteps: number; activeTools: readonly string[] }
  | {
      kind: "step-end";
      step: number;
      stopReason: string;
      durationMs: number;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | {
      kind: "tool";
      step: number;
      toolCallId: string;
      name: string;
      argsPreview: string;
      status: "ok" | "denied" | "error";
      guard?: "run" | "ask" | "block";
      approval?: "auto" | "approved" | "timed-out" | "denied";
      durationMs: number;
    }
  | { kind: "context"; estTokens: number; windowTokens: number; triggerTokens: number }
  | { kind: "compaction"; reason: "trigger" | "overflow-retry"; summary: string }
  | { kind: "shed"; dropped: number }
  | {
      kind: "loadout";
      active: readonly string[];
      searchedIn: readonly string[];
      alwaysActive: readonly string[];
      withheldCount: number;
    }
  | { kind: "subagent"; label: string; steps: number; maxSteps: number; report?: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "step-limit"; steps: number };

/** What one `data-vendo-debug` part carries. `seq` is per TURN — a hire's events
 *  interleave with the resident's on one ordered stream, which is the order they
 *  actually happened in. */
export interface WorkbenchPart {
  turnId: string;
  seq: number;
  at: number;
  agent: WorkbenchAgent;
  event: WorkbenchEvent;
}

interface Channel {
  write: (part: WorkbenchPart) => void;
  seq: number;
  /** The last emitter and the step it was on — see {@link workbenchCursor}. */
  agent: WorkbenchAgent;
  step: number;
}

const channels = new Map<TurnId, Channel>();

/**
 * Open the turn's channel, and hand back its closer.
 *
 * The flag is read HERE and nowhere else: a turn that starts with the workbench
 * off registers nothing, so it cannot be turned on halfway through a turn and
 * cannot emit half a stream.
 */
export function openWorkbench(turnId: TurnId, write: (part: WorkbenchPart) => void): () => void {
  // `typeof process` first: this package bundles for a Worker target too (the
  // portability gate checks it), and a runtime without `process` at all would
  // otherwise take the turn down before it started.
  const flag = typeof process === "undefined" ? undefined : process.env.VENDO_WORKBENCH;
  if (flag !== "1") return () => {};
  channels.set(turnId, { write, seq: 0, agent: "resident", step: 0 });
  return () => {
    channels.delete(turnId);
  };
}

/** One fact, if anyone is listening. A closed turn (or a turn that never opened
 *  a channel, which is every turn in production) costs one map lookup. */
export function emitWorkbench(
  turnId: TurnId | undefined,
  agent: WorkbenchAgent,
  event: WorkbenchEvent,
): void {
  if (turnId === undefined) return;
  const channel = channels.get(turnId);
  if (channel === undefined) return;
  channel.agent = agent;
  if (event.kind === "step-start") channel.step = event.step;
  channel.write({ turnId, seq: channel.seq, at: Date.now(), agent, event });
  channel.seq += 1;
}

/**
 * Where the turn is standing right now, for a call site that holds no step of its
 * own — the guarded-call path serves the resident, the screen agent and a hire
 * through one function and cannot tell them apart. Read at the START of a call,
 * so a hire's own tool events carry the hire while the `hire_subagent` call still
 * open above them carries the resident.
 */
export function workbenchCursor(turnId: TurnId | undefined): { agent: WorkbenchAgent; step: number } {
  const channel = turnId === undefined ? undefined : channels.get(turnId);
  return channel === undefined
    ? { agent: "resident", step: 0 }
    : { agent: channel.agent, step: channel.step };
}
