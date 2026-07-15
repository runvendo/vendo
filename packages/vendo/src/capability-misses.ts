import {
  canonicalJson,
  sha256Hex,
  type CapabilityMissEvent,
  type RiskLabel,
  type ToolDescriptor,
} from "@vendoai/core";
import { loadConfig, resolveConsent, type TelemetryConfig } from "@vendoai/telemetry";
import { cloudFetch } from "./cli/cloud/client.js";

const DEFAULT_DATA_DIR = ".vendo/data";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_QUEUE_LIMIT = 1_000;
const DEFAULT_BATCH_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;

export interface CapabilitySurfaceSnapshot {
  hash: string;
  tools: Array<{ name: string; risk: RiskLabel; disabled?: boolean }>;
}

interface AppendOptions {
  dataDir?: string;
}

type AppendMiss = (event: CapabilityMissEvent) => Promise<void>;

interface CaptureOptions {
  dataDir?: string;
  env?: Record<string, string | undefined>;
  telemetryHome?: string;
  telemetryConfig?: Pick<TelemetryConfig, "anonymousId" | "optedOut">;
  surface: Promise<CapabilitySurfaceSnapshot>;
  append?: AppendMiss;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  queueLimit?: number;
  batchDelayMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

interface MissUploader {
  enqueue(event: CapabilityMissEvent): void;
  flush(): Promise<void>;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function validUploadResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { accepted?: unknown; duplicates?: unknown };
  return Number.isInteger(response.accepted) && Number.isInteger(response.duplicates);
}

function createMissUploader(options: {
  apiKey: string;
  env: Record<string, string | undefined>;
  surface: Promise<CapabilitySurfaceSnapshot>;
  fetchImpl?: typeof fetch;
  batchSize: number;
  queueLimit: number;
  batchDelayMs: number;
  requestTimeoutMs: number;
  retryDelaysMs: readonly number[];
}): MissUploader {
  const queue: CapabilityMissEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;

  const send = async (events: CapabilityMissEvent[]): Promise<void> => {
    for (let attempt = 0; attempt <= options.retryDelaysMs.length; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
      unrefTimer(timeout);
      try {
        const surface = await options.surface;
        const response = await cloudFetch<{ accepted: number; duplicates: number }>("/api/v1/misses", {
          auth: "key",
          apiKey: options.apiKey,
          env: options.env,
          fetchImpl: options.fetchImpl,
          signal: controller.signal,
          body: { surface, events },
        });
        if (!validUploadResponse(response)) throw new Error("Invalid capability-miss upload response");
        return;
      } catch {
        const retryDelay = options.retryDelaysMs[attempt];
        if (retryDelay === undefined) return;
        await delay(retryDelay);
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, options.batchSize);
      await send(batch);
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (active) {
      await active;
      if (queue.length === 0) return;
    }
    active = drain().finally(() => {
      active = undefined;
    });
    await active;
  };

  const schedule = (): void => {
    if (timer !== undefined || active !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => undefined);
    }, options.batchDelayMs);
    unrefTimer(timer);
  };

  return {
    enqueue(event) {
      if (queue.length >= options.queueLimit) return;
      queue.push(event);
      if (queue.length >= options.batchSize) void flush().catch(() => undefined);
      else schedule();
    },
    flush,
  };
}

export function createCapabilityMissCapture(options: CaptureOptions): CapabilityMissCapture {
  const env = options.env ?? runtimeEnv();
  const telemetryConfig = options.telemetryConfig
    ?? loadConfig(options.telemetryHome, env);
  const apiKey = env.VENDO_API_KEY?.trim();
  let uploader: MissUploader | undefined;
  if (apiKey) {
    const consent = resolveConsent({ env, optedOut: telemetryConfig.optedOut, runtime: true });
    if (consent.allowed) {
      uploader = createMissUploader({
        apiKey,
        env,
        surface: options.surface,
        fetchImpl: options.fetchImpl,
        batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
        queueLimit: options.queueLimit ?? DEFAULT_QUEUE_LIMIT,
        batchDelayMs: options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
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
