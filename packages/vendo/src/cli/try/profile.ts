import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyJudgment,
  catalogFileSchema,
  judgmentsFileSchema,
  overridesFileSchema,
  toolsFileSchema,
  type ToolOverride,
} from "@vendoai/actions";
import { riskLabelSchema, vendoThemeSchema } from "@vendoai/core";
import { z } from "zod";

/**
 * The TryProfile (unified try surface, Task 1). ONE aggregate JSON assembled
 * from a repo's `.vendo/` artifact directory — the single boot document both
 * try venues render from: the local `npx vendo try` server and the hosted
 * twin on vendo.run. Later pieces (the local HTTP server, the SSE deepening
 * stream, the hosted venue) consume this exact shape, so the schema here IS
 * the contract; the assembler is just plumbing over it.
 *
 * Assembly is fail-soft end to end: every missing or unparseable artifact
 * degrades to its empty value (null/[]/false) and `assembleTryProfile` NEVER
 * throws — a half-extracted repo still gets a valid (shallow) profile.
 * Overrides are corrections over tools.json exactly the way doctor and the
 * running server treat them: a per-tool override's risk/description/disabled
 * replace the extracted values, and a malformed overrides.json is ignored
 * whole (its own pre-existing failure surface, never this profile's).
 *
 * Depth rule (kept deliberately simple): the two AI deepening artifacts are
 * the brief and the usecases chips, both counted by CONTENT — an empty
 * brief.md and a usecases file with zero chips deepen nothing. Neither
 * present → "shallow" (this is also the pure-deterministic report: tools
 * alone never deepen anything); exactly one present → "deepening" (a
 * deepening run is partway through); both present → "deep". `stages`
 * defaults to done/pending from artifact PRESENCE (an empty-but-parsed
 * artifact is still a completed stage); only the live server knows in-flight
 * status, so caller-supplied statuses win per stage.
 */

/** The future producer (the seeds extraction pass) imports these schemas and
 *  format literals from HERE — never a second copy of the `@1` strings. */
export const VENDO_USECASES_FORMAT = "vendo/usecases@1" as const;
export const VENDO_FIXTURES_FORMAT = "vendo/fixtures@1" as const;

/** One suggestion chip of the try surface: label on the chip, prompt it sends. */
export const usecaseSchema = z.object({
  label: z.string().min(1),
  prompt: z.string().min(1),
}).passthrough();

export type Usecase = z.infer<typeof usecaseSchema>;

/** `.vendo/data/extract/usecases.json` — AI-authored, versioned like the
 *  other generated artifacts. Passthrough: generated files evolve additively. */
export const usecasesFileSchema = z.object({
  format: z.literal(VENDO_USECASES_FORMAT),
  usecases: z.array(usecaseSchema),
}).passthrough();

export type UsecasesFile = z.infer<typeof usecasesFileSchema>;

/** `.vendo/data/extract/fixtures.json` — synthetic demo rows keyed by tool
 *  name. The profile only reports availability; the try server reads the rows. */
export const fixturesFileSchema = z.object({
  format: z.literal(VENDO_FIXTURES_FORMAT),
  fixtures: z.record(z.array(z.unknown())),
}).passthrough();

export type FixturesFile = z.infer<typeof fixturesFileSchema>;

/** One tool as the try surface presents it: the extracted descriptor with the
 *  host's overrides.json corrections already applied. */
export const tryToolSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  risk: riskLabelSchema,
  disabled: z.boolean(),
});

export type TryToolSummary = z.infer<typeof tryToolSummarySchema>;

export const tryDepthLevelSchema = z.enum(["shallow", "deepening", "deep"]);

export type TryDepthLevel = z.infer<typeof tryDepthLevelSchema>;

export const tryStageStatusSchema = z.enum(["pending", "done", "failed", "skipped"]);

export type TryStageStatus = z.infer<typeof tryStageStatusSchema>;

export const tryProfileSchema = z.object({
  venue: z.enum(["local", "hosted"]),
  brand: z.object({
    name: z.string().nullable(),
    domain: z.string().nullable(),
    logoUrl: z.string().nullable(),
  }),
  theme: vendoThemeSchema.nullable(),
  brief: z.string().nullable(),
  tools: z.object({
    list: z.array(tryToolSummarySchema),
    counts: z.object({ total: z.number().int().min(0), enabled: z.number().int().min(0) }),
  }),
  catalog: z.array(z.string()),
  usecases: z.array(usecaseSchema),
  fixturesAvailable: z.boolean(),
  depth: z.object({
    level: tryDepthLevelSchema,
    stages: z.record(tryStageStatusSchema),
  }),
  capabilities: z.object({ liveChat: z.boolean() }),
});

export type TryProfile = z.infer<typeof tryProfileSchema>;

