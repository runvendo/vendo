/** The one place a Vendo block says something out loud.
 *
 * Every block used to call `console.*` directly, so a host embedding Vendo had
 * no way to route what Vendo says into its own observability — and no way to
 * quieten it. This is the seam: a block emits a structured `VendoLogEvent`, the
 * host swaps the sink with `setLogger`, and the default sink writes exactly the
 * console line the bare call wrote.
 *
 * Byte-identical is a CONTRACT, not an aspiration. The migration of every bare
 * call site is mechanical:
 *
 *   console.error("[vendo] x:", err)
 *     → log({ code, level: "error", message: "[vendo] x:", data: { err } })
 *
 * so `data`'s KEY INSERTION ORDER is the original argument order — the default
 * sink spreads `Object.values(data)` after the message, and object key order is
 * insertion order for string keys. Reordering keys at a call site silently
 * reorders that line's output. The `[vendo] ` prefix stays inside `message`
 * (rather than being added by the sink) for the same reason: a custom sink gets
 * the message the console showed, and no call site's text changes.
 */

export type VendoLogLevel = "debug" | "info" | "warn" | "error";

/** A stable dotted id, `"<block>.<subject>"` — what an operator greps and what a
 *  host keys an alert on. `string & {}` keeps the literals this repo uses as the
 *  suggested set while the union grows one call site at a time. */
export type VendoLogCode = string & {};

export interface VendoLogEvent {
  code: VendoLogCode;
  level: VendoLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export type VendoLogger = (event: VendoLogEvent) => void;

/** Which console method each level used before this file existed. */
const METHODS: Record<VendoLogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

/** The default sink: the bare `console.*` line, reassembled. */
export const consoleLogger: VendoLogger = (event) => {
  console[METHODS[event.level]](event.message, ...Object.values(event.data ?? {}));
};

let current: VendoLogger = consoleLogger;

export function log(event: VendoLogEvent): void {
  current(event);
}

/** Install a sink. `undefined` restores `consoleLogger`. */
export function setLogger(logger: VendoLogger | undefined): void {
  current = logger ?? consoleLogger;
}
