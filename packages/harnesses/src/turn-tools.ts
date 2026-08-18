import { log } from "@vendoai/core";
import type {
  ApprovalId,
  DeniedNeeds,
  Guard,
  Harness,
  Json,
  RunContext,
  ToolDescriptor,
  ToolListing,
  ToolOutcome,
  ToolRegistry,
  ToolResult,
  TurnId,
  TurnTools,
} from "@vendoai/core";
import type { CapabilityMissReporter } from "./capability-miss.js";
import { guardedCall, previewApproval, type ToolBridgeOptions } from "./tool-bridge.js";
import { emitWorkbench, workbenchCursor, type WorkbenchEvent } from "./workbench.js";

/**
 * Build contract §1.4 — the frozen bound on an interactive approval wait. A
 * closed tab must not hold a turn open forever, and no sandbox lease is held
 * while waiting.
 */
export const APPROVAL_WAIT_MS = 90_000;

/**
 * What the runtime writes to the transcript and the screen on the harness's
 * behalf (build contract §1.5: "Tool calls are mirrored by the runtime, never
 * yielded"). This is the ai-SDK tool-part mirror ONLY — the `data-vendo-*` parts
 * (view, approval, connect, build-failed, citations) are written by the SHIPPED
 * bridge inside `guardedCall`/`previewApproval`, so a harness produces the
 * identical wire the legacy agent path produced.
 */
export type MirrorEvent = ({
  /** The turn that made this call, stamped once by {@link createTurnTools} from
   *  the ctx. Absent only for a call made outside a turn. */
  turnId?: TurnId;
}) & (
  | { kind: "call"; toolCallId: string; name: string; args: Json }
  /** An interactive parked call. The shipped thread renders its consent card off
   *  the NATIVE approval state, so without this the card never appears and the
   *  wait below can only ever time out. */
  | { kind: "approval"; toolCallId: string; approvalId: ApprovalId }
  /** `result` is what the MODEL reads (§1.1's three statuses). `outcome` is what
   *  the SCREEN reads: the ai-SDK path puts the whole typed outcome on the native
   *  tool part, and the connect card is rendered from it. */
  | { kind: "result"; toolCallId: string; name: string; result: ToolResult; outcome?: ToolOutcome }
);

export interface TurnToolsOptions {
  /** The GUARD-BOUND registry (`VendoGuard.bind(tools)`) — the one choke point.
   *  Wrapping it again here would double-charge the guard's breakers. */
  registry: ToolRegistry;
  guard: Guard;
  ctx: RunContext;
  /** §1.4: did the caller prove presence? Decides wait-or-fail, nothing else. */
  interactive: boolean;
  mirror: (event: MirrorEvent) => void;
  /** The rest of the shipped bridge's rails: the writer the `data-vendo-*` parts
   *  go to, `toolOutputCap`, `preflight`, the per-turn `connectCards` dedupe set,
   *  and the capability-miss `onCall` hook. */
  bridge?: Omit<ToolBridgeOptions, "registry" | "ctx" | "guard">;
  /** The capability-miss reporter, listed on the surface and dispatched here.
   *  Unset means the honest-refusal rail is simply not wired for this turn. */
  capabilityMiss?: CapabilityMissReporter;
  /** Contract §1, amendment 2026-08-03: the harness's say over which names it is
   *  offered — `withhold` takes names OFF this surface (claudeCode withholds
   *  `vendo_make`, whose job its own builder does). Never a safety mechanism —
   *  the ctx projection above is. Loadout curation is the brain's own strategy
   *  now (`vendo()`'s tool-search hand), not a runtime rail. */
  toolSurface?: Harness["toolSurface"];
  /** This turn's bound on an interactive approval wait. Unset uses
   *  {@link APPROVAL_WAIT_MS} — the web's closed-tab bound, unchanged. A turn
   *  whose person answers on a human clock (a text message) passes its own. */
  approvalWaitMs?: number;
}

let counter = 0;
const mintToolCallId = (): string => `hcall_${(counter += 1)}_${globalThis.crypto.randomUUID()}`;

/** The workbench's account of one call (dev-only; see ./workbench.ts). */
type ToolFact = Extract<WorkbenchEvent, { kind: "tool" }>;

/** Enough of the arguments to recognize the call and no more — a diagnostics
 *  part must never become a second copy of a 300KB input. */
const argsPreview = (args: Json): string => {
  const text = JSON.stringify(args) ?? "";
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
};

