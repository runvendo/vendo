import { createRequire } from "node:module";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { startDevServerForProbe } from "./doctor-live.js";
import { CLI_VERSION, askYesNo } from "./shared.js";
import { probeBody, type DoctorRun } from "./doctor-report.js";
import type { DoctorOptions } from "./doctor.js";

/** Whether the optional `e2b` SDK resolves from the target project — the same
 *  node_modules walk the running wire's dynamic `import("e2b")` performs, so
 *  doctor certifies the venue against the resolution that will actually be
 *  asked to load it (0.4.4 defect C: /status said e2b on a host without the
 *  SDK, and the first build died in an unusable venue). */
function e2bResolvableFrom(root: string): boolean {
  try {
    createRequire(join(root, "__vendo-doctor-probe__.js")).resolve("e2b");
    return true;
  } catch {
    return false;
  }
}

/** NOTHING doctor can observe proves WHY the auth probes 404, so neither
    message below asserts a cause — they report what was seen, name the
    candidates, and hand the reader the step that separates them.

    `/doctor/base-url` is the best evidence available: wire/doctor.ts mounts it
    in EVERY environment (wireRoutesFor keeps it outside the `deps.development`
    ternary) precisely so a production misconfiguration stays probeable, while
    the probes beside it are development-only. But it is only evidence. A
    Vendo-shaped answer is indistinguishable between "your dev server with the
    gate closed" and "a real Vendo deployment that is not the one you meant" —
    a stale base URL aimed at staging answers identically, byte for byte — and
    doctor cannot know which deployment the reader intended. In the other
    direction, ANY non-404 was read as the wire until an HTML catch-all (200),
    an auth layer (401) and a proxy error page (500) all sailed through, so the
    body must carry the route's `{ ok }` shape to count as the wire at all. */
const PROBES_404_WIRE_ANSWERS =
  "the doctor probes answered 404 while /doctor/base-url — mounted by every composition in every "
  + "environment — answered like a Vendo wire. Two things look exactly like this from here. Most "
  + "likely this composition never declared itself development, so the development-only probes were "
  + "left out of the route table: pass createVendo({ development: true }) for this host, or run it "
  + "with NODE_ENV=development (next dev sets that for you; a plain node/tsx server does not), "
  + "restart, and re-run doctor. If they still 404, this URL is a real Vendo deployment but not the "
  + "dev server you meant — a stale base URL or a proxy aimed at staging or production, which is "
  + "meant to answer 404 here.";

/** base-url did not answer like the wire, so the development gate is the less
    likely story: every composition mounts that route. Something answered
    /status at this URL — a proxy, an HTML catch-all, an unrelated service. */
const PROBES_404_NO_WIRE = (statusUrl: string, observed: string): string =>
  `the doctor probes answered 404, and /doctor/base-url — mounted by every composition in every `
  + `environment — did not answer like a Vendo wire either (${observed}). So most likely ${statusUrl} `
  + `is not this app's Vendo wire base, even though something there answered /status: check the origin `
  + `and the FULL mount path you passed (a host under a basePath needs it, e.g. `
  + `http://localhost:3000/maple/api/vendo), and any proxy, auth layer or HTML catch-all in front of `
  + `it. If the URL is right, this host's @vendoai/vendo predates the doctor surface — upgrade it and `
  + `restart the dev server.`;

/** Consent-gated dev-server start (design §5): when nothing is listening on
 *  the dev port and doctor is interactive, offer to boot it so the live probes
 *  have something to reach. --yes is the documented non-interactive consent
 *  (quickstart: "pass --yes to start it non-interactively"), so it bypasses
 *  the TTY gate. Skipped in --json runs (stdout carries only the final object).
 *
 *  Returns the stopper the caller must invoke once the probes are done. */
export async function startDevServerIfOffered(run: DoctorRun, options: DoctorOptions): Promise<(() => void) | null> {
  const { statusUrl, fetchImpl, env, root } = run;
  const interactive = options.interactive ?? (Boolean(stdout.isTTY) && Boolean(stdin.isTTY));
  const confirm = options.confirm ?? askYesNo;
  if (run.json || !(interactive || options.yes === true)) return null;
  let listening = false;
  try { listening = (await fetchImpl(`${statusUrl}/status`)).ok; } catch { listening = false; }
  if (listening) return null;
  const go = options.yes === true
    || await confirm("Nothing is listening on the dev port. Start the dev server for the probe?", true);
  if (!go) return null;
  run.note(`\nStarting the dev server so the probe has a live composition to reach…`);
  const start = options.startDevServer ?? startDevServerForProbe;
  const started = await start({ root, statusUrl, env, fetchImpl });
  if (started.ok) {
    run.pass("dev/start", "started the dev server for the probe");
    return started.stop;
  }
  run.warn("dev/start", "E-DEV-001", "could not start the dev server for the probe; start it yourself (e.g. `npm run dev`) and re-run `vendo doctor`");
  return null;
}

