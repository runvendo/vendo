import { VendoError, type Json } from "@vendoai/core";
import type { SandboxMachine } from "./sandbox.js";

/**
 * execution-v2 Wave 3 — the host-side client of the in-box agent's control
 * port. The agent + supervisor live inside the base box template
 * (packages/apps/box/harness.mjs); this module is the host's transport to it,
 * spoken over the ONE data path into the box, SandboxMachine.request({port}).
 * The app owns $PORT; the harness owns the CONTROL PORT below.
 *
 * Prompt-injection floor: everything the box returns is DATA. A BoxEditResult
 * never carries host authority — it cannot approve egress, grant a secret, or
 * mutate a host document. Graduation reads the summary and fn list; approvals
 * still gate every host mutation (Lane E), and durable writes still ride the
 * app-token /box callbacks through the guard.
 */

/** The harness's control port (VENDO_CONTROL_PORT in the box); distinct from
 *  the app's $PORT so the app and the agent door never collide. */
export const BOX_CONTROL_PORT = 8811;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TASK_TIMEOUT_MS = 8 * 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The structured result the in-box agent reports (box → host, pure data). */
export interface BoxEditResult {
  ok: boolean;
  summary: string;
  filesChanged: string[];
  testsRun: number;
  /** The POST /fn/<name> functions the box now serves (agent-declared). */
  fns?: string[];
}

/** A minimal sleep seam so tests drive the poll loop without real time. */
export interface BoxAgentClock {
  sleep(ms: number): Promise<void>;
  now(): number;
}

const realClock: BoxAgentClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface BoxEditOptions {
  prompt: string;
  context?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  clock?: BoxAgentClock;
}

const controlRequest = async (
  machine: SandboxMachine,
  method: string,
  path: string,
  body?: Json,
): Promise<{ status: number; json: unknown }> => {
  const answer = await machine.request({
    method,
    path,
    port: BOX_CONTROL_PORT,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: encoder.encode(JSON.stringify(body)),
    }),
  });
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(answer.body));
  } catch {
    json = undefined;
  }
  return { status: answer.status, json };
};

const asResult = (value: unknown): BoxEditResult => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    ok: record.ok === true,
    summary: typeof record.summary === "string" ? record.summary : "(box returned no summary)",
    filesChanged: Array.isArray(record.filesChanged)
      ? record.filesChanged.filter((entry): entry is string => typeof entry === "string")
      : [],
    testsRun: typeof record.testsRun === "number" && Number.isInteger(record.testsRun) && record.testsRun >= 0
      ? record.testsRun
      : 0,
    ...(Array.isArray(record.fns)
      ? { fns: record.fns.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
};

/**
 * Proxy an APP-port request, retrying the provider's 502/503 "port not open"
 * for a short window. A memory-snapshot resume boots the box's start command
 * fresh, so the supervised app needs a second or two to rebind $PORT; an fn
 * call or manifest read that races that startup would otherwise fail. Control-
 * port requests never use this — the harness is up the moment the box is.
 */
export interface BootRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const requestAppWithBootRetry = async (
  machine: SandboxMachine,
  req: Parameters<SandboxMachine["request"]>[0],
  options: BootRetryOptions = {},
): Promise<Awaited<ReturnType<SandboxMachine["request"]>>> => {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1_500;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let answer = await machine.request(req);
  for (let attempt = 1; attempt < attempts && (answer.status === 502 || answer.status === 503); attempt += 1) {
    await sleep(delayMs);
    answer = await machine.request(req);
  }
  return answer;
};

/**
 * Re-inject the boundary env into a live box and restart its app. This is the
 * in-box restart loop Lane E's env-baked-at-provision gap needs: a secret
 * grant flipped while the machine slept lands here at the next edit/wake.
 */
export const pushBoxEnv = async (machine: SandboxMachine, env: Record<string, string>): Promise<void> => {
  const { status } = await controlRequest(machine, "POST", "/agent/env", { env });
  if (status < 200 || status >= 300) {
    throw new VendoError("sandbox-unavailable", `box env injection failed (${status})`);
  }
};

/** Read the box's `vendo.json` manifest verbatim (empty when the box has none).
 *  Uses the post-resume boot retry: a manifest read right after an edit can
 *  race the harness restarting the app, and a dropped read would silently lose
 *  a freshly declared egress domain (and its approval card). */
export const readBoxManifest = async (
  machine: SandboxMachine,
  bootRetry: BootRetryOptions = {},
): Promise<string | undefined> => {
  const answer = await requestAppWithBootRetry(machine, { method: "GET", path: "/vendo.json" }, bootRetry);
  if (answer.status === 404) return undefined;
  if (answer.status < 200 || answer.status >= 300) {
    throw new VendoError("validation", `vendo.json read failed (${answer.status})`);
  }
  return decoder.decode(answer.body);
};

/**
 * Send one edit prompt to the in-box agent and long-poll to completion. The
 * agent writes code, installs deps, runs its own server, curls its endpoints,
 * and reports a structured result — self-verification against reality. A
 * timeout is a failed edit (the caller rolls back), never a throw into the
 * tree.
 */
export const runBoxEdit = async (
  machine: SandboxMachine,
  options: BoxEditOptions,
): Promise<BoxEditResult> => {
  const clock = options.clock ?? realClock;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const started = await controlRequest(machine, "POST", "/agent/task", {
    prompt: options.prompt,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  if (started.status !== 202 || typeof (started.json as { taskId?: unknown })?.taskId !== "string") {
    return {
      ok: false,
      summary: `box refused the edit task (${started.status})`,
      filesChanged: [],
      testsRun: 0,
    };
  }
  const taskId = (started.json as { taskId: string }).taskId;
  const deadline = clock.now() + timeoutMs;
  while (clock.now() < deadline) {
    await clock.sleep(pollIntervalMs);
    const polled = await controlRequest(machine, "GET", `/agent/task/${taskId}`);
    const payload = polled.json as { status?: unknown; result?: unknown } | undefined;
    if (polled.status === 200 && payload?.status === "done") {
      return asResult(payload.result);
    }
  }
  return {
    ok: false,
    summary: `box edit timed out after ${Math.round(timeoutMs / 1000)}s`,
    filesChanged: [],
    testsRun: 0,
  };
};