/**
 * §1.4's race: the approvalId only exists once the guard has been consulted, but
 * the user's tap can land in that same tick. Subscribing to every decision for
 * the whole turn and buffering the ones nobody is waiting for yet is what makes
 * the wait reliable; a late subscribe would hang until the timeout.
 */
export interface ApprovalWaiter {
  /** Resolves true/false with the decision, or undefined if the bound expired. */
  wait(approvalId: ApprovalId, timeoutMs: number): Promise<boolean | undefined>;
  /**
   * Note an approval this turn raised, WHICHEVER path minted it — the preview, or
   * the real dispatching check after the preview said run (a breaker or presence
   * boundary). Recording only the ones we wait on would leak the rest forever.
   *
   * `standing: true` marks the `interactive: false` card, which is MEANT to
   * survive the turn so "Grant & re-run" can collect it.
   */
  raise(approvalId: ApprovalId, options?: { standing?: boolean }): void;
  /** Raised, undecided, and not standing — the runtime abandons these at turn
   *  end, so a live-but-dead card cannot accrete in the pending queue. */
  unanswered(): ApprovalId[];
  dispose(): void;
}

export function createApprovalWaiter(guard: Guard): ApprovalWaiter {
  const decided = new Map<ApprovalId, boolean>();
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();
  const raised = new Set<ApprovalId>();
  const standing = new Set<ApprovalId>();
  const unsubscribe = guard.onApprovalDecision((id, approved) => {
    decided.set(id, approved);
    const resolve = waiting.get(id);
    if (resolve !== undefined) {
      waiting.delete(id);
      resolve(approved);
    }
  });
  return {
    raise(approvalId, options) {
      raised.add(approvalId);
      if (options?.standing === true) standing.add(approvalId);
    },
    async wait(approvalId, timeoutMs) {
      raised.add(approvalId);
      const already = decided.get(approvalId);
      if (already !== undefined) return already;
      return new Promise<boolean | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(approvalId);
          resolve(undefined);
        }, timeoutMs);
        waiting.set(approvalId, (approved) => {
          clearTimeout(timer);
          resolve(approved);
        });
      });
    },
    unanswered: () => [...raised].filter((id) => !decided.has(id) && !standing.has(id)),
    dispose: unsubscribe,
  };
}

/** The one generic failure a harness ever sees from a broken seam. Raw
 *  provider/registry internals never travel (consumer voice law, §3). */
const executionError = (): ToolResult => ({
  status: "error",
  error: { code: "execution", message: "The action could not be completed." },
});

/**
 * §1.1 — the runtime's job, not the harness author's: five core statuses in,
 * three out. `pending-approval` is handled by the caller below (interactive
 * callers block first, §1.4), so it is the one status this mapping refuses.
 */
function toToolResult(outcome: Exclude<ToolOutcome, { status: "pending-approval" }>): ToolResult {
  switch (outcome.status) {
    case "ok":
      return { status: "ok", output: outcome.output };
    case "error":
      return { status: "error", error: outcome.error };
    case "blocked":
      return { status: "denied", reason: outcome.reason };
    case "connect-required":
      return {
        status: "denied",
        reason: outcome.connect.message,
        needs: { kind: "connect", toolkit: outcome.connect.toolkit },
      };
  }
}

export interface RuntimeTurnTools extends TurnTools {
  /** §1.4 + the orphaned-approval fix: ids this turn raised and nobody answered. */
  unansweredApprovals(): ApprovalId[];
  dispose(): void;
}

