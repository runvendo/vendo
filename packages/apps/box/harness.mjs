/**
 * execution-v2 Wave 3 — the box bootstrap supervisor + agent harness (factory).
 *
 * This module IS the "agent lives in the box" half of the base box template:
 * the supervisor/control-port process is zero-dependency, and the coding agent
 * underneath BOTH its doors is `claude-turn.mjs` — the same module the session
 * door (`turn-routes.mjs`) drives and the same module `machine: "local"` runs
 * on a host. ONE Claude Code integration, three callers.
 *
 * There used to be a second one beside it: a bespoke one-shot `query()` loop
 * with its own system prompt, its own event reading and its own nudge. It is
 * gone. What survives is what only the TASK door needs — the box conventions
 * the agent builds against, and the structured result the host polls for — and
 * those sit here, on the door that wants them.
 *
 * `createHarness()` builds it without side effects (so it is unit-testable);
 * `bootstrap.mjs` is the thin entrypoint that starts it. It owns two jobs:
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
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const RESPAWN_DELAY_MS = 1_000;
const RUN_WATCH_INTERVAL_MS = 2_000;
const LOG_TAIL_BYTES = 4_096;

/** The ONE runner, at the path `turn-routes.mjs` loads it from — both doors of
 *  this control port reach the same module in the same image. */
const RUNNER = "/opt/vendo-box/claude-turn.mjs";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_TURNS = 80;
const LOG_CAP = 2_000;
/** Where the agent files its structured result. A FILE rather than a tool: the
 *  runner's only MCP server is the host's own door, and a box task has no door
 *  — so the report rides the one channel a box task and its supervisor already
 *  share. The host treats the whole thing as DATA either way (prompt-injection
 *  floor — nothing in this result can approve or authorize anything
 *  host-side). */
const REPORT_FILE = "report.json";

const truncate = (text, cap = LOG_CAP) =>
  text.length <= cap ? text : `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;

/** ANTHROPIC_BASE_URL wants the bare origin; VENDO_INFERENCE_URL may carry /v1. */
const baseUrl = (url) => url.replace(/\/+$/, "").replace(/\/v1$/, "");

/** The box conventions, appended to the runner's Claude Code system prompt. */
const boxConventions = (appDir, controlPort) => `You are the coding agent living inside a Vendo app machine (the box). The app directory ${appDir} is yours: any language, any framework, any process.

Box conventions (the skin of the box):
- The app process must listen on the PORT env var, serve POST /fn/<name> endpoints answering {"result": ...} on success or {"error": {"code", "message"}} on failure, and serve GET /vendo.json returning the manifest file verbatim.
- The manifest ${appDir}/vendo.json declares schedules ({"schedules":[{"cron":"0 8 * * *","fn":"name"}]}) and outbound domains ({"egress":["api.example.com"]}). Declare every third-party domain your code fetches; undeclared egress is blocked at the network layer.
- ${appDir}/.vendo/run is the Procfile-style entry: ONE shell line that starts the app (e.g. "node server.js"). A supervisor (not you) runs it with the boundary env and restarts it when you POST http://localhost:${controlPort}/agent/restart-app.
- Durable data goes through the Vendo store, NOT the disk — the disk is scratch. From the template: \`import { rows } from "./rows.js"\` in fns.js, then \`rows("notes").put(id, data, {refs})\`, \`.get(id)\` (null when there is no such row), \`.list({refs, limit, cursor})\`, \`.delete(id)\`. Rows are scoped to the end user automatically — you never name an owner, cannot set one, and cannot read another user's rows. In any other language, curl the same door: curl -X PUT "$VENDO_STORE_URL/rows/<collection>/<id>" -H "authorization: Bearer $VENDO_APP_TOKEN" -H "content-type: application/json" -d '{"data": {...}}' (list with GET "$VENDO_STORE_URL/rows/<collection>").
- Host tools ride POST "$VENDO_HOST_URL/tools/<name>" with the same bearer; approvals and audit happen host-side.

Working style:
- START from the pre-baked template at /opt/vendo-box/template (\`cp -a /opt/vendo-box/template/. /app/\`) rather than writing a server from scratch: it is Vite + React 19 with @vendoai/ui installed, the /fn envelopes wired, and its deps already present. The box egress is deny-by-default, so \`npm install\` reaches only registries you DECLARE in vendo.json egress — build with what the template already ships instead of adding packages.
- The real toolchain is your code validator: \`npm run typecheck\` (tsc), \`npm run build\` (vite) and \`npm run validate\` (which runs both, then checks the skin contract) all work offline in the box. Never hand-check syntax; run them.
- Verify against reality: after writing code, restart the app (curl the supervisor route above), wait a moment, then curl your own endpoints on http://localhost:$PORT and fix failures before reporting.
- Never bind $PORT from a process you spawn yourself; the supervisor owns the app process.
- END the task by writing your honest structured result to ${appDir}/.vendo/${REPORT_FILE} as ONE JSON object, exactly once: {"ok": <boolean>, "summary": "<what you did>", "filesChanged": ["<path>", …], "testsRun": <integer>, "fns": ["<name>", …]}. ok=false with a clear summary beats a fake success. List the fn names you serve in fns. Nothing you write is read as a decision — it is reported to the host as data.
- If (and only if) the task asks you to serve a real web app: serve its pages on the non-/fn paths of $PORT (GET / is the entry page), keep any /fn/<name> endpoints working beside them, curl your pages until they answer 200 with real content, and then add "servesUi": true to that JSON. Never claim servesUi for an fn-only task.`;

