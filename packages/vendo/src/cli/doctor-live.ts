import { spawn, type ChildProcess } from "node:child_process";
import {
  describeDevCredential,
  resolveDevCredential,
  type DevCredential,
  type ResolveDevCredentialOptions,
} from "../dev-creds/resolve.js";
import { isVendoKey } from "./cloud/client.js";
import { detectPackageManager } from "./shared.js";

/**
 * ENG-339 (install-dx design §5-6) — doctor's live surface: one real model
 * turn through the wired HTTP route, a local VENDO_API_KEY shape check with
 * what Cloud unlocks, and a consent-gated dev-server starter for the probe.
 * All seam-driven so doctor stays testable without live keys or a running
 * server.
 */

/* ------------------------------------------------------------------------ *
 * Live model turn — the same wired route the runtime serves.
 * ------------------------------------------------------------------------ */

export interface LiveTurnResult {
  attempted: boolean;
  ok: boolean;
  /** Which ladder rung the runtime resolved (doctor and runtime read the same
   *  resolver, so this is what the answering turn used). */
  rung: DevCredential["rung"];
  credential: string;
  reply?: string;
  error?: string;
  elapsedMs: number;
}

export interface LiveTurnOptions {
  /** Wire base, e.g. http://localhost:3000/api/vendo. */
  base: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Stream the reply to the terminal as it arrives. */
  onDelta?: (delta: string) => void;
  timeoutMs?: number;
  /** Test seam: skip the real resolver probe. */
  resolveCredential?: (options: ResolveDevCredentialOptions) => Promise<DevCredential>;
}

const DOCTOR_PROBE_PROMPT =
  "This is a Vendo doctor health check. Reply in one short sentence confirming you can respond.";

/** POST one seeded turn to the live wire and stream the reply — mirrors the
 *  init finale's route (`POST {base}/threads`, UI-message SSE frames). Exit 0
 *  means a user would have gotten an answer: a non-empty text reply arrived. */
export async function liveModelTurn(options: LiveTurnOptions): Promise<LiveTurnResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const resolve = options.resolveCredential ?? resolveDevCredential;
  const credential = await resolve({ env });
  const rung = credential.rung;
  const label = describeDevCredential(credential);
  const started = Date.now();
  const done = (partial: Omit<LiveTurnResult, "attempted" | "rung" | "credential" | "elapsedMs">): LiveTurnResult => ({
    attempted: true,
    rung,
    credential: label,
    elapsedMs: Date.now() - started,
    ...partial,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
  try {
    const response = await fetchImpl(`${options.base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        message: {
          id: `msg_doctor_${Date.now()}`,
          role: "user",
          parts: [{ type: "text", text: DOCTOR_PROBE_PROMPT }],
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      return done({ ok: false, error: `the wire returned ${response.status} with no stream` });
    }
    const reply = await readTurnStream(response.body, options.onDelta);
    if (reply.error !== undefined) return done({ ok: false, error: reply.error, reply: reply.text || undefined });
    if (reply.text.trim().length === 0) return done({ ok: false, error: "no reply text arrived" });
    return done({ ok: true, reply: reply.text });
  } catch (error) {
    const message = error instanceof Error
      ? (error.name === "AbortError" ? "the turn timed out" : error.message)
      : "unknown error";
    return done({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
}

async function readTurnStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: string) => void,
): Promise<{ text: string; error?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let error: string | undefined;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const frameEnd = buffer.indexOf("\n\n");
      if (frameEnd === -1) break;
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      if (!frame.startsWith("data: ") || frame === "data: [DONE]") continue;
      try {
        const part = JSON.parse(frame.slice("data: ".length)) as { type?: string; delta?: string };
        if (part.type === "text-delta" && typeof part.delta === "string") {
          text += part.delta;
          onDelta?.(part.delta);
        } else if (part.type === "error") {
          error = "the turn returned an error frame";
        }
      } catch {
        // skip malformed frame
      }
    }
  }
  return error === undefined ? { text } : { text, error };
}

/* ------------------------------------------------------------------------ *
 * VENDO_API_KEY local shape check + what Cloud unlocks.
 * ------------------------------------------------------------------------ */

/** Human-facing list of what a Cloud key unlocks over OSS single-player. Shown
 *  whether or not a key is present, so a keyless dev sees the offer. */
export const CLOUD_UNLOCKS: readonly string[] = [
  "a free dev-mode starter model allowance (keyless first turns)",
  "team sharing and org governance (roles, SSO)",
  "hosted deploys of your enabled automations",
  "registry publishing and hosted infrastructure defaults like the managed MCP broker",
];

export interface CloudDoctorResult {
  present: boolean;
  ok: boolean;
  unlocks: readonly string[];
  error?: string;
}

export interface CloudDoctorOptions {
  env?: Record<string, string | undefined>;
}

/** Check VENDO_API_KEY presence and shape locally; always surface what Cloud
 *  unlocks. Key problems surface on the first real service call — there is no
 *  validate endpoint. */
export async function cloudDoctor(options: CloudDoctorOptions = {}): Promise<CloudDoctorResult> {
  const env = options.env ?? process.env;
  const key = env["VENDO_API_KEY"];
  if (key === undefined || key.trim().length === 0) {
    return { present: false, ok: false, unlocks: CLOUD_UNLOCKS };
  }
  if (!isVendoKey(key)) {
    return { present: true, ok: false, unlocks: CLOUD_UNLOCKS, error: "VENDO_API_KEY is malformed (expected vnd_ + 40 hex chars)" };
  }
  return { present: true, ok: true, unlocks: CLOUD_UNLOCKS };
}

/* ------------------------------------------------------------------------ *
 * Consent-gated dev-server starter for the probe.
 * ------------------------------------------------------------------------ */

export interface StartedDevServer {
  ok: boolean;
  stop: () => void;
  log: string[];
}

export interface StartDevServerOptions {
  root: string;
  /** Wire base whose /status decides "up". */
  statusUrl: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  spawnDev?: (packageManager: string, root: string) => ChildProcess;
}

function defaultSpawnDev(packageManager: string, root: string): ChildProcess {
  return spawn(packageManager, ["run", "dev"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForStatus(statusUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${statusUrl}/status`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

/** Spawn `run dev` and wait for the wire to answer. Caller stop()s it. */
export async function startDevServerForProbe(options: StartDevServerOptions): Promise<StartedDevServer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const packageManager = await detectPackageManager(options.root);
  const child = (options.spawnDev ?? defaultSpawnDev)(packageManager, options.root);
  const log: string[] = [];
  const record = (data: Buffer): void => {
    log.push(data.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  // A spawn failure (e.g. lockfile-derived package manager missing from PATH →
  // ENOENT) emits 'error'; without a listener that crashes the whole process.
  // Record it and short-circuit the status wait so the caller degrades to the
  // "could not start" warning instead.
  let failSpawn: () => void = () => {};
  const spawnFailed = new Promise<false>((resolve) => { failSpawn = () => resolve(false); });
  child.on("error", (error: Error) => {
    log.push(`spawn error: ${error.message}\n`);
    failSpawn();
  });
  const stop = (): void => { child.kill("SIGTERM"); };
  const up = await Promise.race([
    waitForStatus(options.statusUrl, fetchImpl, options.timeoutMs ?? 120_000),
    spawnFailed,
  ]);
  if (!up) stop();
  return { ok: up, stop, log };
}
