/**
 * execution-v2 Wave 3 — the box bootstrap supervisor + agent harness (factory).
 *
 * This module (plus agent-sdk.mjs) IS the "agent lives in the box" half of the
 * base box template: the supervisor/control-port process is zero-dependency;
 * the agent engine underneath it is the Claude Agent SDK, baked into the
 * template beside it (Wave 8). `createHarness()` builds it without side
 * effects (so it is unit-testable); `bootstrap.mjs` is the thin entrypoint
 * that starts it. It owns two jobs:
 *
 *   1. Supervise the app process. The app is whatever the in-box agent wrote
 *      under /app; its Procfile-style entry is ONE shell line in
 *      `/app/.vendo/run`, spawned with the boundary env (env.json) merged in
 *      and restarted on exit, on entry change, on env re-injection, and after
 *      every completed agent task. The app owns $PORT; this process never
 *      binds it.
 *
 *   2. Serve the CONTROL PORT (default 8811, VENDO_CONTROL_PORT) — the host's
 *      door to the in-box agent, spoken via SandboxMachine.request({port}):
 *        GET  /agent/health            → {ok, app:{running}}
 *        POST /agent/env {env}         → persist boundary env + restart app
 *        POST /agent/task {prompt, context?} → 202 {taskId} (one at a time)
 *        GET  /agent/task/<id>         → {status, result?, log}
 *        POST /agent/restart-app       → restart the supervised app (the
 *                                        agent curls this after edits)
 *
 * Security posture (documented, matches the fn door on $PORT): the provider
 * exposes sandbox ports on an unguessable per-machine hostname; the control
 * port carries no bearer of its own in v2. The box holds no host authority —
 * host mutations still ride the app-token /box callbacks through the guard.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { runAgentTask as defaultRunAgentTask } from "./agent-sdk.mjs";

const RESPAWN_DELAY_MS = 1_000;
const RUN_WATCH_INTERVAL_MS = 2_000;
const LOG_TAIL_BYTES = 4_096;

/**
 * @param {object} [options]
 * @param {string} [options.appDir]        the app directory (default /app)
 * @param {number} [options.controlPort]   control-port listen port (default 8811)
 * @param {Function} [options.runAgentTask] injectable agent engine (tests)
 * @param {NodeJS.ProcessEnv} [options.baseEnv] base env for the app process (default process.env)
 */