/**
 * The MACHINE's own env vars — the only ones the app and the in-box agent
 * inherit from this process once a boundary env has been injected. Everything
 * else in the box's process env arrived from the host at provision (a provider
 * applies create-time env box-wide, this supervisor included), and an injected
 * boundary env REPLACES that whole surface — see boundaryEnv().
 *
 * Two of them are Vendo's, and deliberately: they are how the machine is
 * configured, not what the host grants (createHarness reads both from
 * process.env). A granted secret can never legitimately be named any of these:
 * shadowing the machine's own PATH or HOME breaks the box long before a
 * revocation matters.
 */
const MACHINE_ENV_KEYS = new Set([
  "PATH", "HOME", "HOSTNAME", "USER", "LOGNAME", "SHELL", "PWD",
  "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR",
  "NODE_VERSION", "YARN_VERSION",
  "VENDO_APP_DIR", "VENDO_CONTROL_PORT",
]);

/**
 * Run one agent task to a structured result, on the ONE runner.
 *
 * Dynamic imports on purpose — `claude-turn.mjs` and the Agent SDK both live in
 * the machine image (`/opt/vendo-box`, staged and npm-installed at
 * template-build time), and host-side unit tests inject a double so they never
 * load either. `turn-routes.mjs` reaches for both exactly the same way.
 *
 * Never throws for model/tool failures: an exhausted or wedged engine reports
 * {ok:false} honestly.
 */
