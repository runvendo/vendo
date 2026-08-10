/**
 * What the generation pipeline is told about this host: the config slots a
 * build reads, and the response shape every tool DECLARES.
 *
 * Lifted out of `createApps` unchanged.
 */
import { shapeFromJsonSchema, type RunContext, type ShapeType } from "@vendoai/core";
import type { LanguageModel } from "ai";
import type { GenerationDependencies } from "../generation/engine.js";
import type { AppsConfig } from "./types.js";

/** Resolve a value-or-provider config slot. The provider (function) form is
 *  called ONCE here — generationDependencies runs once per create/edit — so a
 *  slot matches the "re-read per generation" contract and a first-request
 *  cloud-backed provider never does I/O at compose time. */
export const resolveProvider = <T>(slot: T | (() => T | undefined) | undefined): T | undefined =>
  typeof slot === "function" ? (slot as () => T | undefined)() : slot;

export const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  toolContext: Pick<GenerationDependencies, "tools" | "toolShapes">,
): GenerationDependencies => {
  const semantics = resolveProvider(config.semantics);
  return {
    model,
    catalog: config.catalog,
    seedBaselines: config.seedBaselines,
    ...(semantics === undefined ? {} : { semantics }),
    ...toolContext,
    ...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
  };
};

export const createGenerationContext = (config: AppsConfig) => {
  // The generation surface: the tool catalog and, for every tool that declares
  // one, its response shape. Purely declarative — nothing calls the host. The
  // create-time probe that used to live here sampled each read tool once per
  // runtime, which cost a call burst per create, erased every enum it touched,
  // and could not see a tool that needs arguments at all.
  const generationToolContext = async (
    ctx: RunContext,
  ): Promise<Pick<GenerationDependencies, "tools" | "toolShapes">> => {
    const descriptors = await config.tools.descriptors(ctx).catch(() => []);
    // The host's own DECLARED response schema is the shape.
    const shapes = new Map<string, ShapeType>();
    for (const descriptor of descriptors) {
      if (descriptor.outputSchema !== undefined) {
        shapes.set(descriptor.name, shapeFromJsonSchema(descriptor.outputSchema));
      }
    }
    return {
      tools: descriptors.map(({ name, description, risk, inputSchema, outputSchema }) => ({
        name,
        description,
        risk,
        // W4 pipeline — the structured-repair payload skeleton derives from
        // the tool's input schema (mutation-without-payload fixes).
        ...(typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)
          ? { inputSchema: inputSchema as Record<string, unknown> }
          : {}),
        // The host's own declared response shape — what the screen type check
        // reads (checking/deps.ts).
        ...(outputSchema === undefined ? {} : { outputSchema }),
      })),
      ...(shapes.size === 0 ? {} : { toolShapes: Object.fromEntries(shapes) }),
    };
  };

  return { generationToolContext };
};