export const createHarness = (options = {}) => {
  const appDir = options.appDir ?? process.env.VENDO_APP_DIR ?? "/app";
  const controlPort = options.controlPort ?? Number(process.env.VENDO_CONTROL_PORT ?? 8811);
  const runAgentTask = options.runAgentTask ?? defaultRunAgentTask;
  const baseEnv = options.baseEnv ?? process.env;

  const vendoDir = path.join(appDir, ".vendo");
  const runFile = path.join(vendoDir, "run");
  const envFile = path.join(vendoDir, "env.json");
  mkdirSync(vendoDir, { recursive: true });

  /** Boundary env: base (provision-time) env plus re-injected env.json (which
   *  wins — grant flips land there). */
  const boundaryEnv = () => {
    let injected = {};
    try {
      injected = JSON.parse(readFileSync(envFile, "utf8"));
    } catch {
      // No env.json yet (fresh template) or unreadable — base env stands.
    }
    const merged = { ...baseEnv };
    for (const [key, value] of Object.entries(injected)) {
      if (typeof value === "string") merged[key] = value;
    }
    return merged;
  };

  // ─── app supervisor ─────────────────────────────────────────────────────
  let appChild = null;
  let appGeneration = 0;
  let runWatchTimer;

  const readRunEntry = () => {
    try {
      const entry = readFileSync(runFile, "utf8").trim();
      return entry === "" ? null : entry;
    } catch {
      return null;
    }
  };

  const stopApp = async () => {
    const child = appChild;
    appChild = null;
    if (child === null || child.exitCode !== null) return;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await gone.catch(() => undefined);
  };

  const startApp = () => {
    const entry = readRunEntry();
    if (entry === null) return;
    const generation = ++appGeneration;
    // Plain `bash -c`, NEVER a login shell: a Procfile entry is one shell
    // line whose env is the boundary env below. Sourcing the machine's shell
    // profiles (-l) leaked host profile env into the app and made spawn
    // latency track the profile's cost — the Wave-6 load-40 test flake.
    const child = spawn("bash", ["-c", entry], {
      cwd: appDir,
      env: boundaryEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    appChild = child;
    child.on("error", () => undefined);
    child.on("exit", () => {
      // Respawn only the current generation: a restart already replaced us.
      if (appGeneration !== generation || appChild !== child) return;
      appChild = null;
      setTimeout(() => {
        if (appGeneration === generation) startApp();
      }, RESPAWN_DELAY_MS);
    });
  };

  const restartApp = async () => {
    appGeneration += 1; // retire any pending respawn timer
    await stopApp();
    startApp();
  };

  // ─── agent tasks ──────────────────────────────────────────────────────────
  let activeTask = null;
  const tasks = new Map();

  const logPath = (taskId) => path.join(vendoDir, `agent-${taskId}.log`);
  const logTail = (taskId) => {
    try {
      const text = readFileSync(logPath(taskId), "utf8");
      return text.length <= LOG_TAIL_BYTES ? text : text.slice(text.length - LOG_TAIL_BYTES);
    } catch {
      return "";
    }
  };

  const startTask = (prompt, context) => {
    const taskId = `boxtask_${randomUUID()}`;
    const entry = { status: "running", result: undefined };
    tasks.set(taskId, entry);
    activeTask = taskId;
    const log = (line) => {
      try {
        // ISO-stamped so a live agent log doubles as a build-phase profile
        // (Wave 7 H2 — where do the 4.5 layer-3 minutes go).
        appendFileSync(logPath(taskId), `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Logging must never kill the task.
      }
    };
    entry.promise = (async () => {
      let result;
      try {
        result = await runAgentTask({ prompt, context, env: boundaryEnv(), appDir, log });
      } catch (error) {
        result = {
          ok: false,
          summary: `agent harness failed: ${error instanceof Error ? error.message : String(error)}`,
          filesChanged: [],
          testsRun: 0,
        };
      }
      entry.status = "done";
      entry.result = result;
      try {
        writeFileSync(path.join(vendoDir, `agent-${taskId}.json`), JSON.stringify(result, null, 2));
      } catch {
        // Best-effort durability; the in-memory result is what the host polls.
      }
      activeTask = null;
      // New code (and possibly a new run entry) should serve immediately.
      await restartApp().catch(() => undefined);
      return result;
    })();
    return taskId;
  };

  // ─── control server ─────────────────────────────────────────────────────
  const readBody = (request) => new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

  const sendJson = (response, status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const handle = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://box.internal");
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /agent/health") {
      sendJson(response, 200, {
        ok: true,
        harness: "vendo-box/1",
        app: { running: appChild !== null && appChild.exitCode === null },
      });
      return;
    }
    if (route === "POST /agent/env") {
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: "body must be JSON" });
        return;
      }
      const env = payload?.env;
      if (typeof env !== "object" || env === null || Array.isArray(env)
        || Object.values(env).some((value) => typeof value !== "string")) {
        sendJson(response, 400, { error: "env must be an object of strings" });
        return;
      }
      writeFileSync(envFile, JSON.stringify(env, null, 2));
      await restartApp();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === "POST /agent/task") {
      if (activeTask !== null) {
        sendJson(response, 409, { error: "an agent task is already running", taskId: activeTask });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: "body must be JSON" });
        return;
      }
      if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
        sendJson(response, 400, { error: "prompt must be a non-empty string" });
        return;
      }
      const taskId = startTask(payload.prompt, typeof payload.context === "string" ? payload.context : undefined);
      sendJson(response, 202, { taskId });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/agent/task/")) {
      const taskId = url.pathname.slice("/agent/task/".length);
      const entry = tasks.get(taskId);
      if (entry === undefined) {
        sendJson(response, 404, { error: `unknown task: ${taskId}` });
        return;
      }
      sendJson(response, 200, {
        status: entry.status,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        log: logTail(taskId),
      });
      return;
    }
    if (route === "POST /agent/restart-app") {
      await restartApp();
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: `unknown route: ${route}` });
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      try {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "internal harness error" });
      } catch {
        response.destroy();
      }
    });
  });

  return {
    server,
    /** For tests: await the agent task's completion promise. */
    taskPromise: (taskId) => tasks.get(taskId)?.promise,
    start: () => new Promise((resolve) => {
      server.listen(controlPort, () => {
        runWatchTimer = setInterval(() => {
          let mtime = 0;
          try {
            mtime = statSync(runFile).mtimeMs;
          } catch {
            mtime = 0;
          }
          if (mtime === startApp.lastMtime) return;
          startApp.lastMtime = mtime;
          void restartApp();
        }, RUN_WATCH_INTERVAL_MS);
        runWatchTimer.unref?.();
        startApp();
        console.log(`[vendo-box] harness listening on :${controlPort}, app dir ${appDir}`);
        resolve();
      });
    }),
    stop: async () => {
      if (runWatchTimer !== undefined) clearInterval(runWatchTimer);
      appGeneration += 1;
      await stopApp();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
};