/** 0.4.4 defect C — "ok: execution venue: e2b" on a host that cannot
 *  actually run e2b is a false blessing: the venue must be USABLE
 *  (key set and SDK resolvable from this project), or every server-app
 *  build dies in it instead of riding the Cloud sandbox. */
function checkE2bVenue(run: DoctorRun, e2bResolvable: ((root: string) => boolean) | undefined): void {
  const { env, root } = run;
  const keyPresent = typeof env.E2B_API_KEY === "string" && env.E2B_API_KEY.trim() !== "";
  const installed = (e2bResolvable ?? e2bResolvableFrom)(root);
  if (keyPresent && installed) {
    run.pass("live/venue", "execution venue: e2b");
    return;
  }
  const missing = [
    ...(keyPresent ? [] : ["E2B_API_KEY is not set"]),
    ...(installed ? [] : ["the e2b package does not resolve from this project"]),
  ].join(" and ");
  // This reads doctor's OWN env and project root, not the server's, so
  // a live e2b venue failing here means the two disagree.
  run.fail("live/venue", "E-LIVE-007", `the running wire selected the e2b execution venue but ${missing}; server-app builds will fail in an unusable sandbox. Fix: install the e2b package and set E2B_API_KEY, or remove E2B_API_KEY from the server env (with VENDO_API_KEY set, the managed Cloud sandbox takes over), then restart the dev server and re-run doctor`);
}

function checkVenue(run: DoctorRun, sandboxVenue: unknown, e2bResolvable: ((root: string) => boolean) | undefined): void {
  if (sandboxVenue === "e2b") {
    checkE2bVenue(run, e2bResolvable);
  } else if (sandboxVenue === "cloud" || sandboxVenue === "custom") {
    run.pass("live/venue", `execution venue: ${sandboxVenue}`);
  } else if (sandboxVenue === false) {
    run.warn("live/venue", "E-LIVE-004", "install the e2b package and set E2B_API_KEY, or set VENDO_API_KEY for the managed Cloud sandbox, or pass sandbox: to createVendo; without one, server apps (rungs 2-4) return sandbox-unavailable");
  } else if (sandboxVenue === undefined) {
    // Older hosts predate blocks.sandbox — version skew, not a broken install.
    run.warn("live/venue", "E-LIVE-005", "host /status does not report an execution venue; upgrade @vendoai/vendo to enable the venue check");
  } else {
    run.fail("live/venue", "E-LIVE-003", "/status returned an invalid execution venue");
  }
}

/** Split-brain guard (0.4.2 re-run, invoify defect 13): a direct
 *  @vendoai/vendo dependency pinned to an older range beats the vendoai
 *  umbrella's for the APP import, so `npm install vendoai@latest` runs a
 *  new CLI while /status silently serves the old runtime. Any CLI/wire
 *  version disagreement — split-brain or just a dev server started
 *  before the upgrade — means doctor is not certifying what users run. */
function checkVersionSkew(run: DoctorRun, wireVersion: string): void {
  if (wireVersion === CLI_VERSION) {
    run.pass("deps/version-skew", `CLI and running wire agree on @vendoai/vendo ${CLI_VERSION}`);
  } else {
    run.fail("deps/version-skew", "E-DEP-002", `the running wire serves @vendoai/vendo ${wireVersion} but this CLI is ${CLI_VERSION} — likely a split-brain install (a direct @vendoai/vendo dependency pinned to an older range wins over the vendoai umbrella's). Fix: npm install @vendoai/vendo@${CLI_VERSION} (or remove the direct @vendoai/vendo dependency and reinstall), then restart the dev server and re-run doctor.`);
  }
}

export interface LiveComposition {
  /** 10-mcp §1 — the door flag lives under blocks.mcp. Since the broker
   *  seam it is a posture ("local" | "broker" | false); older wires still
   *  send a boolean (version skew), which predates the broker — "local". */
  mcpPosture: "local" | "broker" | false;
  live: boolean;
}