const runTaskOnRunner = async ({ prompt, context, env, appDir, log }) => {
  const url = env.VENDO_INFERENCE_URL;
  const key = env.VENDO_INFERENCE_KEY;
  if (typeof url !== "string" || url === "" || typeof key !== "string" || key === "") {
    return { ok: false, summary: "the box has no inference endpoint (VENDO_INFERENCE_URL/VENDO_INFERENCE_KEY missing)", filesChanged: [], testsRun: 0 };
  }
  const model = typeof env.VENDO_INFERENCE_MODEL === "string" && env.VENDO_INFERENCE_MODEL !== "" ? env.VENDO_INFERENCE_MODEL : DEFAULT_MODEL;
  const reportPath = path.join(appDir, ".vendo", REPORT_FILE);
  // A stale report from the previous task would be read as this one's answer.
  rmSync(reportPath, { force: true });
  const written = new Set();
  const readReport = () => {
    try {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const fullPrompt = context === undefined ? prompt : `${context}\n\nTASK:\n${prompt}`;
  log(`[task] runner=claude-turn model=${model} promptBytes=${fullPrompt.length}`);
  const { createClaudeSession } = await import(RUNNER);
  const session = createClaudeSession({
    sdk: await import("@anthropic-ai/claude-agent-sdk"),
    systemPrompt: boxConventions(appDir, env.VENDO_CONTROL_PORT ?? "8811"),
    model,
    maxTurns: MAX_TURNS,
    cwd: appDir,
    env: {
      ...env,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: baseUrl(url),
      // The box blocks everything but the inference host; don't let the CLI
      // stall on telemetry/update endpoints it can never reach.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CONFIG_DIR: "/tmp/vendo-claude",
    },
    // The task door has no live listener, so the runner's stream becomes the
    // log the host polls beside the result.
    emit: (event) => {
      if (event?.type === "text") log(`[assistant] ${truncate(event.delta)}`);
      else if (event?.type === "status") log(`[beat] ${event.phase ?? "?"} ${event.label}`);
      else if (event?.type === "usage") log(`[usage] in=${event.inputTokens} out=${event.outputTokens} model=${event.model ?? "?"}`);
      else if (event?.type === "error") log(`[error] ${truncate(event.message)}`);
    },
    onFileWritten: (target) => {
      if (typeof target === "string" && target !== "") {
        written.add(target);
        log(`[write] ${target}`);
      }
    },
  });
  let report;
  try {
    await session.send(fullPrompt);
    report = readReport();
    // One nudge, mirroring the one the deleted loop had: an agent that finished
    // without the structured result gets a short turn to file it. Same session,
    // so it costs a message and not a rebuild.
    if (report === undefined) {
      log(`[task] no ${REPORT_FILE} — nudging once`);
      await session.send(`Write your honest structured result for the task you just worked on to ${reportPath} now, as one JSON object. Do nothing else.`);
      report = readReport();
    }
  } catch (error) {
    // A report filed before a late stream failure still counts (review finding,
    // PR #438): the structured result is the contract; the throw after it is
    // engine noise.
    report = readReport();
    if (report === undefined) {
      return {
        ok: false,
        summary: `agent engine failed: ${error instanceof Error ? error.message : String(error)}`,
        filesChanged: [...written],
        testsRun: 0,
      };
    }
    log(`[task] engine threw after the report — keeping it: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await session.end().catch(() => undefined);
  }
  if (report === undefined) {
    return { ok: false, summary: `agent finished without writing ${REPORT_FILE}`, filesChanged: [...written], testsRun: 0 };
  }
  // The injection floor: only the declared fields pass through, exactly as
  // declared — a box result is data, never authority.
  const declared = Array.isArray(report.filesChanged) ? report.filesChanged.filter((entry) => typeof entry === "string") : [];
  const result = {
    ok: report.ok === true,
    summary: typeof report.summary === "string" ? report.summary : "(no summary)",
    filesChanged: [...new Set([...written, ...declared])],
    testsRun: Number.isInteger(report.testsRun) && report.testsRun >= 0 ? report.testsRun : 0,
    ...(Array.isArray(report.fns) ? { fns: report.fns.filter((entry) => typeof entry === "string") } : {}),
    ...(report.servesUi === true ? { servesUi: true } : {}),
  };
  log(`[task] done ok=${result.ok} summary=${truncate(result.summary, 500)}`);
  return result;
};

/**
 * @param {object} [options]
 * @param {string} [options.appDir]        the app directory (default /app)
 * @param {number} [options.controlPort]   control-port listen port (default 8811)
 * @param {Function} [options.runTask] injectable agent engine (tests)
 * @param {NodeJS.ProcessEnv} [options.baseEnv] base env for the app process (default process.env)
 */
export const createHarness = (options = {}) => {
  const appDir = options.appDir ?? process.env.VENDO_APP_DIR ?? "/app";
  const controlPort = options.controlPort ?? Number(process.env.VENDO_CONTROL_PORT ?? 8811);
  const runTask = options.runTask ?? runTaskOnRunner;
  const baseEnv = options.baseEnv ?? process.env;

  const vendoDir = path.join(appDir, ".vendo");
  const runFile = path.join(vendoDir, "run");
  const envFile = path.join(vendoDir, "env.json");
  mkdirSync(vendoDir, { recursive: true });

  /**
   * The boundary env the app and the in-box agent run with.
   *
   * Before the first injection the base env IS the boundary env: provision
   * delivers it as the machine's create-time env. Once env.json exists it is the
   * WHOLE boundary — the host rebuilds it from scratch (box-env.ts assembles
   * PORT, the callback URLs, the app token, the inference door, and every
   * granted secret) on every grant flip and every pre-edit re-injection — so it
   * REPLACES the provision-time surface rather than layering over it. Only the
   * machine's own vars survive from the base env.
   *
   * Merging env.json OVER the base env, as this did until 2026-08, made a
   * DELETION unrepresentable: a secret revoked after provision kept its
   * provision-time value in this process's env, the freshly built injection
   * simply omitted the key, and every restart handed the agent a credential its
   * owner had taken away. Absence in the injected set is now the instruction it
   * always meant.
   */
  const boundaryEnv = () => {
    let injected = null;
    try {
      const parsed = JSON.parse(readFileSync(envFile, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) injected = parsed;
    } catch {
      // No env.json yet (fresh template) or unreadable — base env stands.
    }
    if (injected === null) return { ...baseEnv };
    const merged = {};
    for (const key of Object.keys(baseEnv)) {
      if (MACHINE_ENV_KEYS.has(key) && typeof baseEnv[key] === "string") merged[key] = baseEnv[key];
    }
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
        result = await runTask({ prompt, context, env: boundaryEnv(), appDir, log });
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

  // Wave 2 lane E — the conversational door beside the layer-3 builder's. Same
  // control port, same supervisor, a different kind of turn.
  //
  // Loaded LAZILY, on the first /session request, because the module's repo home
  // is `@vendoai/harnesses` (the claude-code driver owns its box-side half) and
  // `build-template.mjs` stages it in beside this file only at image bake. A
  // static import would fail in the monorepo, where this supervisor's own tests
  // run; in the image the file is always there, staged by the same build that
  // staged this one. The "/session" prefix mirrors the module's own `owns()`.
  let turnRoutes = options.turnRoutes;
  const sessionRoutes = async () => {
    if (turnRoutes === undefined) {
      const { createSessionRoutes } = await import("./turn-routes.mjs");
      turnRoutes = createSessionRoutes({ env: boundaryEnv() });
    }
    return turnRoutes;
  };

  const handle = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://box.internal");
    const route = `${request.method} ${url.pathname}`;
    if (url.pathname.startsWith("/session")) {
      let payload;
      try {
        const body = await readBody(request);
        payload = body === "" ? {} : JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "body must be JSON" });
        return;
      }
      const answer = await (await sessionRoutes()).handle(request.method, url.pathname, request.headers, payload);
      sendJson(response, answer.status, answer.body);
      return;
    }
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
