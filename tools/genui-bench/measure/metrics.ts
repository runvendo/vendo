/**
 * Island-escape measurement — the per-app shape numbers a RunRecord already
 * carries, pulled into one flat row so a sweep can be summarized and two
 * sweeps compared.
 *
 * The defect class this measures: the engine answering an ask by dumping the
 * whole app as raw TSX inside ONE island instead of composing Kit/host
 * components over declarative queries. Its fingerprints are all here — island
 * source dominating the wire, islands with zero queries, and islands reaching
 * host tools imperatively while the tree declares none.
 *
 * Pure over a loaded RunRecord (store.loadRun): no model calls, no I/O.
 */
import type { HostName, LaneResult, RunRecord } from "../runner/types";

export interface AppMeasurement {
  runId: string;
  createdAt: string;
  host: HostName;
  pack?: string;
  prompt: string;
  status: LaneResult["status"];
  durationMs: number;
  error?: string;

  /** Total wire characters (island source included — it is inline `<Island>`). */
  wireChars: number;
  /** Characters of generated-component source across every island. */
  islandSourceChars: number;
  /** islandSourceChars / wireChars — 0.93 was the live escape. */
  islandRatio: number;
  islandCount: number;
  /** Declared queries; inline tool references compile into these too. */
  queryCount: number;
  nodeCount: number;

  /** Host tools islands reach imperatively (compiler-stamped componentTools). */
  islandToolReads: string[];
  islandToolWrites: string[];

  /** islandCount > 0 && queryCount === 0. */
  zeroQueryIsland: boolean;
  /** The strong escape signal: an island proves data exists by calling a tool,
   *  yet the tree declares no query — the format was bypassed, not unavailable. */
  islandReadsWithoutQueries: boolean;
  /** The legitimate data-free utility shape: island, no queries, no tool use. */
  dataFreeUtility: boolean;
  /** A MUTATING tool reached from island source — flagged for a HUMAN read
   *  (intent is not automatable): does the tool's job match the app's ask? */
  mutatingIslandTools: boolean;
}

const okResult = (record: RunRecord): Extract<LaneResult, { status: "ok" }> | undefined => {
  const lane = record.lanes.vendo;
  return lane?.status === "ok" ? lane : undefined;
};

/** One flat row per RunRecord's vendo lane. `writeTools` is the host's set of
 *  mutating tool names (fixtures carry `risk`). */
export function measureRecord(
  record: RunRecord,
  writeTools: Partial<Record<HostName, ReadonlySet<string>>> = {},
): AppMeasurement {
  const lane = record.lanes.vendo;
  const ok = okResult(record);
  const document = ok?.document;
  // AppDocument.tree is intentionally loose at the artifact boundary; the two
  // fields this reads are guaranteed by the tree format.
  const tree = document?.tree as { nodes?: unknown[]; queries?: unknown[] } | undefined;
  const components = document?.components ?? {};
  const componentTools = (document as { componentTools?: Record<string, string[]> } | undefined)?.componentTools ?? {};

  const wireChars = ok?.wire?.length ?? 0;
  const islandSourceChars = Object.values(components).reduce((total, source) => total + source.length, 0);
  const islandCount = Object.keys(components).length;
  const queryCount = tree?.queries?.length ?? 0;

  const hostWrites = writeTools[record.request.host] ?? new Set<string>();
  const reachedTools = [...new Set(Object.values(componentTools).flat())].sort();
  const islandToolWrites = reachedTools.filter((tool) => hostWrites.has(tool));
  const islandToolReads = reachedTools.filter((tool) => !hostWrites.has(tool));

  return {
    runId: record.id,
    createdAt: record.createdAt,
    host: record.request.host,
    ...(record.request.packRef ? { pack: record.request.packRef.pack } : {}),
    prompt: record.request.prompt,
    status: lane?.status ?? "failed",
    durationMs: lane?.status === "no-key" ? 0 : (lane?.durationMs ?? 0),
    ...(lane?.status === "failed" ? { error: lane.error } : {}),

    wireChars,
    islandSourceChars,
    islandRatio: wireChars === 0 ? 0 : islandSourceChars / wireChars,
    islandCount,
    queryCount,
    nodeCount: tree?.nodes?.length ?? 0,

    islandToolReads,
    islandToolWrites,

    zeroQueryIsland: islandCount > 0 && queryCount === 0,
    islandReadsWithoutQueries: islandCount > 0 && queryCount === 0 && reachedTools.length > 0,
    dataFreeUtility: islandCount > 0 && queryCount === 0 && reachedTools.length === 0,
    mutatingIslandTools: islandToolWrites.length > 0,
  };
}

export interface Summary {
  label: string;
  apps: number;
  ok: number;
  failed: number;
  failureRate: number;
  durationMsP50: number;
  durationMsP90: number;
  /** Share of OK apps in each bucket. */
  withIslands: number;
  islandRatioP50: number;
  islandRatioP90: number;
  islandRatioOver: Record<"0.4" | "0.5" | "0.6" | "0.8", number>;
  zeroQueryIsland: number;
  islandReadsWithoutQueries: number;
  dataFreeUtility: number;
  mutatingIslandTools: number;
  islandRatioHistogram: Record<string, number>;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
};

const RATIO_BUCKETS = ["0", "(0,0.2]", "(0.2,0.4]", "(0.4,0.6]", "(0.6,0.8]", "(0.8,1]"] as const;

const bucketOf = (ratio: number): string => {
  if (ratio === 0) return "0";
  if (ratio <= 0.2) return "(0,0.2]";
  if (ratio <= 0.4) return "(0.2,0.4]";
  if (ratio <= 0.6) return "(0.4,0.6]";
  if (ratio <= 0.8) return "(0.6,0.8]";
  return "(0.8,1]";
};

export function summarize(label: string, rows: readonly AppMeasurement[]): Summary {
  const ok = rows.filter((row) => row.status === "ok");
  const count = (predicate: (row: AppMeasurement) => boolean) => ok.filter(predicate).length;
  const histogram: Record<string, number> = Object.fromEntries(RATIO_BUCKETS.map((bucket) => [bucket, 0]));
  for (const row of ok) histogram[bucketOf(row.islandRatio)] = (histogram[bucketOf(row.islandRatio)] ?? 0) + 1;
  const ratios = ok.map((row) => row.islandRatio);
  return {
    label,
    apps: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    failureRate: rows.length === 0 ? 0 : (rows.length - ok.length) / rows.length,
    durationMsP50: percentile(rows.map((row) => row.durationMs), 50),
    durationMsP90: percentile(rows.map((row) => row.durationMs), 90),
    withIslands: count((row) => row.islandCount > 0),
    islandRatioP50: percentile(ratios, 50),
    islandRatioP90: percentile(ratios, 90),
    islandRatioOver: {
      "0.4": count((row) => row.islandRatio > 0.4),
      "0.5": count((row) => row.islandRatio > 0.5),
      "0.6": count((row) => row.islandRatio > 0.6),
      "0.8": count((row) => row.islandRatio > 0.8),
    },
    zeroQueryIsland: count((row) => row.zeroQueryIsland),
    islandReadsWithoutQueries: count((row) => row.islandReadsWithoutQueries),
    dataFreeUtility: count((row) => row.dataFreeUtility),
    mutatingIslandTools: count((row) => row.mutatingIslandTools),
    islandRatioHistogram: histogram,
  };
}
