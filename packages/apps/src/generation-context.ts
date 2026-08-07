/**
 * What the generation pipeline is told about this host: the config slots a
 * build reads, and the live shape cards sampled off the host's own read tools.
 *
 * Lifted out of `createApps` unchanged.
 */
import { deriveShapeCard, type RunContext, type ShapeType, type ToolDescriptor } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { snapshotDesignRules, type GenerationDependencies } from "./engine.js";
import type { AppsConfig } from "./types.js";

/** Resolve a value-or-provider config slot. The provider (function) form is
 *  called ONCE here — generationDependencies runs once per create/edit — so
 *  theme/semantics match designRules' "re-read per generation" contract
 *  and a first-request cloud-backed provider never does I/O at compose time. */
export const resolveProvider = <T>(slot: T | (() => T | undefined) | undefined): T | undefined =>
  typeof slot === "function" ? (slot as () => T | undefined)() : slot;

export const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  toolContext: Pick<GenerationDependencies, "tools" | "toolShapes">,
): GenerationDependencies => {
  const theme = resolveProvider(config.theme);
  const semantics = resolveProvider(config.semantics);
  return snapshotDesignRules({
    model,
    catalog: config.catalog,
    ...(theme === undefined ? {} : { theme }),
    designRules: config.designRules,
    pinBaselines: config.pinBaselines,
    ...(semantics === undefined ? {} : { semantics }),
    ...toolContext,
    ...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
  });
};

export const createGenerationContext = (config: AppsConfig) => {
  // verify-v2 fixes / v2 spec §3 — shape cards from live samples: each read
  // tool is sampled once per runtime (empty input, the calling user's
  // authority — the same call the app's queries make); the derived shape
  // feeds the generation prompt and the compiler's binding type-check, and
  // the descriptor list gates query tool names. A failed sample leaves that
  // tool's shape unknown (defensive `json` per the spec).
  const sampledShapes = new Map<string, ShapeType>();
  const settledSamples = new Set<string>();
  // connect-required settles PER SUBJECT and PER TTL (review 2026-07-26): a
  // shape is host-level, but a missing account connection is one principal's
  // state — settling it globally would stop ever sampling the tool for a
  // DIFFERENT subject whose account is fine, and settling it forever would
  // never recover the shape after the SAME subject reconnects mid-boot (the
  // broker lists the toolkit as active both before and after, so the
  // connected set cannot signal the repair). Within the TTL the dead probe
  // stays quiet; after it, one probe per tool retries. Bounded like the
  // umbrella's toolkit cache.
  const CONNECT_SETTLE_TTL_MS = 10 * 60_000;
  const connectRequiredSettled = new Map<string, number>();
  const connectSettleKey = (subject: string, tool: string): string => `${subject} ${tool}`;
  const connectSettled = (subject: string, tool: string): boolean => {
    const at = connectRequiredSettled.get(connectSettleKey(subject, tool));
    return at !== undefined && Date.now() - at < CONNECT_SETTLE_TTL_MS;
  };
  const requiresInput = (descriptor: ToolDescriptor): boolean => {
    const required = (descriptor.inputSchema as { required?: unknown }).required;
    return Array.isArray(required) && required.length > 0;
  };
  const generationToolContext = async (
    ctx: RunContext,
  ): Promise<Pick<GenerationDependencies, "tools" | "toolShapes">> => {
    const descriptors = await config.tools.descriptors(ctx).catch(() => []);
    const candidates = descriptors.filter((descriptor) =>
      descriptor.risk === "read" && !requiresInput(descriptor) && !settledSamples.has(descriptor.name)
      && !connectSettled(ctx.principal.subject, descriptor.name));
    // Re-gate 2026-07-26 finding 2: a connector tool (descriptor.toolkit,
    // 01-core §4) is probed ONLY when its toolkit is connected for this
    // caller — an unconnected toolkit's probe can never yield a shape (the
    // account is missing), and on the gate hosts the ~50-tool probe burst
    // per create parked at the approval gate and tripped the call-rate
    // breaker under the create's own host reads. The connected set is
    // resolved lazily (only when a connector candidate exists) and degrades
    // to empty on failure or when the seam is not composed: probes skip,
    // the tools stay listed below.
    const connectorCandidates = candidates.filter((descriptor) => typeof descriptor.toolkit === "string");
    let connected: ReadonlySet<string> = new Set();
    if (connectorCandidates.length > 0 && config.connectedToolkits !== undefined) {
      connected = new Set(await config.connectedToolkits(ctx).catch(() => []));
    }
    await Promise.all(candidates
      .filter((descriptor) => typeof descriptor.toolkit !== "string" || connected.has(descriptor.toolkit))
      .map(async (descriptor) => {
        try {
          const outcome = await config.tools.execute(
            { id: `call_${globalThis.crypto.randomUUID()}`, tool: descriptor.name, args: {} },
            ctx,
          );
          if (outcome.status === "ok") {
            settledSamples.add(descriptor.name);
            sampledShapes.set(descriptor.name, deriveShapeCard(descriptor.name, [outcome.output]).output);
          } else if (outcome.status === "pending-approval" || outcome.status === "blocked") {
            // The policy gates this read: never re-ask on later creates (one
            // parked approval per boot at most), and leave the shape unknown.
            settledSamples.add(descriptor.name);
          } else if (outcome.status === "connect-required") {
            // The broker listed the toolkit as connected but the provider has
            // no account (expired/foreign): settle for THIS subject only (and
            // only for the TTL), so the dead probe stays quiet on their next
            // creates while a different, properly connected subject still gets
            // sampled and a mid-boot reconnect recovers after the TTL.
            if (connectRequiredSettled.size > 10_000) connectRequiredSettled.clear();
            connectRequiredSettled.set(connectSettleKey(ctx.principal.subject, descriptor.name), Date.now());
          }
          // Transient errors (e.g. an unauthenticated caller) retry on the
          // next create with that caller's own authority.
        } catch {
          // Unknown shape stays defensive; the tool is still listed by name.
        }
      }));
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
        // reads before it falls back to a sample (checking/deps.ts).
        ...(outputSchema === undefined ? {} : { outputSchema }),
      })),
      ...(sampledShapes.size === 0 ? {} : { toolShapes: Object.fromEntries(sampledShapes) }),
    };
  };

  return { generationToolContext };
};