export async function checkLiveStatus(run: DoctorRun, e2bResolvable: ((root: string) => boolean) | undefined): Promise<LiveComposition> {
  const { statusUrl, fetchImpl } = run;
  try {
    const response = await fetchImpl(`${statusUrl}/status`, {
      headers: { accept: "application/json" },
    });
    const body = await response.json() as {
      posture?: unknown;
      version?: unknown;
      deprecated?: unknown;
      blocks?: { mcp?: unknown; sandbox?: unknown } | null;
    };
    if (!response.ok || typeof body.posture !== "string" || typeof body.version !== "string"
      || typeof body.blocks !== "object" || body.blocks === null) {
      run.fail("live/status", "E-LIVE-001", `/status returned an invalid composition response (${response.status})`);
      return { mcpPosture: false, live: false };
    }
    run.pass("live/status", `/status live round-trip (${body.version}, ${body.posture})`);
    checkVersionSkew(run, body.version);
    const mcpPosture = body.blocks.mcp === "broker" ? "broker"
      : body.blocks.mcp === true || body.blocks.mcp === "local" ? "local"
      : false;
    checkVenue(run, body.blocks.sandbox, e2bResolvable);
    return { mcpPosture, live: true };
  } catch {
    run.fail("live/status", "E-LIVE-002", `/status is unreachable at ${statusUrl}/status — doctor expects the WIRE BASE (your app origin plus the mount path, e.g. http://localhost:3000/api/vendo); a bare site origin passed to --url is missing the /api/vendo part`);
    return { mcpPosture: false, live: false };
  }
}

/** Render gate (0.4.1 E2E cert M3): a live wire proves nothing about the
 *  PAGES — the certified invoify install had every page 500ing (registry
 *  passed across the Server Component boundary) while doctor exited 0. One
 *  cheap GET of the app root catches a site that is down for users.
 *
 *  It catches THAT and nothing more, so it claims nothing more. A status line
 *  is the whole observation: doctor never parses the body, so even a 200 is
 *  "the server answered", not "the page is right" — and a 4xx is the server
 *  answering that there is no page here at all, which is the same fact the
 *  catch below already declines to judge. Reporting either as `ok: the app's
 *  root page renders` made 404 the blessing every healthy run printed and left
 *  the check unable to fail on anything but 5xx. */
export async function checkRootRender(run: DoctorRun): Promise<void> {
  const { statusUrl, fetchImpl } = run;
  try {
    const response = await fetchImpl(`${new URL(statusUrl).origin}/`, { headers: { accept: "text/html" } });
    if (response.status >= 500) {
      run.fail("live/render", "E-LIVE-006", `the app's root page returned ${response.status} — the site is crashing for users even though the wire answers (typical cause: the component registry declared in a Server Component layout; move it into your own "use client" file with the provider). Check the dev server log.`);
    } else if (response.status >= 400) {
      // Not a pass and not a failure: a host that serves nothing at `/` — every
      // page under a basePath, an auth layer in front — is healthy, and doctor
      // cannot tell that apart from a route you meant to have.
      run.note(`  the app's root page answered HTTP ${response.status}, so this run did not reach a page to check. If you expected a page at ${new URL(statusUrl).origin}/, check your routes; a host that serves nothing there is fine.`);
    } else {
      run.pass("live/render", `the app's root page answered HTTP ${response.status}`);
    }
  } catch {
    // The wire answered but the origin root didn't resolve at all — hosts
    // that serve no page at / are not doctor's business; skip silently.
  }
}

async function checkPresentCredential(run: DoctorRun, probe404Message: () => Promise<string>): Promise<void> {
  const { statusUrl, fetchImpl } = run;
  try {
    const response = await fetchImpl(`${statusUrl}/doctor/present`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer vendo-doctor-present",
        cookie: "vendo_doctor_present=1",
      },
      body: "{}",
    });
    const body = await probeBody(response);
    if (response.ok && body.ok === true) {
      run.pass("auth/present", "present credentials reach the host API");
    } else if (response.status === 404) {
      run.fail("auth/present", "E-AUTH-001", await probe404Message());
    } else {
      run.fail("auth/present", "E-AUTH-001", "present credentials did not reach the host API; set VENDO_BASE_URL to the running host origin and restart the dev server");
    }
  } catch {
    run.fail("auth/present", "E-AUTH-002", `present credential probe is unreachable at ${statusUrl}/doctor/present; restart the dev server and verify VENDO_BASE_URL`);
  }
}

