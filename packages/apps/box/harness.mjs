/**
 * The box bootstrap supervisor and the SESSION door in front of it.
 *
 * `createHarness()` builds it without side effects (so it is unit-testable);
 * `bootstrap.mjs` is the thin entrypoint that starts it. It owns two jobs:
 *
 *   1. Supervise the app process. Its Procfile-style entry is ONE shell line in
 *      `/app/.vendo/run`, spawned with the boundary env (env.json) merged in
 *      and restarted on exit, on entry change, and on env re-injection. The app
 *      owns $PORT; this process never binds it.
 *
 *   2. Serve the CONTROL PORT (default 8811, VENDO_CONTROL_PORT), spoken via
 *      SandboxMachine.request({port}):
 *        /session/**                   → the conversational turn door
 *                                        (`turn-routes.mjs`, loaded lazily)
 *        GET  /agent/health            → {ok, app:{running}}
 *        POST /agent/env {env}         → persist boundary env + restart app
 *        POST /agent/restart-app       → restart the supervised app
 *
 * Security posture: the provider exposes sandbox ports on an unguessable
 * per-machine hostname; the control port carries no bearer of its own. The box
 * holds no host authority.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const RESPAWN_DELAY_MS = 1_000;
const RUN_WATCH_INTERVAL_MS = 2_000;

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
 * @param {object} [options]
 * @param {string} [options.appDir]        the app directory (default /app)
 * @param {number} [options.controlPort]   control-port listen port (default 8811)
 * @param {NodeJS.ProcessEnv} [options.baseEnv] base env for the app process (default process.env)
 */
export const createHarness = (options = {}) => {
  const appDir = options.appDir ?? process.env.VENDO_APP_DIR ?? "/app";
  const controlPort = options.controlPort ?? Number(process.env.VENDO_CONTROL_PORT ?? 8811);
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
   * WHOLE boundary — the host rebuilds it from scratch on every injection — so
   * it REPLACES the provision-time surface rather than layering over it. Only
   * the machine's own vars survive from the base env.
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
