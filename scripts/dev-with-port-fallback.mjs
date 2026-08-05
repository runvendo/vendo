#!/usr/bin/env node
/** Demo dev launcher — picks the port BEFORE Next starts and pins
 *  `VENDO_BASE_URL` to match it, so the operator-set public origin can never
 *  drift from the port the server actually bound to.
 *
 *  `VENDO_BASE_URL` is the credential-trusted origin: present execution
 *  forwards the signed-in user's session to it and the MCP door derives its
 *  OAuth discovery/audience URLs from it (both demos' `.env.example`). It is
 *  read at request time from `process.env` (`environment()` in
 *  packages/vendo/src/wire/shared.ts), so exporting it in this parent process
 *  before spawning `next dev` as a child is enough — Next's `@next/env` does
 *  not overwrite a variable already present in `process.env`.
 *
 *  Rather than let Next relocate to a free port and read it back (a race, and
 *  the source of the drift this replaces), we probe for the first free port
 *  ourselves starting at 3000 and only ever climb upward (3000, 3001, ...),
 *  then launch `next dev -p <that exact port>` with `VENDO_BASE_URL` already
 *  set to the same port. No manual step, no drift, by construction.
 *
 *  The probe releases its listener before Next binds, so a concurrent process
 *  can still steal the port in that gap. Next refuses to relocate when `-p` is
 *  explicit — it exits nonzero with EADDRINUSE within seconds — so we close
 *  the race by retrying: when the child dies during the startup window and a
 *  re-probe shows the port is now held by someone else, we relaunch on the
 *  next free candidate with `VENDO_BASE_URL` re-derived to match. Retries are
 *  bounded by the same 3000-3010 range; exhausting it stays a loud failure.
 *
 *  Auto-sync applies when `VENDO_BASE_URL` is unset or points at localhost —
 *  the `.env.example` default is `http://localhost:3000`, which is exactly the
 *  value that must track the bound port. Only a NON-LOCAL origin (a Tailscale
 *  funnel, tunnel, or deployed host — e.g. the funnel origin the demo-bank
 *  README pins for HTTPS iteration) is a deliberate operator setting we leave
 *  untouched. We first load the demo's own `.env*` files the way Next does, so
 *  a value set in the shell or in `.env`/`.env.local` is visible here (the
 *  parent process would not otherwise read them) before we decide.
 *
 *  Both demos' `dev` script invokes this from their own directory:
 *    "dev": "node ../../scripts/dev-with-port-fallback.mjs"
 *  The child inherits this cwd, so `next dev` resolves the right app. */
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const START_PORT = 3000;
// A busy 3000 falls back upward within this small bounded range; exhausting it
// is a loud failure, never an unbounded loop or a surprising high port.
const MAX_PORT = 3010;

/** Resolves true only if `port` can be bound right now. Binds the unspecified
 *  address (what `next dev` uses), so a listener on any interface counts as
 *  busy. Any bind error — EADDRINUSE and otherwise — means "not usable here". */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

