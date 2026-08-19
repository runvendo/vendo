/** The CLOSED catalog of what a Vendo deployment reports about ITSELF, and the
 *  one sink that carries it.
 *
 * Sibling of `log.ts`: that file is what Vendo says out loud to the operator,
 * this one is what the SDK reports about its own health and usage. Same posture
 * — a no-op until something installs a sink, so a keyless deployment carries the
 * type and sends nothing.
 *
 * Five events, and five is the whole list. Every member carries SHAPES, COUNTS
 * and NAMES only: a tool's name, how many steps a run took, which code an error
 * carried. Never a prompt, a tool argument, a file, a row, a message, or a
 * person — a sixth event or a content-carrying field is a contract change, not
 * an addition.
 */

export type VendoUsageEvent =
  /** One deployment came up: which adapters it is RUNNING (after the adapter
   *  rule has filled every slot the host left unset — not the slots themselves),
   *  which blocks mounted, and the host framework when its runtime announces
   *  itself. */
  | { name: "deployment_boot"; adapters: string[]; blocks: string[]; framework: string | null }
  /** One agent turn ended. `tools` are NAMES; `modelFamily` is the model id the
   *  thinking seat resolved to, never a key or a URL.
   *
   * The breakdown is DURATIONS, and durations are the whole of it: `ttftMs` is
   * how long the person waited for the first word, and the five phase marks say
   * where the turn's wall time went — never what was read, prompted, thought,
   * called or judged. `modelMs` is what the other four leave over, so the split
   * always adds up to `durationMs`. */
  | {
      name: "agent_run";
      durationMs: number;
      ttftMs: number;
      storeMs: number;
      promptMs: number;
      modelMs: number;
      toolsMs: number;
      guardMs: number;
      steps: number;
      toolCalls: number;
      tools: string[];
      modelFamily: string | null;
      outcome: "ok" | "error" | "refused";
      errorCode: string | null;
    }
  /** One app generation finished. `components` counts uses per component NAME. */
  | { name: "app_generated"; components: Record<string, number>; durationMs: number; outcome: "ok" | "error"; kind: string }
  /** One guard decision, beside its audit row — never in place of it. */
  | { name: "guard_decision"; kind: string; decision: string; tool: string | null }
  /** Something Vendo itself warned or failed about. `message` is Vendo's own
   *  authored sentence, `data` carries Vendo's own identifiers verbatim and
   *  every other key's SHAPE alone (the closed allowlist in the SDK's
   *  `sdk-events.ts`), and `stack` carries `@vendoai` frames only. */
  | {
      name: "sdk_error";
      code: string;
      level: "warn" | "error";
      message: string;
      data: Record<string, unknown>;
      stack: string[];
      runtime: string;
    };

export type VendoUsageSink = (event: VendoUsageEvent) => void;

let sink: VendoUsageSink | undefined;

/** Report one event. A no-op until a sink is installed — which is the state
 *  every keyless deployment stays in for its whole life. */
export function emitUsage(event: VendoUsageEvent): void {
  sink?.(event);
}

/** Install the sink. `undefined` removes it, and removing it is what a test
 *  does in `afterEach`: a leaked sink is another suite's failure. */
export function setUsageSink(next: VendoUsageSink | undefined): void {
  sink = next;
}
