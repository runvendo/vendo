/**
 * The pack boot merge (build contract §5): resolve every configured pack and
 * fold its four slots into the registries that already exist — tools into the
 * one tool registry, skills into the workspace mount, checks onto the floor,
 * components into the catalog.
 *
 * Two laws live here and nowhere else:
 *
 * - **No renaming, ever.** A name is global as authored. A pack's skill body
 *   says `check_report`, and projecting a skill is a copy rather than a
 *   translation, so a prefixed tool name would point the model at a tool that
 *   does not exist.
 * - **Boot-collision IS the namespacing.** Two packs claiming one name is an
 *   error at boot that names both of them, so the conflict is fixed by whoever
 *   configured them rather than papered over at runtime.
 */
import {
  TOOL_NAME_PATTERN,
  VendoError,
  componentPath,
  skillFilePath,
  type Check,
  type ComponentRegistry,
  type Pack,
  type PackProvider,
  type PackSkill,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import { backingRegistry } from "./from-registry.js";

/**
 * What the apps pack is allowed to reach on the apps runtime: its tool registry,
 * and nothing else.
 *
 * Narrow on purpose. The runtime's full surface includes `delete`, `publish`, and
 * the pin machinery, and the pack law is "no reaching into other packs" — our own
 * boot context must not be the way around it. A pack gets the handle its tools
 * need, so a later pack cannot quietly grow a reach nobody reviewed.
 */
export type AppsPackHandle = Pick<AppsRuntime, "agentTools">;

/**
 * What a pack receives when its tools need a platform handle.
 *
 * Deliberately small: one member, the only handle a wave-1 pack actually needs,
 * and it grows by demand rather than by anticipation. Triggers and scheduling
 * are NOT here — they are platform lifecycle, not pack content (architecture
 * §5), so a pack contributes *over* that lifecycle and never arms it.
 */
export interface PackContext {
  /**
   * The apps runtime handle the app-generation tools act through.
   *
   * A thunk, not a value: the merge runs early in composition (its components
   * feed the catalog and its checks feed the floor, both of which the apps
   * runtime is built with), so the runtime does not exist yet. It always does by
   * the time a tool runs, because a tool only runs inside a request. This is the
   * same closure the arming seam uses for the automations engine.
   */
  apps: () => AppsPackHandle;
}

export interface MergedPacks {
  /** Every pack tool as one registry, ready for `actions.add(...)` — so pack
   *  tools are guarded, audited, and projected identically to host tools. */
  tools: ToolRegistry;
  skills: PackSkill[];
  checks: Check[];
  components: ComponentRegistry;
  /** The configured pack names, in order — what a boot diagnostic reports. */
  names: string[];
  /** Which pack declared each tool name, so a collision with the host's own
   *  tools can be reported naming the pack rather than "added registry". */
  toolOwners: ReadonlyMap<string, string>;
}

/**
 * Every slot name has to be a safe identifier, because names are used as
 * addresses: a skill name is a PATH SEGMENT (`/host/skills/<name>/SKILL.md`) that
 * a model later asks for by name, and check and component names key registries.
 * No dots, no slashes, no whitespace — so nothing can be spelled as a traversal.
 * Same shape as the frozen tool-name pattern, deliberately.
 */
const SAFE_SLOT_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const requireSafeName = (slot: string, name: string, pack: string): void => {
  if (!SAFE_SLOT_NAME.test(name)) {
    throw new VendoError(
      "validation",
      `pack "${pack}" declares the ${slot} name ${JSON.stringify(name)}, which is not a legal ${slot} name. A ${slot} name addresses something (a skill is a path segment, and a model asks for it by name), so it may only use letters, digits, "_" and "-", up to 64 characters.`,
    );
  }
};

/**
 * The `/host` projection's own grammars, run at boot. {@link SAFE_SLOT_NAME} is
 * deliberately loose (it is the shape of a name a model asks for), but two slots
 * are narrower where the path is built: a component name is also an element in an
 * app's markup, and a skill's companion path must stay inside the skill's
 * directory. Those checks live in core, per TURN — a pack component named
 * "Data-Table" passes the slot name here, boots green, and throws on every turn
 * afterwards. Calling core's builders rather than restating their patterns is what
 * keeps the two ends from disagreeing again.
 */
const requireProjectable = (subject: string, pack: string, project: () => unknown): void => {
  try {
    project();
  } catch (cause) {
    throw new VendoError(
      "validation",
      `pack "${pack}" declares ${subject}, which cannot be projected onto the read-only /host mount: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

/**
 * A check has to be able to do its job.
 *
 * A judgment rule is appended verbatim to the REVIEWER's system prompt, so a
 * missing one would put the line "- undefined" into a safety-relevant prompt and
 * spend a model call asking it to enforce nothing. A fact check with no `run` is
 * a check that silently never fires. Both are boot errors, for the same reason
 * every other slot is validated here.
 */
const requireUsableCheck = (check: Check, pack: string): void => {
  if (check.kind === "judgment") {
    if (typeof check.rule !== "string" || check.rule.trim() === "") {
      throw new VendoError(
        "validation",
        `pack "${pack}" declares the judgment check "${check.name}" with no rule. A judgment check IS its rule — one sentence, appended to the reviewer's rubric — so it needs a non-empty \`rule\`.`,
      );
    }
    return;
  }
  if (typeof check.run !== "function") {
    throw new VendoError(
      "validation",
      `pack "${pack}" declares the check "${check.name}" with no \`run\` function. A fact check is code the floor runs; without it the check would silently never fire (add \`kind: "judgment"\` and a \`rule\` if it was meant to be a rule).`,
    );
  }
};

