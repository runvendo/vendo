/**
 * The shapes capability arrives in. Each one goes to a slot that already
 * exists — a tool to the one registry, a skill to the workspace mount, a check
 * to the checking floor — and there is no wrapper around them: a host passes
 * the values themselves to `createVendo`.
 *
 * Type-only, and here in core, so every block may speak these shapes without
 * reaching sideways (build contract §2). The implementations live where the
 * slots do: the composition merge in the umbrella, the floor in
 * `@vendoai/apps`, the skills store next door in `./skills.ts`.
 */
import type { Json } from "./ids.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolDescriptor } from "./tools.js";

/**
 * An executable tool: the frozen neutral {@link ToolDescriptor} the whole system
 * already speaks, plus the one thing a descriptor lacks — how to run it.
 *
 * Execution is always on our side, and the guard wraps it identically to every
 * other tool, so the author writes only the work: return the output, or throw.
 * The denial outcomes (`pending-approval`, `blocked`, `connect-required`) are
 * the guard's to author; a tool definition never fakes one.
 */
export interface ToolDefinition extends ToolDescriptor {
  /**
   * @param input the call's arguments — what almost every tool needs.
   * @param context the run context: whose authority this call carries.
   * @param call the whole call. Present for the one class of tool that reads
   *   something riding on the call itself rather than on its arguments — the
   *   app-create view-stream bridge (`VENDO_VIEW_STREAM`) is the only one — and
   *   for re-expressing an existing `ToolRegistry` as tool definitions without
   *   dropping that rider. Ignore it otherwise.
   */
  execute(input: Json, context: RunContext, call: ToolCall): Promise<Json>;
}

/**
 * A skill. `description` is what a harness reads in the ~30-token listing;
 * `body` is the full SKILL.md text it loads on demand, and it is copied to disk
 * verbatim — never rewritten per harness.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  /**
   * Companion files, keyed by path RELATIVE to the skill's own directory
   * (`references/format.md`), landing beside its SKILL.md on the `/host` mount — the
   * format already allows them, since Claude Code reads a skill directory whole.
   * Never listed and never loaded by `TurnSkills`: they are files, read with the
   * harness's own hands.
   */
  files?: Record<string, string>;
}

/**
 * One thing wrong with an app.
 *
 * `message` is a TEACHING sentence: it names what is wrong AND the real
 * alternative ("…the real fields are: …"), because its readers are a model
 * repairing the app and a person reading the refusal.
 *
 * `block` stops the app shipping as-is; `warn` rides along (the section-sized
 * failure, and every check that could not run).
 *
 * It lives HERE and not on the app-generation contract door because the harness
 * runtime speaks it: the validate gate is an injected slot on `HarnessAdapters`
 * and its failures carry findings, so a package below app generation has to be
 * able to name the shape (structure §0, L1).
 */
export interface Finding {
  severity: "block" | "warn";
  /** The locus: `document`, `node "n3" prop "rows"`, `query "invoices"`, or a
   *  check name when the finding is about the check itself. Optional — a check
   *  judging the whole app may honestly have no locus to name. */
  where?: string;
  message: string;
  /**
   * WHICH check produced this — its `Check.name`.
   *
   * Not the same thing as `where`, which is the locus inside the app and is a
   * check's own free text. Without this, a built-in fact finding and a host's own
   * plugged check were the same anonymous object, so architecture design §7's
   * carve-out — "except host-check failures, which only the host can waive via its
   * own policy config" — was not merely unimplemented but unrepresentable.
   *
   * The checking layer stamps it, and OVERRIDES whatever a check wrote here: a
   * check is untrusted code, and provenance it assigned to itself is a finding
   * attributing itself to a neighbour, which at a waive point is an escalation.
   * Optional only because a `Finding` is also authored by hand in places that never
   * pass through the layer.
   */
  check?: string;
}