export function createTurnTools(options: TurnToolsOptions): RuntimeTurnTools {
  const waiter = createApprovalWaiter(options.guard);
  const approvalWaitMs = options.approvalWaitMs ?? APPROVAL_WAIT_MS;
  const bridge: ToolBridgeOptions = {
    ...options.bridge,
    registry: options.registry,
    ctx: options.ctx,
    guard: options.guard,
  };

  // The harness's own shaping of the surface (§1 amendment 2026-08-03): a
  // withheld name is off the listing and answers not-found on call, exactly
  // like a name that never existed.
  const withheld = new Set(options.toolSurface?.withhold ?? []);
  const hidden = (name: string): boolean => withheld.has(name);

  /** Stamp the turn on every mirrored event once, here, rather than at each of
   *  the three raise sites — a tracer reading the mirror can join a call to its
   *  turn's audit rows without correlating out of band. */
  const mirror = (event: MirrorEvent): void => {
    options.mirror(options.ctx.turnId === undefined ? event : { ...event, turnId: options.ctx.turnId });
  };

  const descriptorFor = async (name: string): Promise<ToolDescriptor | undefined> => {
    try {
      return (await options.registry.descriptors()).find((descriptor) => descriptor.name === name);
    } catch {
      return undefined;
    }
  };

  return {
    async list(): Promise<ToolListing[]> {
      // `ctx` is load-bearing, not decoration: the guard-bound registry answers
      // `descriptors(ctx)` with `projectableForRun(all, ctx)`, which is where THE
      // LAW (design §12) withholds destructive and external tools from an
      // unattended run. Asking without it listed EVERY tool to an automation,
      // which the harness then offered its model — and the refusal only arrived
      // at call time. "Not projected into an automation run at all" has to mean
      // not projected.
      const projected = await options.registry.descriptors(options.ctx);
      // Contract §1.1: the full projected surface, minus what the harness
      // withheld. Loadout curation left this file with the de-brain refactor —
      // which tools a model is OFFERED per step is the brain's own strategy
      // (`vendo()`'s tool-search hand gates choice via the loop's activeTools),
      // while what may be offered AT ALL stays the ctx projection above.
      const descriptors = projected.filter((descriptor) => !hidden(descriptor.name));
      const listings: ToolListing[] = descriptors.map((descriptor) => ({
        name: descriptor.name,
        // `title` is presentation-only and optional; absent it the surfaces that
        // show a tool to a person fall back to the name (core tools.ts).
        title: descriptor.title ?? descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
        // Contract §1.1 amendment 2026-07-30: an in-process harness must hand its
        // model real argument schemas, and JSON Schema is the interchange.
        // Without this a third-party harness can see a tool and still not call
        // it — only `vendo()` worked, because composition hands IT the
        // descriptor catalog by closure.
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
        // Contract §1.1 amendment 2026-08-03: the host's DECLARED result shape,
        // when extraction found one. The model reads field names off the listing
        // instead of calling a query once to learn them.
        ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
      }));
      // The miss reporter rides the same listing, so a harness offers it exactly
      // the way it offers everything else — an honest refusal has to be reachable
      // from every brain.
      if (options.capabilityMiss !== undefined && !hidden(options.capabilityMiss.listing.name)) {
        listings.push(options.capabilityMiss.listing);
      }
      return listings;
    },

    async call(name, args): Promise<ToolResult> {
      const toolCallId = mintToolCallId();
      const startedAt = Date.now();
      // Read BEFORE the call runs, not after — see `workbenchCursor`.
      const at = workbenchCursor(options.ctx.turnId);
      let guard: ToolFact["guard"];
      let approval: ToolFact["approval"];
      mirror({ kind: "call", toolCallId, name, args });
      const finish = (result: ToolResult, outcome?: ToolOutcome): ToolResult => {
        mirror({ kind: "result", toolCallId, name, result, ...(outcome === undefined ? {} : { outcome }) });
        // `ask` is the truer fact where it is already set — the guard asked and
        // the ask went unanswered — so a refusal below does not overwrite it.
        if (outcome?.status === "blocked" && guard !== "ask") guard = "block";
        emitWorkbench(options.ctx.turnId, at.agent, {
          kind: "tool",
          step: at.step,
          toolCallId,
          name,
          argsPreview: argsPreview(args),
          status: result.status,
          ...(guard === undefined ? {} : { guard }),
          ...(approval === undefined ? {} : { approval }),
          durationMs: Date.now() - startedAt,
        });
        return result;
      };
      /**
       * A call refused because the CONSENT for it is missing — §1.4's presence
       * boundaries: nobody was here to tap, the check could not run, or the guard
       * asked a second time. Nobody said no to any of them.
       *
       * So it settles as a typed `blocked` outcome, exactly like a policy block,
       * and never as the ai-SDK's `output-denied` (`wire.ts`): that state is the
       * terminal state of an approval a PERSON turned down, its conversion takes
       * the refusal's words off the part's `approval`, and a refusal nobody was
       * asked about carries none — so the part could not be converted into the
       * NEXT turn's prompt, and one refused call killed the thread from then on.
       * The card such a refusal leaves standing is the GUARD's (§1.4's "Grant &
       * re-run" collects it from there, and the `data-vendo-approval` part beside
       * this one carries its id); nothing about the grant reads this state.
       */
      const refused = (reason: string, needs?: DeniedNeeds): ToolResult =>
        finish(
          { status: "denied", reason, ...(needs === undefined ? {} : { needs }) },
          { status: "blocked", reason },
        );

      try {
        // The miss reporter first, and NOT through the guard: it never reaches
        // the world — it writes a telemetry row — so searching/reporting spend no
        // authority. It is still mirrored and audited like any call. A hidden
        // name is not a tool this harness has: it was never listed, so the
        // honest answer to calling it is the same not-found any typo gets.
        const reporter = options.capabilityMiss;
        if (reporter !== undefined && name === reporter.listing.name && !hidden(name)) {
          const outcome = await reporter.execute(args);
          return finish(
            outcome.status === "pending-approval"
              ? { status: "denied", reason: "This still needs approval." }
              : toToolResult(outcome),
          );
        }

        const descriptor = hidden(name) ? undefined : await descriptorFor(name);
        if (descriptor === undefined) {
          return finish({
            status: "error",
            error: { code: "not-found", message: `Unknown tool: ${name}` },
          });
        }

        // §1.4: PREVIEW first, exactly as the ai-SDK path's needsApproval hook
        // does. The preview IS this call's guard evaluation — the dispatch below
        // runs on the verdict it computed and commits the spends it left
        // (guard.ts, `#decideForExecution`) — so rules, grants and the judge see
        // this call once, and it is executed once.
        let approvalId: ApprovalId | undefined;
        const ask = await previewApproval(descriptor, bridge, args, { toolCallId }, (id) => {
          approvalId = id;
        });
        guard = ask ? "ask" : "run";
        approval = ask ? undefined : "auto";

        if (ask) {
          if (approvalId !== undefined) {
            waiter.raise(approvalId, { standing: !options.interactive });
          }
          if (!options.interactive) {
            // Nobody is here to tap, so the run fails loudly and the card stands
            // as the grant "Grant & re-run" will collect.
            return refused(
              "This needs your approval, and nobody is here to give it.",
              approvalId === undefined ? undefined : { kind: "approval", approvalId },
            );
          }
          if (approvalId === undefined) {
            // The guard failed closed and minted no id to wait on.
            return refused("This needs approval, and the check could not run.");
          }
          // Raise the card BEFORE blocking: the tap that resolves this wait can
          // only come from a surface that knows the call is parked.
          mirror({ kind: "approval", toolCallId, approvalId });
          const approved = await waiter.wait(approvalId, approvalWaitMs);
          approval = approved === undefined ? "timed-out" : approved ? "approved" : "denied";
          if (approved === undefined) {
            // An elapsed wait is nobody's no (H2-G): the model still reads a
            // denial that names what it needs, but the typed outcome the
            // screen persists carries `cause: "expired"` so the beat can say
            // the question expired instead of blaming the person — the
            // ai-SDK's output-denied state MEANS "the person answered no",
            // which is exactly what did not happen here.
            return finish(
              {
                status: "denied",
                reason: "The approval timed out.",
                needs: { kind: "approval", approvalId },
              },
              {
                status: "blocked",
                reason: "The approval request expired unanswered.",
                cause: "expired",
              },
            );
          }
          if (!approved) return finish({ status: "denied", reason: "You turned this down." });
        }

        // The SHIPPED guarded-call path: the guard, the audit row, the view
        // channel (a `vendo_apps_*` tree plus the VENDO_VIEW_STREAM partials),
        // the connect card, the build-failed banner, the citations part and
        // `toolOutputCap` all come from here — never a second implementation.
        const outcome = await guardedCall(descriptor, bridge, args, { toolCallId });
        if (outcome.status === "pending-approval") {
          // The preview said run and the REAL check asked — a breaker or presence
          // boundary. Nobody is waiting on this one, so it must still be swept.
          waiter.raise(outcome.approvalId, { standing: !options.interactive });
          // The guard asked twice for one tap; refusing to loop is the honest
          // answer (a second card for the same call would be a trap).
          return refused("This still needs approval.", {
            kind: "approval",
            approvalId: outcome.approvalId,
          });
        }
        return finish(toToolResult(outcome), outcome);
      } catch (error) {
        // §1.1: call() never throws. A bug anywhere above becomes a result — and
        // the operator hears WHICH bug, because the sentence below is the same one
        // for every one of them.
        log({
          code: "harnesses.tool-call-failed",
          level: "error",
          message: `[vendo] ${name} could not be called:`,
          data: { error },
        });
        return finish(executionError());
      }
    },

    unansweredApprovals: waiter.unanswered,
    dispose: waiter.dispose,
  };
}
