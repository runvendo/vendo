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
 *  This auto-sync only kicks in when `VENDO_BASE_URL` isn't already
 *  operator-set. We first load the demo's own `.env*` files the way Next does,
 *  so a value set in the shell or in `.env`/`.env.local` (e.g. the Tailscale
 *  funnel origin the demo-bank README pins for HTTPS iteration) is detected and
 *  passed through to the child untouched — never clobbered with localhost.
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

async function firstFreePort() {
  for (let port = START_PORT; port <= MAX_PORT; port++) {
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

loadDemoEnv();
// `VENDO_BASE_URL` set in the shell or any loaded `.env*` file is operator-set:
// pass it through untouched rather than syncing it to the bound port.
const operatorBaseUrl = process.env.VENDO_BASE_URL;
const operatorSet =
  typeof operatorBaseUrl === "string" && operatorBaseUrl.length > 0;

const port = await firstFreePort();
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
    operatorSet
      ? `[dev] port ${START_PORT} busy, using ${port} — VENDO_BASE_URL left as `
          + `operator-set ${operatorBaseUrl} (not synced)`
      : `[dev] port ${START_PORT} busy, using ${port} — VENDO_BASE_URL synced `
          + `automatically to ${baseUrl}`,
  );
}

// Only sync the port-matched origin when the operator hasn't pinned one; an
// operator-set value already lives in `process.env` and is inherited as-is.
const childEnv = operatorSet
  ? { ...process.env }
  : { ...process.env, VENDO_BASE_URL: baseUrl };

// Spawn Next's CLI entry directly through node (resolved from the demo's own
// dependencies) so launching does not depend on PATH or a shell; fall back to
// the `next` bin on PATH if the entry moves in a future Next release.
let child;
try {
  const require = createRequire(`${process.cwd()}/package.json`);
  const nextBin = require.resolve("next/dist/bin/next");
  child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    stdio: "inherit",
    env: childEnv,
  });
} catch {
  child = spawn("next", ["dev", "-p", String(port)], {
    stdio: "inherit",
    env: childEnv,
    shell: process.platform === "win32",
  });
}

// Forward termination so Ctrl-C tears the Next child down with us, and exit
// with whatever the child reported.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
