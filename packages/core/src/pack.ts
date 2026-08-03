/**
 * The pack contract (build contract §5): capability arrives as a plain value
 * contributing to four slots that already exist — tools → the one registry,
 * skills → the workspace mount, checks → the checking floor, components → the
 * catalog. Nothing else extends Vendo.
 *
 * Type-only, and here in core, so every block may speak these shapes without
 * reaching sideways (build contract §2). The implementations live where the
 * slots do: `definePack` and the boot merge in the umbrella, the floor in
 * `@vendoai/apps`, the skills store next door in `./skills.ts`.
 */
import type { ComponentRegistry } from "./catalog.js";
import type { AppDocument } from "./app-document.js";
import type { AppPlan } from "./genui/plan/types.js";
import type { Json } from "./ids.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolDescriptor } from "./tools.js";

/**
 * A tool a pack contributes: the frozen neutral {@link ToolDescriptor} the whole
 * system already speaks, plus the one thing a descriptor lacks — how to run it.
 *
 * Execution is always on our side, and the guard wraps it identically to every
 * other tool, so a pack author writes only the work: return the output, or
 * throw. The denial outcomes (`pending-approval`, `blocked`,
 * `connect-required`) are the guard's to author; a pack tool never fakes one.
 */
export interface ToolDefinition extends ToolDescriptor {
  /**
   * @param input the call's arguments — what almost every tool needs.
   * @param context the run context: whose authority this call carries.
   * @param call the whole call. Present for the one class of tool that reads
   *   something riding on the call itself rather than on its arguments — the
   *   app-create view-stream bridge (`VENDO_VIEW_STREAM`) is the only one — and
   *   for re-expressing an existing `ToolRegistry` as pack tools without
   *   dropping that rider. Ignore it otherwise.
   */
  execute(input: Json, context: RunContext, call: ToolCall): Promise<Json>;
}

/**
 * A skill a pack contributes. `description` is what a harness reads in the
 * ~30-token listing; `body` is the full SKILL.md text it loads on demand, and
 * it is copied to disk verbatim — never rewritten per harness.
 */
export interface PackSkill {
  name: string;
  description: string;
  body: string;
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
 */
export interface Finding {
  severity: "block" | "warn";
  /** The locus: `document`, `node "n3" prop "rows"`, `query "invoices"`, or a
   *  check name when the finding is about the check itself. Optional — a check
   *  judging the whole app may honestly have no locus to name. */
  where?: string;
  message: string;
}

export interface CheckInput {
  document: AppDocument;
  /** The user's own words — what the app was asked to be. */
  request: string;
  /** The plan the app was built from, when the check runs mid-pipeline; absent
   *  for checks over a finished document. */
  plan?: AppPlan;
}

/**
 * A check on the floor. Two kinds, and the difference is who decides:
 *
 * - `fact` — decidable by looking things up, so it is plain code the floor runs.
 * - `judgment` — a rule only a reader can apply, so it is one sentence that
 *   joins the reviewer's rubric as its own line.
 *
 * `kind` is OPTIONAL on the fact variant and absence means `"fact"`: checks
 * predate this field, and the floor is a safety floor. Anything that is not
 * explicitly a judgment rule is code we run — a check that silently stops
 * firing is the worst failure this contract could allow.
 */
export type Check =
  | { name: string; kind?: "fact"; run(input: CheckInput): Promise<Finding[]> }
  | { name: string; kind: "judgment"; rule: string };

export interface Pack {
  name: string;
  tools?: ToolDefinition[];
  skills?: PackSkill[];
  checks?: Check[];
  /** Today's catalog vocabulary, unchanged: the server ignores `component`,
   *  the client mounts it. A pack module is imported twice — once server-side
   *  for the other three slots, once client-side for this one — so it must be
   *  import-safe on the server. */
  components?: ComponentRegistry;
}

/**
 * What a host puts in `createVendo({ packs })`.
 *
 * A pack that needs nothing from us is the plain value. A pack whose tools need
 * a platform handle (the apps runtime, the automations engine) is authored as a
 * plain function of the boot context that returns that value — exactly how a
 * harness needing host dependencies is authored (build contract §1). There is
 * no third shape, and no privileged path: `apps()` and `automations()` are
 * functions of this same context, and so is anyone else's pack.
 */
export type PackProvider<Context = unknown> = Pack | ((context: Context) => Pack);