/** Claim a name in one slot's namespace, validating it on the way in. The slots
 *  are separate namespaces: one pack may call a tool and a skill the same thing. */
const claimer = (slot: string): ((name: string, pack: string) => void) => {
  const owners = new Map<string, string>();
  return (name: string, pack: string): void => {
    requireSafeName(slot, name, pack);
    const owner = owners.get(name);
    if (owner === pack) {
      throw new VendoError(
        "validation",
        `pack "${pack}" declares the ${slot} name "${name}" twice. Declare it once.`,
      );
    }
    if (owner !== undefined) {
      throw new VendoError(
        "validation",
        `two packs claim the ${slot} name "${name}": "${owner}" and "${pack}". Names are global as authored — nothing is auto-prefixed — so rename it in one of them, or configure only one of the packs.`,
      );
    }
    owners.set(name, pack);
  };
};

const descriptorOf = ({ execute: _execute, ...descriptor }: ToolDefinition): ToolDescriptor => descriptor;

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: error instanceof VendoError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown pack tool error" },
});

/**
 * The pack tools as one registry.
 *
 * A pack tool returns its output or throws; the denial outcomes
 * (`pending-approval`, `blocked`, `connect-required`) belong to the guard that
 * wraps this registry, so a pack author cannot author one and cannot forget the
 * safety story.
 */
const registryOf = (definitions: ReadonlyMap<string, ToolDefinition>): ToolRegistry => ({
  async descriptors() {
    // Cloned: these descriptors came from a pack's own module-level value and go
    // to callers that are free to mutate what they are handed. The shipped
    // registries clone for the same reason.
    return structuredClone([...definitions.values()].map(descriptorOf));
  },
  async execute(call, ctx): Promise<ToolOutcome> {
    const definition = definitions.get(call.tool);
    if (definition === undefined) {
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    }
    // A tool that IS a registry answers for itself, outcome and error code
    // verbatim. Re-deriving an outcome from a thrown error would flatten every
    // code to "validation" and turn a denial into a failure, and both of those
    // reach the model and the audit row.
    const backing = backingRegistry(definition);
    if (backing !== undefined) {
      try {
        return await backing().execute(call, ctx);
      } catch (error) {
        return errorOutcome(error);
      }
    }
    try {
      return { status: "ok", output: await definition.execute(call.args, ctx, call) };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});

const resolve = <Context>(provider: PackProvider<Context>, context: Context): Pack =>
  (typeof provider === "function" ? provider(context) : provider);

export const mergePacks = (
  providers: readonly PackProvider<PackContext>[],
  context: PackContext,
): MergedPacks => {
  const packNames = new Set<string>();
  const claimTool = claimer("tool");
  const claimSkill = claimer("skill");
  const claimCheck = claimer("check");
  const claimComponent = claimer("component");

  const tools = new Map<string, ToolDefinition>();
  const toolOwners = new Map<string, string>();
  const skills: PackSkill[] = [];
  const checks: Check[] = [];
  const components: ComponentRegistry = {};
  const names: string[] = [];

  for (const provider of providers) {
    const pack = resolve(provider, context);
    if (packNames.has(pack.name)) {
      throw new VendoError("validation", `two configured packs are both named "${pack.name}"; configure one of them.`);
    }
    packNames.add(pack.name);
    names.push(pack.name);

    for (const tool of pack.tools ?? []) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new VendoError(
          "validation",
          `pack "${pack.name}" declares the tool name "${tool.name}", which is not a legal tool name (letters, digits, "_" and "-", up to 64 characters).`,
        );
      }
      claimTool(tool.name, pack.name);
      tools.set(tool.name, tool);
      toolOwners.set(tool.name, pack.name);
    }
    for (const skill of pack.skills ?? []) {
      claimSkill(skill.name, pack.name);
      for (const file of Object.keys(skill.files ?? {})) {
        requireProjectable(
          `the companion file ${JSON.stringify(file)} of its "${skill.name}" skill`,
          pack.name,
          () => skillFilePath(skill.name, file),
        );
      }
      skills.push(skill);
    }
    for (const check of pack.checks ?? []) {
      claimCheck(check.name, pack.name);
      requireUsableCheck(check, pack.name);
      checks.push(check);
    }
    for (const [name, entry] of Object.entries(pack.components ?? {})) {
      requireProjectable(`the component name ${JSON.stringify(name)}`, pack.name, () => componentPath(name));
      claimComponent(name, pack.name);
      components[name] = entry;
    }
  }

  return { tools: registryOf(tools), skills, checks, components, names, toolOwners };
};