export interface AssembleTryProfileOptions {
  /** Which venue is serving this profile. Default "local". */
  venue?: TryProfile["venue"];
  /** Brand facts only the caller knows (hosted venue metadata). Unset slots stay null. */
  brand?: Partial<TryProfile["brand"]>;
  /** What the serving venue can actually do. Unset slots stay false. */
  capabilities?: Partial<TryProfile["capabilities"]>;
  /** Live stage statuses (the deepening stream's in-flight view); each entry
   *  wins over the disk-derived done/pending default for that stage. */
  stages?: Record<string, TryStageStatus>;
}

/** Fail-soft read: absent file, unreadable file — all null, never a throw. */
async function readArtifact(root: string, ...segments: string[]): Promise<string | null> {
  try {
    return await readFile(join(root, ".vendo", ...segments), "utf8");
  } catch {
    return null;
  }
}

/** Fail-soft parse: JSON.parse + schema in one guard, null on any failure. */
function parseArtifact<Schema extends z.ZodTypeAny>(
  raw: string | null,
  schema: Schema,
): z.infer<Schema> | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** House three-layer semantics (doctor's live-surface check, the server's tool
 *  wire): skeleton ⊕ judgments ⊕ overrides, by name. `applyJudgment` ignores an
 *  entry whose binding moved and applies the fail-closed audience exclusion;
 *  the human's overrides.json still corrects last. Queued `pending` loosenings
 *  are NOT merged — they are inert until a human accepts them. */
function mergedToolSummaries(
  tools: z.infer<typeof toolsFileSchema> | null,
  judgments: z.infer<typeof judgmentsFileSchema> | null,
  overrides: z.infer<typeof overridesFileSchema> | null,
): TryToolSummary[] {
  const corrections: Record<string, ToolOverride> = overrides?.tools ?? {};
  return (tools?.tools ?? []).map((tool) => {
    const judged = applyJudgment(tool, judgments?.tools[tool.name]);
    const correction = corrections[tool.name];
    return {
      name: judged.name,
      description: correction?.description ?? judged.description,
      risk: correction?.risk ?? judged.risk,
      disabled: (correction?.disabled ?? judged.disabled ?? false) === true,
    };
  });
}

/**
 * Assemble the TryProfile for the repo at `root` from its `.vendo/` directory.
 * Every artifact degrades independently (see the contract block above); the
 * result always satisfies `tryProfileSchema`.
 */
export async function assembleTryProfile(
  root: string,
  options: AssembleTryProfileOptions = {},
): Promise<TryProfile> {
  const [themeRaw, briefRaw, toolsRaw, judgmentsRaw, overridesRaw, catalogRaw, usecasesRaw, fixturesRaw] = await Promise.all([
    readArtifact(root, "theme.json"),
    readArtifact(root, "brief.md"),
    readArtifact(root, "tools.json"),
    readArtifact(root, "judgments.json"),
    readArtifact(root, "overrides.json"),
    readArtifact(root, "catalog.json"),
    readArtifact(root, "data", "extract", "usecases.json"),
    readArtifact(root, "data", "extract", "fixtures.json"),
  ]);

  const theme = parseArtifact(themeRaw, vendoThemeSchema);
  const brief = briefRaw === null || briefRaw.trim() === "" ? null : briefRaw.trim();
  const toolsFile = parseArtifact(toolsRaw, toolsFileSchema);
  const list = mergedToolSummaries(
    toolsFile,
    parseArtifact(judgmentsRaw, judgmentsFileSchema),
    parseArtifact(overridesRaw, overridesFileSchema),
  );
  const catalog = (parseArtifact(catalogRaw, catalogFileSchema)?.entries ?? []).map((entry) => entry.name);
  const usecasesFile = parseArtifact(usecasesRaw, usecasesFileSchema);
  // Whole parsed entries: usecaseSchema is passthrough, so additive fields a
  // future producer emits survive into the profile instead of being dropped.
  const usecases = usecasesFile?.usecases ?? [];
  const fixturesAvailable = parseArtifact(fixturesRaw, fixturesFileSchema) !== null;

  const deepened = [brief !== null, usecases.length > 0].filter(Boolean).length;
  const level: TryDepthLevel = deepened === 2 ? "deep" : deepened === 1 ? "deepening" : "shallow";

  const done = (present: boolean): TryStageStatus => (present ? "done" : "pending");
  const stages: Record<string, TryStageStatus> = {
    tools: done(toolsFile !== null),
    theme: done(theme !== null),
    brief: done(brief !== null),
    usecases: done(usecasesFile !== null),
    fixtures: done(fixturesAvailable),
    ...options.stages,
  };

  return {
    venue: options.venue ?? "local",
    brand: {
      name: options.brand?.name ?? null,
      domain: options.brand?.domain ?? null,
      logoUrl: options.brand?.logoUrl ?? null,
    },
    theme,
    brief,
    tools: {
      list,
      counts: {
        total: list.length,
        enabled: list.filter((tool) => !tool.disabled).length,
      },
    },
    catalog,
    usecases,
    fixturesAvailable,
    depth: { level, stages },
    capabilities: { liveChat: options.capabilities?.liveChat ?? false },
  };
}
