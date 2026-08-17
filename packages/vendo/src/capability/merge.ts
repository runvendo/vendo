/**
 * The composition merge: every contributor's tools and skills folded into the
 * registries that already exist — tools into the one tool registry, skills into
 * the workspace mount.
 *
 * There is no wrapper type around a contribution. App generation, automations
 * and the host's own `createVendo({ tools, skills })` all arrive here as the
 * same two lists, labelled with WHERE they came from, and the label exists for
 * exactly one reason: the collision message has to name both claimants.
 *
 * Two laws live here and nowhere else:
 *
 * - **No renaming, ever.** A name is global as authored. A skill body says
 *   `check_report`, and projecting a skill is a copy rather than a translation,
 *   so a prefixed tool name would point the model at a tool that does not exist.
 * - **Boot-collision IS the namespacing.** Two contributors claiming one name is
 *   an error at boot that names both of them, so the conflict is fixed by
 *   whoever configured them rather than papered over at runtime.
 */
import {
  TOOL_NAME_PATTERN,
  isVendoError,
  VendoError,
  skillFilePath,
  type Skill,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { backingRegistry } from "./from-registry.js";

/**
 * One source of capability, as composition sees it.
 *
 * `from` is a LABEL, not an identity: it names the contributor in a collision
 * message ("apps", `createVendo({ tools })`) and does nothing else. Nothing is
 * keyed by it, nothing is looked up by it, and two contributions may not share
 * one — that would make a collision message ambiguous.
 */
export interface Contribution {
  from: string;
  tools?: readonly ToolDefinition[];
  skills?: readonly Skill[];
}

export interface MergedCapability {
  /** Every contributed tool as one registry, ready for `actions.add(...)` — so
   *  they are guarded, audited, and projected identically to host tools. */
  tools: ToolRegistry;
  skills: Skill[];
  /** Which contributor declared each tool name, so a collision with the host's
   *  own extracted tools can be reported naming it rather than "added registry". */
  toolOwners: ReadonlyMap<string, string>;
}

/**
 * A skill name has to be a safe identifier, because it is used as an address: it
 * is a PATH SEGMENT (`/host/skills/<name>/SKILL.md`) that a model later asks for
 * by name. No dots, no slashes, no whitespace — so nothing can be spelled as a
 * traversal. Same shape as the frozen tool-name pattern, deliberately.
 */
const SAFE_SKILL_SLOT_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Claim a name in one slot's namespace. The slots are separate namespaces: one
 *  contributor may call a tool and a skill the same thing. */
const claimer = (slot: string): ((name: string, from: string) => void) => {
  const owners = new Map<string, string>();
  return (name: string, from: string): void => {
    const owner = owners.get(name);
    if (owner === from) {
      throw new VendoError(
        "validation",
        `${from} declares the ${slot} name "${name}" twice. Declare it once.`,
      );
    }
    if (owner !== undefined) {
      throw new VendoError(
        "validation",
        `two contributors claim the ${slot} name "${name}": ${owner} and ${from}. Names are global as authored — nothing is auto-prefixed — so rename it in one of them.`,
      );
    }
    owners.set(name, from);
  };
};

/**
 * A skill's companion paths must stay inside the skill's own directory. The
 * check lives in core (`skillFilePath` builds the path), per TURN — calling
 * core's builder rather than restating its pattern is what keeps the two ends
 * from disagreeing.
 */
const requireProjectable = (subject: string, from: string, project: () => unknown): void => {
  try {
    project();
  } catch (cause) {
    throw new VendoError(
      "validation",
      `${from} declares ${subject}, which cannot be projected onto the read-only /host mount: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

const descriptorOf = ({ execute: _execute, ...descriptor }: ToolDefinition): ToolDescriptor => descriptor;

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: isVendoError(error)
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown tool error" },
});

/**
 * The contributed tools as one registry.
 *
 * A tool definition returns its output or throws; the denial outcomes
 * (`pending-approval`, `blocked`, `connect-required`) belong to the guard that
 * wraps this registry, so an author cannot author one and cannot forget the
 * safety story.
 */
const registryOf = (definitions: ReadonlyMap<string, ToolDefinition>): ToolRegistry => ({
  async descriptors() {
    // Cloned: these descriptors came from a contributor's own module-level value
    // and go to callers that are free to mutate what they are handed. The shipped
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

export const mergeCapability = (contributions: readonly Contribution[]): MergedCapability => {
  const labels = new Set<string>();
  const claimTool = claimer("tool");
  const claimSkill = claimer("skill");

  const tools = new Map<string, ToolDefinition>();
  const toolOwners = new Map<string, string>();
  const skills: Skill[] = [];

  for (const { from, tools: contributed, skills: contributedSkills } of contributions) {
    if (labels.has(from)) {
      throw new VendoError("validation", `two contributions are both labelled "${from}"; a label names one contributor.`);
    }
    labels.add(from);

    for (const tool of contributed ?? []) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new VendoError(
          "validation",
          `${from} declares the tool name "${tool.name}", which is not a legal tool name (letters, digits, "_" and "-", up to 64 characters).`,
        );
      }
      claimTool(tool.name, from);
      tools.set(tool.name, tool);
      toolOwners.set(tool.name, from);
    }
    for (const skill of contributedSkills ?? []) {
      if (!SAFE_SKILL_SLOT_NAME.test(skill.name)) {
        throw new VendoError(
          "validation",
          `${from} declares the skill name ${JSON.stringify(skill.name)}, which is not a legal skill name. A skill name addresses something (it is a path segment, and a model asks for it by name), so it may only use letters, digits, "_" and "-", up to 64 characters.`,
        );
      }
      claimSkill(skill.name, from);
      for (const file of Object.keys(skill.files ?? {})) {
        requireProjectable(
          `the companion file ${JSON.stringify(file)} of its "${skill.name}" skill`,
          from,
          () => skillFilePath(skill.name, file),
        );
      }
      skills.push(skill);
    }
  }

  return { tools: registryOf(tools), skills, toolOwners };
};
