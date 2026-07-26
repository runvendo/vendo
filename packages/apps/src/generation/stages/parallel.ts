/**
 * Outline + region-parallel tier-2 — strict outline, N parallel section
 * writers over the shared prefix, deterministic assembly, whole-app validate.
 * Any planning/assembly failure returns fallback info and the engine's
 * single-stream lane takes over — never blocks.
 */
import { compileWireV2 } from "@vendoai/core";
import type { GeneratedAppDocument, PipelineContext } from "../engine.js";
import { strictToolCall, structuredRepair } from "./repair.js";
import { wireCompileOptionsFor } from "../wire-options.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface OutlineSection {
  id: string;
  brief: string;
  tools: string[];
}

interface Outline {
  appName: string;
  sharedFacts: string;
  sections: OutlineSection[];
}

const MAX_SECTIONS = 4;

const outlineSchema = (toolNames: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["appName", "sharedFacts", "sections"],
  properties: {
    appName: { type: "string", description: "The app's display title — at most 40 characters, human and specific, never the user's request echoed back." },
    sharedFacts: {
      type: "string",
      description: "Shared data/state facts every section must agree on (which queries feed what, shared filters, units). Empty string when none.",
    },
    sections: {
      type: "array",
      description: `2 to ${MAX_SECTIONS} independent screen regions, top to bottom. Merge deeply coupled pieces (a picker filtering another view) into ONE section — a section is generated in isolation.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "brief", "tools", "coupledWithPrevious"],
        properties: {
          id: { type: "string", description: "Short lowercase identifier, e.g. s1_summary." },
          brief: { type: "string", description: "What this region shows and does." },
          tools: {
            type: "array",
            description: "The host tools feeding this section.",
            items: { type: "string", enum: toolNames },
          },
          coupledWithPrevious: {
            type: "boolean",
            description: "True when this region shares live state with the previous one and must be generated together with it.",
          },
        },
      },
    },
  },
});

const planOutline = async (
  userRequest: string,
  context: PipelineContext,
): Promise<Outline | undefined> => {
  const { deps } = context;
  const toolNames = (deps.tools ?? []).map((tool) => tool.name);
  if (toolNames.length === 0) return undefined;
  const input = await strictToolCall(
    deps,
    "plan_outline",
    "Plan the app as independent screen regions before parallel generation.",
    outlineSchema(toolNames),
    "You plan Vendo app generations. Split the requested app into independent regions that can be generated in parallel; keep coupled pieces in one region.",
    `USER_REQUEST: ${userRequest}\nHOST TOOLS:\n${(deps.tools ?? []).map(({ name, description, risk }) => `- ${name} [${risk}]: ${description}`).join("\n")}`,
  );
  deps.onTiming?.({ lane: "outline", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
  if (input === undefined || typeof input.appName !== "string" || !Array.isArray(input.sections)) return undefined;
  const known = new Set(toolNames);
  const sections: OutlineSection[] = [];
  for (const raw of input.sections) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.brief !== "string") return undefined;
    const tools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && known.has(tool)) : [];
    const id = raw.id.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_").replaceAll(/^_+|_+$/g, "") || `s${sections.length + 1}`;
    if (raw.coupledWithPrevious === true && sections.length > 0) {
      const previous = sections[sections.length - 1] as OutlineSection;
      previous.brief = `${previous.brief}\nAND, coupled in the same region: ${raw.brief}`;
      previous.tools = [...new Set([...previous.tools, ...tools])];
    } else {
      sections.push({ id, brief: raw.brief, tools });
    }
  }
  if (sections.length < 2 || sections.length > MAX_SECTIONS) return undefined;
  const ids = new Set(sections.map((section) => section.id));
  if (ids.size !== sections.length) return undefined;
  return {
    appName: input.appName,
    sharedFacts: typeof input.sharedFacts === "string" ? input.sharedFacts : "",
    sections,
  };
};

/** The section's inner markup: everything between the App open tag and its
 *  close (islands included — they are top-level siblings inside App). */
const innerAppMarkup = (text: string): string | undefined => {
  const start = text.indexOf("<App");
  if (start === -1) return undefined;
  const open = text.indexOf(">", start);
  if (open === -1) return undefined;
  const close = text.lastIndexOf("</App>");
  const inner = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
  return inner.trim() === "" ? undefined : inner;
};

export interface RegionParallelResult {
  document?: GeneratedAppDocument;
  /** Why the parallel path yielded no document (measurement + fallback). */
  fallback?: "no-outline" | "sections-failed" | "assembly-invalid";
  sectionsPlanned?: number;
  sectionsLanded?: number;
}

export interface RegionParallelHooks {
  /** The engine's streamWire, bound to deps/system: returns raw wire text. */
  generateSection: (prompt: string) => Promise<string | undefined>;
  /** Forwarded partial emission (already resident-suppressed by the engine). */
  emitPartial?: (assembledWire: string) => void;
  userRequest: string;
}

/** Outline then N parallel per-section writers whose outputs assemble (in
 *  outline order) into one wire document that goes through the normal
 *  whole-app validation. Any planning/assembly failure returns fallback info
 *  and the engine's single-stream lane takes over — never blocks. */
export const regionParallelCreate = async (
  context: PipelineContext,
  hooks: RegionParallelHooks,
): Promise<RegionParallelResult> => {
  const parallelStart = Date.now();
  const finish = (result: RegionParallelResult): RegionParallelResult => {
    context.deps.onPipeline?.({
      stage: "region-parallel",
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      ...(result.sectionsPlanned === undefined ? {} : { sectionsPlanned: result.sectionsPlanned }),
      ...(result.sectionsLanded === undefined ? {} : { sectionsLanded: result.sectionsLanded }),
      ms: Date.now() - parallelStart,
    });
    return result;
  };
  const outline = await planOutline(hooks.userRequest, context);
  if (outline === undefined) return finish({ fallback: "no-outline" });
  const appName = outline.appName.replaceAll('"', "'");
  const sectionPrompt = (section: OutlineSection, index: number): string => [
    `TASK: CREATE_APP\nUSER_REQUEST: ${hooks.userRequest}`,
    `OUTLINE_SECTION ${section.id} (${index + 1} of ${outline.sections.length}): ${section.brief}`,
    `- Emit ONE complete <App name="${appName}"> containing ONLY this section's queries and markup — the other sections are generated separately and composed around yours in order.`,
    section.tools.length === 0
      ? "- This section uses NO host tools; render honest static/empty-state content only."
      : `- Use ONLY these host tools: ${section.tools.join(", ")}.`,
    `- Prefix every <Query id> with "${section.id}_" so query names never collide with other sections.`,
    `- Do NOT repeat content that belongs to other sections.`,
    outline.sharedFacts.trim() === "" ? "" : `SHARED FACTS (every section must agree): ${outline.sharedFacts}`,
  ].filter((line) => line !== "").join("\n");

  const landed: Array<string | undefined> = outline.sections.map(() => undefined);
  const assemble = (): string => `<App name="${appName}">${landed.filter((part): part is string => part !== undefined).join("\n")}</App>`;
  await Promise.all(outline.sections.map(async (section, index) => {
    const text = await hooks.generateSection(sectionPrompt(section, index));
    if (text === undefined) return;
    const inner = innerAppMarkup(text);
    if (inner === undefined) return;
    landed[index] = inner;
    // (streamWire already emits the lane:"section" complete timing event.)
    hooks.emitPartial?.(assemble());
  }));
  const landedCount = landed.filter((part) => part !== undefined).length;
  // EVERY planned section must land — assembling a subset would silently ship
  // an app missing a region the user asked for. The single-stream fallback
  // still produces the complete app, so falling back here never blocks and
  // never drops content.
  if (landedCount !== outline.sections.length) {
    return finish({ fallback: "sections-failed", sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
  }
  // The sections are RAW model wire (inline tool references included), so the
  // assembly compiles with the exact options the streaming lanes use — the
  // bare options here made every inline-reference app fail region-parallel
  // with "unknown-reference" (live 2026-07-23).
  const compiled = compileWireV2(assemble(), wireCompileOptionsFor(context.deps, context.hostComponents));
  const validated = await context.validate(compiled);
  if (validated.document !== undefined) {
    return finish({ document: validated.document, sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
  }
  if (context.deps.pipeline?.structuredRepair !== false) {
    const repaired = await structuredRepair(compiled, hooks.userRequest, context);
    if (repaired.document !== undefined) {
      return finish({ document: repaired.document, sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
    }
  }
  // demo-latency lane — an assembly whose ONLY failures are island-scoped
  // (the observed live class: one fabricating island) is rescued by rewriting
  // just those islands instead of abandoning ~90s of landed sections for a
  // full single-stream re-generation.
  if (context.repairIslands !== undefined) {
    const islandRepaired = await context.repairIslands(compiled, validated.issues);
    if (islandRepaired.document !== undefined) {
      return finish({ document: islandRepaired.document, sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
    }
  }
  return finish({ fallback: "assembly-invalid", sectionsPlanned: outline.sections.length, sectionsLanded: landedCount });
};