async function checkActAs(run: DoctorRun, probe404Message: () => Promise<string>): Promise<void> {
  const { statusUrl, fetchImpl } = run;
  try {
    const response = await fetchImpl(`${statusUrl}/doctor/act-as`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });
    const body = await probeBody(response);
    if (response.ok && body.ok === true) {
      run.pass("auth/act-as", "actAs mint + host verification live round-trip");
    } else if (body.error?.code === "act-as-not-configured") {
      run.warn("auth/act-as", "E-AUTH-007", "actAs is not configured; pass createVendo({ actAs }) before enabling away host actions");
    } else if (response.status === 404) {
      run.fail("auth/act-as", "E-AUTH-004", await probe404Message());
    } else {
      run.fail("auth/act-as", "E-AUTH-004", "actAs mint + host verification failed; check createVendo({ actAs }), its verifier middleware, and the host principal resolver");
    }
  } catch {
    run.fail("auth/act-as", "E-AUTH-005", `actAs probe is unreachable at ${statusUrl}/doctor/act-as; restart the dev server and check createVendo({ actAs })`);
  }
}

export async function checkAuthProbes(run: DoctorRun, liveComposition: boolean): Promise<void> {
  const { statusUrl, fetchImpl } = run;
  if (!liveComposition) {
    run.fail("auth/present", "E-AUTH-003", `present credential probe cannot run; start the dev server at ${statusUrl} and retry`);
    run.fail("auth/act-as", "E-AUTH-006", `cannot probe actAs; start the dev server at ${statusUrl} and retry`);
    return;
  }
  // Asked at most once, and only when a probe actually 404s, so a healthy
  // run costs no extra request. The route answers `{ ok: true }`, or
  // `{ ok: false, error }` in a production deployment with VENDO_BASE_URL
  // unset — a boolean `ok` is the whole fingerprint, and anything without it
  // (HTML, a redirect target, an error page, no response at all) did not
  // come from a Vendo route table.
  let probe404: Promise<string> | undefined;
  const probe404Message = (): Promise<string> => (probe404 ??= (async () => {
    let observed = "no response";
    try {
      const response = await fetchImpl(`${statusUrl}/doctor/base-url`, { headers: { accept: "application/json" } });
      if (typeof (await probeBody(response)).ok === "boolean") return PROBES_404_WIRE_ANSWERS;
      observed = `HTTP ${response.status}, not a Vendo response body`;
    } catch { /* keep "no response" */ }
    return PROBES_404_NO_WIRE(statusUrl, observed);
  })());

  await checkPresentCredential(run, probe404Message);
  await checkActAs(run, probe404Message);
}

/** Machine + schedule REPORTING (no new subcommand): which apps carry a
 *  machine, what their manifests declare, and whether a schedule caller is
 *  configured for the authenticated /tick surface. Declarations only — when a
 *  schedule last ran is the automation's run records now, and printing "never
 *  fired" from a payload that no longer carries last-fired state would be a
 *  doctor telling you something untrue. /doctor/machines is a dev-only route,
 *  so an unreachable or older host simply skips the section (reporting must
 *  never break doctor). */
export async function reportMachines(run: DoctorRun): Promise<void> {
  const { statusUrl, fetchImpl } = run;
  try {
    const response = await fetchImpl(`${statusUrl}/doctor/machines`, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = await response.json() as {
      scheduleCallerConfigured?: unknown;
      machines?: Array<{
        appId?: string;
        name?: string;
        awake?: boolean;
        schedules?: Array<{ cron?: string; fn?: string }>;
      }>;
    };
    const machines = Array.isArray(body.machines) ? body.machines : [];
    run.pass("machines/apps", machines.length === 0
      ? "no machine-bearing apps"
      : `${machines.length} machine-bearing app${machines.length === 1 ? "" : "s"}`);
    for (const machine of machines) {
      run.note(`  ${machine.appId ?? "?"} (${machine.name ?? "unnamed"}): ${machine.awake === true ? "awake" : "asleep"}`);
      for (const schedule of machine.schedules ?? []) {
        run.note(`    ${schedule.cron ?? "?"} -> POST /fn/${schedule.fn ?? "?"}`);
      }
    }
    const declaresSchedules = machines.some((machine) => (machine.schedules?.length ?? 0) > 0);
    if (body.scheduleCallerConfigured === true) {
      run.pass("machines/schedule-caller", "schedule caller configured (VENDO_TICK_SECRET); point an external cron at POST /api/vendo/tick");
    } else if (declaresSchedules) {
      run.warn("machines/schedule-caller", "E-SCHED-001", "apps declare vendo.json schedules but no schedule caller is configured — set VENDO_TICK_SECRET and point an external cron (Vercel cron, GitHub Actions, crontab) at POST /api/vendo/tick");
    } else if (machines.length > 0) {
      run.note("  no schedule caller configured (VENDO_TICK_SECRET unset) — needed once an app declares vendo.json schedules");
    }
  } catch {
    // Reporting only — an unreachable machines route never fails doctor.
  }
}