async function firstFreePort(from) {
  for (let port = from; port <= MAX_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

/** Loads the demo's own `.env*` files into `process.env` exactly the way Next
 *  does at dev boot, so a `VENDO_BASE_URL` in `.env`/`.env.local` is visible
 *  here (the parent process would not otherwise read them) and can be honored as
 *  operator-set. `@next/env` is a transitive dep of `next`, so resolve it from
 *  the demo's deps and fall back to resolving it relative to the `next` package.
 *  Any failure is swallowed — we then simply derive localhost as before. */
function loadDemoEnv() {
  try {
    const require = createRequire(`${process.cwd()}/package.json`);
    let nextEnvPath;
    try {
      nextEnvPath = require.resolve("@next/env");
    } catch {
      nextEnvPath = createRequire(require.resolve("next/package.json")).resolve(
        "@next/env",
      );
    }
    require(nextEnvPath).loadEnvConfig(process.cwd(), true);
  } catch {
    // Swallow — fall through to deriving http://localhost:<port> below.
  }
}

/** True when `value` is a localhost origin (the kind we auto-sync to the bound
 *  port), false for a non-local origin we must preserve, and false for anything
 *  that does not parse — an unrecognized value is treated as a deliberate
 *  operator setting and left alone rather than clobbered. */
function isLocalOrigin(value) {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

loadDemoEnv();
// Preserve `VENDO_BASE_URL` only when it points somewhere NON-LOCAL (a funnel,
// tunnel, or deployed origin) — that is a deliberate operator choice. An unset
// value or a plain localhost origin (the `.env.example` default) is synced to
// the bound port instead, so a busy 3000 never leaves the origin behind.
const presetBaseUrl = process.env.VENDO_BASE_URL;
const preserveOperatorUrl =
  typeof presetBaseUrl === "string"
  && presetBaseUrl.length > 0
  && !isLocalOrigin(presetBaseUrl);

// Spawn Next's CLI entry directly through node (resolved from the demo's own
// dependencies) so launching does not depend on PATH or a shell; fall back to
// the `next` bin on PATH if the entry moves in a future Next release.
function spawnNext(port, env) {
  try {
    const require = createRequire(`${process.cwd()}/package.json`);
    const nextBin = require.resolve("next/dist/bin/next");
    return spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      stdio: "inherit",
      env,
    });
  } catch {
    return spawn("next", ["dev", "-p", String(port)], {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
  }
}

// Next binds its port before compiling anything, so an EADDRINUSE death lands
// within seconds; a nonzero exit after this window is a real crash, not a lost
// bind, and must never trigger a silent relaunch on a different port.
const STOLEN_PORT_WINDOW_MS = 30_000;

// Forward termination so Ctrl-C tears the Next child down with us. `child` is
// reassigned across relaunches, so the handlers close over the variable.
let child = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child?.kill(signal));
}

let searchFrom = START_PORT;
while (true) {
  const port = await firstFreePort(searchFrom);
  if (port === null) {
    console.error(
      `[dev] no free port in ${START_PORT}-${MAX_PORT}; free one (or stop whatever `
        + `holds them) and retry. Refusing to launch to avoid a VENDO_BASE_URL that `
        + `does not match the port Next binds.`,
    );
    process.exit(1);
  }

  const baseUrl = `http://localhost:${port}`;
  if (port !== START_PORT) {
    console.log(
      preserveOperatorUrl
        ? `[dev] port ${START_PORT} busy, using ${port} — VENDO_BASE_URL left as `
            + `operator-set ${presetBaseUrl} (not synced)`
        : `[dev] port ${START_PORT} busy, using ${port} — VENDO_BASE_URL synced `
            + `automatically to ${baseUrl}`,
    );
  }

  // Only preserve a non-local operator origin (already in `process.env`,
  // inherited as-is); otherwise sync the port-matched localhost origin so it
  // never drifts.
  const childEnv = preserveOperatorUrl
    ? { ...process.env }
    : { ...process.env, VENDO_BASE_URL: baseUrl };

  const startedAt = Date.now();
  child = spawnNext(port, childEnv);
  const { code, signal } = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // The probe released the port before Next bound it, so a concurrent process
  // can steal it in the gap; Next then dies nonzero with EADDRINUSE right away
  // (it never relocates when `-p` is explicit). If that early death coincides
  // with the port now being held by someone else, the race fired — move on to
  // the next candidate. A crash with the port free is a real failure to report.
  const diedDuringStartup =
    signal === null && code !== 0 && Date.now() - startedAt < STOLEN_PORT_WINDOW_MS;
  if (diedDuringStartup && !(await isPortFree(port))) {
    console.error(
      `[dev] port ${port} was taken between our probe and Next binding it; `
        + `retrying on the next free port`,
    );
    searchFrom = port + 1;
    continue;
  }

  // Exit with whatever the child reported.
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
}
