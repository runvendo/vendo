import {
  canonicalJson,
  sha256Hex,
  type CapabilityMissEvent,
  type RiskLabel,
  type ToolDescriptor,
} from "@vendoai/core";
import { envOptOut, loadConfig, type TelemetryConfig } from "@vendoai/telemetry";
import { createBatchedUploader, type BatchedUploader } from "./batched-uploader.js";

const DEFAULT_DATA_DIR = ".vendo/data";
/** The hostId stamped on misses that stay on this machine. `CapabilityMissEvent`
 *  requires the field, but a local-only log correlates nothing across hosts, so
 *  there is no identity to mint. */
const LOCAL_ONLY_IDENTITY = { anonymousId: "local", optedOut: true } as const;

export interface CapabilitySurfaceSnapshot {
  hash: string;
  tools: Array<{ name: string; risk: RiskLabel }>;
}

interface AppendOptions {
  dataDir?: string;
}

type AppendMiss = (event: CapabilityMissEvent) => Promise<void>;

interface CaptureOptions {
  dataDir?: string;
  /** Telemetry-config + opt-out inputs ONLY (loadConfig/envOptOut); this
   *  module never reads VENDO_API_KEY or VENDO_CONSOLE_URL from it. */
  env?: Record<string, string | undefined>;
  telemetryHome?: string;
  telemetryConfig?: Pick<TelemetryConfig, "anonymousId" | "optedOut">;
  /** ADAPTER RULE, miss-upload slot: filled by the composition seam
   *  (createVendo passes cloudKeyOptions() — see server.ts). Unset means
   *  local capture only; the module itself never reads the environment for
   *  the key or the console base URL. */
  cloud?: { apiKey: string; baseUrl?: string };
  /** #557 — a LAZY, memoized factory rather than an eager promise: resolving the
   *  surface calls the actions registry's `descriptors()` → `loadHost`, which now
   *  awaits the cloud overrides fetch. Deferring it keeps that fetch out of
   *  Workers global scope (the composition seam memoizes the factory so
   *  descriptors runs at most once). Awaited only when a miss is actually
   *  uploaded. */
  surface: () => Promise<CapabilitySurfaceSnapshot>;
  append?: AppendMiss;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  queueLimit?: number;
  batchDelayMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export interface CapabilityMissCapture {
  /** Stable host-installation identity, shared with telemetry by contract. */
  hostId: string;
  record(event: CapabilityMissEvent): void;
  /** Drain hook for tests and orderly host shutdown; agent turns never await it. */
  flush(): Promise<void>;
}

function runtimeEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

function nodeFs(): typeof import("node:fs") {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
  if (!fs) throw new Error("Capability-miss local persistence requires the Node filesystem");
  return fs;
}

export async function appendCapabilityMiss(
  event: CapabilityMissEvent,
  options: AppendOptions = {},
): Promise<void> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const fs = nodeFs();
  await fs.promises.mkdir(dataDir, { recursive: true });
  // appendFile opens with O_APPEND. Each event is serialized into one write so
  // concurrent processes cannot race a read/modify/write cycle.
  await fs.promises.appendFile(
    `${dataDir.replace(/[\\/]$/, "")}/misses.jsonl`,
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", flag: "a" },
  );
}

export function capabilitySurfaceSnapshot(descriptors: ToolDescriptor[]): CapabilitySurfaceSnapshot {
  const tools = descriptors
    .map(({ name, risk }) => ({ name, risk }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const canonical = canonicalJson({ format: "vendo/tools@1", tools });
  return { hash: `sha256:${sha256Hex(canonical)}`, tools };
}

function validUploadResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { accepted?: unknown; duplicates?: unknown };
  return Number.isInteger(response.accepted) && Number.isInteger(response.duplicates);
}

export function createCapabilityMissCapture(options: CaptureOptions): CapabilityMissCapture {
  const env = options.env ?? runtimeEnv();
  // Only the upload stream needs a STABLE installation identity, and it exists
  // only when the host filled the Cloud slot and no kill switch is tripped.
  // `loadConfig` MINTS AND PERSISTS an opted-in id into ~/.vendo/telemetry.json,
  // and this capture is composed on every createVendo boot — so reaching it
  // unconditionally leaves a tracking id on the disk of every host that never
  // enabled telemetry and can never upload. Local-only capture writes to the
  // project's own .vendo/data, where a cross-boot identity means nothing.
  const uploads = options.cloud !== undefined && !envOptOut(env);
  const telemetryConfig = options.telemetryConfig
    ?? (uploads ? loadConfig(options.telemetryHome, env) : LOCAL_ONLY_IDENTITY);
  let uploader: BatchedUploader<CapabilityMissEvent> | undefined;
  if (options.cloud !== undefined) {
    // Contract (01-core §17): upload is gated by the key plus envOptOut only.
    // The persisted telemetry opt-out and the NODE_ENV fail-close are
    // product-telemetry-only; a filled Cloud slot (the seam saw a non-empty
    // VENDO_API_KEY) is the host's opt-in.
    if (!envOptOut(env)) {
      uploader = createBatchedUploader<CapabilityMissEvent>({
        path: "/api/v1/misses",
        cloud: options.cloud,
        // #557 — resolved per attempt, inside the loop, so the lazy surface
        // factory is awaited only when a miss is actually uploaded.
        body: async (events) => ({ surface: await options.surface(), events }),
        accept: validUploadResponse,
        fetchImpl: options.fetchImpl,
        batchSize: options.batchSize,
        queueLimit: options.queueLimit,
        batchDelayMs: options.batchDelayMs,
        requestTimeoutMs: options.requestTimeoutMs,
        retryDelaysMs: options.retryDelaysMs,
      });
    }
  }

  const append = options.append
    ?? ((event: CapabilityMissEvent) => appendCapabilityMiss(event, { dataDir: options.dataDir }));
  const pendingLocal = new Set<Promise<void>>();

  return {
    hostId: telemetryConfig.anonymousId,
    record(event) {
      const local = Promise.resolve()
        .then(() => append(event))
        .catch(() => undefined)
        .finally(() => pendingLocal.delete(local));
      pendingLocal.add(local);
      uploader?.enqueue(event);
    },
    async flush() {
      while (pendingLocal.size > 0) await Promise.all([...pendingLocal]);
      await uploader?.flush();
    },
  };
}
