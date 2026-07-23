import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import type { Telemetry } from "@vendoai/telemetry";
import {
  cloudDoctor,
  liveModelTurn,
  startDevServerForProbe,
  type CloudDoctorResult,
  type LiveTurnResult,
} from "./doctor-live.js";
import { installedAiVersion } from "./dep-versions.js";
import { doctorFixRef, type DoctorErrorCode } from "./doctor-codes.js";
import { EJECT_MANIFEST_FILE, type EjectedManifest } from "./eject.js";
import { overridesFileSchema, toolsFileSchema } from "@vendoai/actions";
import { detectFramework, detectVendoWiring } from "./framework.js";
import { walk } from "./theme/walk.js";
import { remoteUrls, sameUrl, validateRegistryServer } from "./mcp/registry.js";
import { askYesNo, CLI_VERSION, consoleOutput, exists, normalizeDotEnvValue, readOptional, toolingTelemetry, type Output } from "./shared.js";

export interface DoctorOptions {
  targetDir: string;
  url?: string;
  fetchImpl?: typeof fetch;
  output?: Output;
  /** Machine-readable single-object output (design §5). */
  json?: boolean;
  /** Auto-confirm the dev-server-probe consent — works non-interactively
   *  (piped stdio / CI); --json runs never start the server. */
  yes?: boolean;
  env?: Record<string, string | undefined>;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
  /** Seams (tests): each new probe is injectable so doctor runs without keys
   *  or a running server. */
  interactive?: boolean;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  liveTurn?: (base: string) => Promise<LiveTurnResult>;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  startDevServer?: (options: { root: string; statusUrl: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }) => Promise<{ ok: boolean; stop: () => void }>;
  e2bResolvable?: (root: string) => boolean;
}

type CheckStatus = "ok" | "broken" | "warning";
/** Agent-install DX (design 2026-07-19 §CLI-3) — every check carries a stable
 *  id; failures and warnings additionally carry the registry error_code and a
 *  full fix_ref URL. Passing checks carry neither: a pass has no failure mode
 *  to anchor, so agents filter `status !== "ok"` and follow fix_ref. */
interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  error_code?: DoctorErrorCode;
  fix_ref?: string;
}

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

async function hasDependency(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [manifest.dependencies, manifest.devDependencies].some((deps) =>
      deps?.["@vendoai/vendo"] !== undefined || deps?.vendoai !== undefined);
  } catch {
    return false;
  }
}

/** root rides in as the client's cwd: projectIdHash/packageManager and the
    .env.local cloud-key read attribute to the TARGET project, not the shell
    cwd. Seams in options.telemetry win. */
function telemetryFor(options: DoctorOptions, output: Output, root: string): Telemetry {
  return toolingTelemetry({ cwd: root, ...options.telemetry, log: (message) => output.log(message) });
}

interface DoctorProbeBody {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown };
}

async function probeBody(response: Response): Promise<DoctorProbeBody> {
  try {
    const body = await response.json() as unknown;
    return typeof body === "object" && body !== null ? body as DoctorProbeBody : {};
  } catch {
    return {};
  }
}

/** Doctor runs standalone, so unlike the dev server it gets no framework
 *  dotenv loading — without this, `VENDO_API_KEY` sitting in `.env.local`
 *  is invisible to the cloud/live-turn checks and users must export it by
 *  hand. Reads `.env` then `.env.local` (local wins); real process env wins
 *  over both at the merge site. Minimal KEY=VALUE parser: `export ` prefix,
 *  matching single/double quotes, and `#` comment lines. */
export async function readDotEnvFallback(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    const source = await readOptional(join(root, file));
    if (source === null) continue;
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      env[match[1]!] = normalizeDotEnvValue(match[2]!.trim());
    }
  }
  return env;
}

/** Process env wins over the dotenv fallback — except that a blank process
 *  value yields to a concrete dotenv one, matching toolingTelemetry's
 *  VENDO_API_KEY precedence (an exported empty `VENDO_API_KEY=` must not
 *  mask the real key in `.env.local`). */
export function mergeEnvOverDotEnv(
  fallback: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...fallback, ...processEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if ((value ?? "").trim() === "" && fallback[key] !== undefined) merged[key] = fallback[key];
  }
  return merged;
}

/** 09-vendo §5 / block-actions A — wiring checks plus live composition,
    present-credential, and actAs mint+verify round-trips. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  const env = options.env ?? mergeEnvOverDotEnv(await readDotEnvFallback(root), process.env);
  const telemetry = telemetryFor(options, output, root);
  let failures = 0;
  let warnings = 0;
  const checks: DoctorCheck[] = [];
  // In --json mode nothing but the final object may reach stdout; human lines
  // are suppressed and the same information rides the checks array instead.
  const note = (message: string): void => { if (!json) output.log(message); };
  // Human lines stay exactly as before (the fix_ref URL is a machine
  // affordance; --json is the agent surface, so no per-line URL noise here).
  const pass = (id: string, message: string): void => { checks.push({ id, status: "ok", message }); if (!json) output.log(`ok: ${message}`); };
  const fail = (id: string, code: DoctorErrorCode, message: string): void => { failures += 1; checks.push({ id, status: "broken", message, error_code: code, fix_ref: doctorFixRef(code) }); if (!json) output.error(`broken: ${message}`); };
  const warn = (id: string, code: DoctorErrorCode, message: string): void => { warnings += 1; checks.push({ id, status: "warning", message, error_code: code, fix_ref: doctorFixRef(code) }); if (!json) output.error(`warning: ${message}`); };

  const framework = await detectFramework(root);
  // The generated vendo/vendo-root.tsx wrapper carries the <VendoRoot> AND
  // <VendoOverlay /> markers itself, so an unexcluded scan would pass the
  // client/surface gates even when NO layout mounts the wrapper — the exact
  // doctor-green-but-invisible failure E-WIRE-006 exists to catch. Mirror
  // init's layout decision: exclude the wrapper from the scan, then let a
  // user-code <VendoRoot> mount next to an overlay-bearing wrapper satisfy
  // the surface (the wrapper renders the overlay once a layout mounts it).
  const wrapperCandidates = [
    join(root, "vendo", "vendo-root.tsx"),
    join(root, "src", "vendo", "vendo-root.tsx"),
  ];
  let wrapperWithOverlay = false;
  for (const candidate of wrapperCandidates) {
    const source = await readFile(candidate, "utf8").catch(() => null);
    if (source !== null && source.includes("<VendoOverlay")) wrapperWithOverlay = true;
  }
  const scanned = await detectVendoWiring(root, { exclude: wrapperCandidates });
  const wiring = { ...scanned, surface: scanned.surface || (scanned.client && wrapperWithOverlay) };
  if (framework === "unknown") {
    // No framework to pattern-match (field case: a Cloudflare Worker + Vite
    // host failed E-WIRE-003/004 forever) — judge the wiring by the same
    // bounded source scan init uses, never by another framework's file
    // layout. The surface check below still runs; it is source-generic.
    if (scanned.server) pass("wiring/server", "createVendo server wiring found");
    else fail("wiring/server", "E-WIRE-007", "no createVendo server wiring found — import createVendo from @vendoai/vendo/server and mount vendo.handler on your runtime's request entry");
    if (scanned.client) pass("wiring/client", "<VendoRoot> wraps the client");
    else warn("wiring/client", "E-WIRE-008", "no <VendoRoot> found in the host source — the @vendoai/ui hooks and embeds need it; ignore this if the host renders a fully custom surface");
  } else if (framework === "express") {
    if (wiring.server) pass("wiring/express-server", "Express server is wired");
    else fail("wiring/express-server", "E-WIRE-001", "Express server is not wired with createVendo from @vendoai/vendo/server");
    if (wiring.client) pass("wiring/express-client", "<VendoRoot> wraps the client");
    else fail("wiring/express-client", "E-WIRE-002", "Express client is not wrapped in <VendoRoot>");
  } else {
    const routeCandidates = [
      join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"),
    ];
    if ((await Promise.all(routeCandidates.map(exists))).some(Boolean)) pass("wiring/next-route", "catch-all handler is wired");
    else fail("wiring/next-route", "E-WIRE-003", "missing app/api/vendo/[...vendo]/route.ts");

    // The mount may live in ANY layout, not just the root one (i18n/route-group
    // hosts mount in e.g. app/[locale]/layout.tsx — the literal root-layout
    // grep fought exactly that correct wiring in the 0.4.1 E2E cert), and the
    // correct scaffold mounts the generated vendo/vendo-root.tsx wrapper —
    // whose export is also named VendoRoot, so the marker holds there too.
    let rootWired = false;
    for (const appDir of [join(root, "app"), join(root, "src", "app")]) {
      for (const path of await walk(appDir, (rel) => /(^|[\\/])layout\.(?:tsx|jsx|js)$/.test(rel))) {
        const source = await readFile(path, "utf8").catch(() => "");
        if (source.includes("<VendoRoot") || source.includes("<VendoProvider")) rootWired = true;
      }
    }
    if (rootWired) pass("wiring/next-root", "<VendoRoot> wraps the app");
    else fail("wiring/next-root", "E-WIRE-004", "no app layout mounts <VendoRoot> — wrap the app in the generated vendo/vendo-root.tsx wrapper (its export is also named VendoRoot), in the root layout or any layout that covers your pages");
  }

  // Visible surface (0.4.1 E2E cert B3): <VendoRoot> is a context provider
  // that renders NOTHING — two certified stacks ended doctor-green with no
  // way for a user to reach the agent. Green must mean visible.
  if (wiring.surface) {
    pass("wiring/surface", "a visible agent surface is mounted (<VendoOverlay /> or an equivalent)");
  } else {
    fail("wiring/surface", "E-WIRE-006", "no visible agent surface is mounted — <VendoRoot> renders nothing by itself; mount <VendoOverlay /> (init generates vendo/vendo-root.tsx for this), or render your own surface (<VendoThread />, <VendoToolResult>, the BYO embeds)");
  }

  if (await hasDependency(root)) pass("wiring/dependency", "@vendoai/vendo dependency is declared");
  else fail("wiring/dependency", "E-WIRE-005", "@vendoai/vendo (or vendoai alias) is not declared");

  // #478 short-term — @vendoai/vendo speaks AI SDK v6 to the host's `ai`
  // package (peer `ai >=6 <7`), but npm installs the peer conflict anyway:
  // the static checks all pass and every internal turn then throws
  // AI_InvalidPromptError (v7 removed system-role messages). Fail fast on the
  // installed major. An absent install is the wiring/turn checks' story, and
  // pre-v6 installs predate the peer contract — both skip silently.
  const aiVersion = await installedAiVersion(root);
  const aiMajor = aiVersion === null ? Number.NaN : Number.parseInt(aiVersion, 10);
  if (aiMajor >= 7) {
    fail("deps/ai-sdk-major", "E-DEP-001", `installed ai@${aiVersion} is unsupported — Vendo supports ai@6; downgrade (npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3) or track github.com/runvendo/vendo/issues/478`);
  } else if (aiMajor === 6) {
    pass("deps/ai-sdk-major", `installed ai@${aiVersion} is the supported AI SDK major (v6)`);
  }

  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
    if (await exists(join(root, ".vendo", file))) pass(`config/${file}`, `.vendo/${file}`);
    else fail(`config/${file}`, "E-CFG-001", `missing .vendo/${file}`);
  }
  if (!await exists(join(root, ".vendo", "data", ".gitignore"))) warn("config/data-gitignore", "E-CFG-002", ".vendo/data/.gitignore is missing");

  // The core promise, statically checkable: does the agent have any HOST
  // tool it may actually call? All-disabled is an explicit misconfiguration
  // (fail); an empty extraction is a strong warning — connector-only hosts
  // are legitimate, but a fresh install landing here means extraction found
  // nothing user-facing (field case: an infra product whose surface was all
  // internal endpoints ended with tools: [] and a silently useless agent).
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  const overridesRaw = await readOptional(join(root, ".vendo", "overrides.json"));
  if (toolsRaw !== null) {
    try {
      const toolsFile = toolsFileSchema.parse(JSON.parse(toolsRaw));
      let overridesTools: Record<string, { disabled?: boolean }> = {};
      if (overridesRaw !== null) {
        try {
          overridesTools = overridesFileSchema.parse(JSON.parse(overridesRaw)).tools;
        } catch {
          // Malformed overrides are their own (pre-existing) failure surface.
        }
      }
      const live = toolsFile.tools.filter((tool) => (overridesTools[tool.name]?.disabled ?? tool.disabled ?? false) !== true);
      if (toolsFile.tools.length === 0) {
        warn("tools/live-surface", "E-TOOLS-002", "the extracted tool surface is empty — the agent cannot act on this product's API; re-run `vendo init` extraction (or ignore if this deployment is connector-only)");
      } else if (live.length === 0) {
        fail("tools/live-surface", "E-TOOLS-001", `zero live host tools — all ${toolsFile.tools.length} extracted tools are disabled or excluded; review the audience exclusions in .vendo/overrides.json and re-enable the end-user surface (disabled: false)`);
      } else {
        pass("tools/live-surface", `${live.length} live host tool${live.length === 1 ? "" : "s"}`);
      }
    } catch {
      // Not the vendo/tools@1 shape (e.g. a placeholder {}) — the config
      // checks above already govern presence; nothing to grade here.
    }
  }

  // §4 customization ladder — ejected chrome drift. The ejected pixels are the
  // host's code, so a version gap is awareness (warn), never breakage (fail):
  // the hooks/wire dependency keeps working; only new presentation is missed.
  const installedUi = await readOptional(join(root, "node_modules", "@vendoai", "ui", "package.json"));
  let uiVersion: string | null = null;
  try {
    if (installedUi !== null) uiVersion = (JSON.parse(installedUi) as { version?: string }).version ?? null;
  } catch {
    // Malformed install metadata — skip the drift check rather than fail doctor.
  }
  if (uiVersion !== null) {
    for (const manifestPath of await walk(root, (rel) => rel.endsWith(EJECT_MANIFEST_FILE))) {
      let ejected: EjectedManifest;
      try {
        ejected = JSON.parse(await readFile(manifestPath, "utf8")) as EjectedManifest;
      } catch {
        continue;
      }
      if (ejected.version === uiVersion) {
        pass(`eject/${ejected.surface}`, `ejected ${ejected.surface} matches @vendoai/ui v${uiVersion}`);
      } else {
        warn(`eject/${ejected.surface}`, "E-UI-001", `ejected ${ejected.surface} came from @vendoai/ui v${ejected.version} but v${uiVersion} is installed — review the changelog (https://github.com/runvendo/vendo/releases) and \`vendo eject ${ejected.surface} --force\` if you want the new presentation`);
      }
    }
  }

  const statusUrl = options.url
    ?? env.VENDO_URL?.replace(/\/$/, "")
    ?? "http://localhost:3000/api/vendo";
  const fetchImpl = options.fetchImpl ?? fetch;

  // Consent-gated dev-server start (design §5): when nothing is listening on
  // the dev port and doctor is interactive, offer to boot it so the live probes
  // have something to reach. --yes is the documented non-interactive consent
  // (quickstart: "pass --yes to start it non-interactively"), so it bypasses
  // the TTY gate. Skipped in --json runs (stdout carries only the final object).
  const interactive = options.interactive ?? (Boolean(stdout.isTTY) && Boolean(stdin.isTTY));
  const confirm = options.confirm ?? askYesNo;
  let devServerStop: (() => void) | null = null;
  if (!json && (interactive || options.yes === true)) {
    let listening = false;
    try { listening = (await fetchImpl(`${statusUrl}/status`)).ok; } catch { listening = false; }
    if (!listening) {
      const go = options.yes === true
        || await confirm("Nothing is listening on the dev port. Start the dev server for the probe?", true);
      if (go) {
        note(`\nStarting the dev server so the probe has a live composition to reach…`);
        const start = options.startDevServer ?? startDevServerForProbe;
        const started = await start({ root, statusUrl, env, fetchImpl });
        if (started.ok) { devServerStop = started.stop; pass("dev/start", "started the dev server for the probe"); }
        else warn("dev/start", "E-DEV-001", "could not start the dev server for the probe; start it yourself (e.g. `npm run dev`) and re-run `vendo doctor`");
      }
    }
  }

  let mcpEnabled = false;
  let sandboxVenue: unknown;
  let liveComposition = false;
  try {
    const response = await fetchImpl(`${statusUrl}/status`, {
      headers: { accept: "application/json" },
    });
    const body = await response.json() as {
      posture?: unknown;
      version?: unknown;
      blocks?: { mcp?: unknown; sandbox?: unknown } | null;
    };
    if (!response.ok || typeof body.posture !== "string" || typeof body.version !== "string"
      || typeof body.blocks !== "object" || body.blocks === null) {
      fail("live/status", "E-LIVE-001", `/status returned an invalid composition response (${response.status})`);
    } else {
      pass("live/status", `/status live round-trip (${body.version}, ${body.posture})`);
      liveComposition = true;
      // Split-brain guard (0.4.2 re-run, invoify defect 13): a direct
      // @vendoai/vendo dependency pinned to an older range beats the vendoai
      // umbrella's for the APP import, so `npm install vendoai@latest` runs a
      // new CLI while /status silently serves the old runtime. Any CLI/wire
      // version disagreement — split-brain or just a dev server started
      // before the upgrade — means doctor is not certifying what users run.
      if (body.version === CLI_VERSION) {
        pass("deps/version-skew", `CLI and running wire agree on @vendoai/vendo ${CLI_VERSION}`);
      } else {
        fail("deps/version-skew", "E-DEP-002", `the running wire serves @vendoai/vendo ${body.version} but this CLI is ${CLI_VERSION} — likely a split-brain install (a direct @vendoai/vendo dependency pinned to an older range wins over the vendoai umbrella's). Fix: npm install @vendoai/vendo@${CLI_VERSION} (or remove the direct @vendoai/vendo dependency and reinstall), then restart the dev server and re-run doctor.`);
      }
      // 10-mcp §1 — the door flag lives under blocks.mcp.
      mcpEnabled = body.blocks.mcp === true;
      sandboxVenue = body.blocks.sandbox;
      if (sandboxVenue === "e2b") {
        // 0.4.4 defect C — "ok: execution venue: e2b" on a host that cannot
        // actually run e2b is a false blessing: the venue must be USABLE
        // (key set and SDK resolvable from this project), or every server-app
        // build dies in it instead of riding the Cloud sandbox.
        const keyPresent = typeof env.E2B_API_KEY === "string" && env.E2B_API_KEY.trim() !== "";
        const installed = (options.e2bResolvable ?? e2bResolvableFrom)(root);
        if (keyPresent && installed) {
          pass("live/venue", "execution venue: e2b");
        } else {
          const missing = [
            ...(keyPresent ? [] : ["E2B_API_KEY is not set"]),
            ...(installed ? [] : ["the e2b package does not resolve from this project"]),
          ].join(" and ");
          fail("live/venue", "E-LIVE-007", `the running wire selected the e2b execution venue but ${missing}; server-app builds will fail in an unusable sandbox. Fix: install the e2b package and set E2B_API_KEY, or remove E2B_API_KEY from the server env (with VENDO_API_KEY set, the managed Cloud sandbox takes over), then restart the dev server and re-run doctor`);
        }
      } else if (sandboxVenue === "cloud" || sandboxVenue === "custom") {
        pass("live/venue", `execution venue: ${sandboxVenue}`);
      } else if (sandboxVenue === false) {
        warn("live/venue", "E-LIVE-004", "install the e2b package and set E2B_API_KEY, or set VENDO_API_KEY for the managed Cloud sandbox, or pass sandbox: to createVendo; without one, server apps (rungs 2-4) return sandbox-unavailable");
      } else if (sandboxVenue === undefined) {
        // Older hosts predate blocks.sandbox — version skew, not a broken install.
        warn("live/venue", "E-LIVE-005", "host /status does not report an execution venue; upgrade @vendoai/vendo to enable the venue check");
      } else {
        fail("live/venue", "E-LIVE-003", "/status returned an invalid execution venue");
      }
    }
  } catch {
    fail("live/status", "E-LIVE-002", `/status is unreachable at ${statusUrl}/status — doctor expects the WIRE BASE (your app origin plus the mount path, e.g. http://localhost:3000/api/vendo); a bare site origin passed to --url is missing the /api/vendo part`);
  }

  // Render gate (0.4.1 E2E cert M3): a live wire proves nothing about the
  // PAGES — the certified invoify install had every page 500ing (registry
  // passed across the Server Component boundary) while doctor exited 0. One
  // cheap GET of the app root catches a site that is down for users.
  if (liveComposition) {
    try {
      const response = await fetchImpl(`${new URL(statusUrl).origin}/`, { headers: { accept: "text/html" } });
      if (response.status >= 500) {
        fail("live/render", "E-LIVE-006", `the app's root page returned ${response.status} — the site is crashing for users even though the wire answers (typical cause: the component registry imported in a Server Component layout; mount it via the generated vendo/vendo-root.tsx wrapper instead). Check the dev server log.`);
      } else {
        pass("live/render", `the app's root page renders (HTTP ${response.status})`);
      }
    } catch {
      // The wire answered but the origin root didn't resolve at all — hosts
      // that serve no page at / are not doctor's business; skip silently.
    }
  }

  if (!liveComposition) {
    fail("auth/present", "E-AUTH-003", `present credential probe cannot run; start the dev server at ${statusUrl} and retry`);
    fail("auth/act-as", "E-AUTH-006", `cannot probe actAs; start the dev server at ${statusUrl} and retry`);
  } else {
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
        pass("auth/present", "present credentials reach the host API");
      } else {
        fail("auth/present", "E-AUTH-001", "present credentials did not reach the host API; set VENDO_BASE_URL to the running host origin and restart the dev server");
      }
    } catch {
      fail("auth/present", "E-AUTH-002", `present credential probe is unreachable at ${statusUrl}/doctor/present; restart the dev server and verify VENDO_BASE_URL`);
    }

    try {
      const response = await fetchImpl(`${statusUrl}/doctor/act-as`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{}",
      });
      const body = await probeBody(response);
      if (response.ok && body.ok === true) {
        pass("auth/act-as", "actAs mint + host verification live round-trip");
      } else if (body.error?.code === "act-as-not-configured") {
        warn("auth/act-as", "E-AUTH-007", "actAs is not configured; pass createVendo({ actAs }) before enabling away host actions");
      } else {
        fail("auth/act-as", "E-AUTH-004", "actAs mint + host verification failed; check createVendo({ actAs }), its verifier middleware, and the host principal resolver");
      }
    } catch {
      fail("auth/act-as", "E-AUTH-005", `actAs probe is unreachable at ${statusUrl}/doctor/act-as; restart the dev server and check createVendo({ actAs })`);
    }
  }

  // 10-mcp §5 — when the door is open, verify both discovery documents resolve
  // and the server card parses. The metadata is path-inserted (RFC 9728 §3): a
  // door mounted at /api/vendo/mcp serves /.well-known/...-resource/api/vendo/mcp.
  if (mcpEnabled) {
    const origin = new URL(statusUrl).origin;
    const mountPath = `${new URL(statusUrl).pathname.replace(/\/$/, "")}/mcp`;
    const resolves = async (id: string, code: DoctorErrorCode, url: string, valid: (body: Record<string, unknown>) => boolean, label: string): Promise<void> => {
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" } });
        const body = await response.json() as Record<string, unknown>;
        if (response.ok && valid(body)) pass(id, label);
        else fail(id, code, `${label} (${response.status})`);
      } catch {
        fail(id, code, `${label} is unreachable`);
      }
    };
    await resolves(
      "mcp/protected-resource",
      "E-MCP-001",
      `${origin}/.well-known/oauth-protected-resource${mountPath}`,
      (body) => typeof body.resource === "string",
      "MCP protected-resource metadata resolves",
    );
    await resolves(
      "mcp/authorization-server",
      "E-MCP-002",
      `${origin}/.well-known/oauth-authorization-server${mountPath}`,
      (body) => typeof body.issuer === "string",
      "MCP authorization-server metadata resolves",
    );
    await resolves(
      "mcp/server-card",
      "E-MCP-003",
      `${origin}/.well-known/mcp/server-card.json`,
      (body) => typeof body.name === "string" && Array.isArray(body.transports),
      "MCP server card parses",
    );

    // 10-mcp §5 — the official registry artifact is optional until a host is
    // published, but once present it must describe this live door exactly.
    const serverJson = await readOptional(join(root, "server.json"));
    if (serverJson !== null) {
      try {
        const server = JSON.parse(serverJson) as unknown;
        const errors = validateRegistryServer(server);
        if (errors.length === 0) pass("mcp/server-json", "server.json matches MCP registry discovery requirements");
        else fail("mcp/server-json", "E-MCP-004", `server.json is invalid: ${errors.join("; ")}`);

        const liveDoorUrl = `${origin}${mountPath}`;
        if (remoteUrls(server).some((remote) => sameUrl(remote, liveDoorUrl))) {
          pass("mcp/server-json-remote", "server.json remote agrees with the live MCP door");
        } else {
          fail("mcp/server-json-remote", "E-MCP-005", `server.json remote does not match the live MCP door ${liveDoorUrl}`);
        }
      } catch {
        fail("mcp/server-json", "E-MCP-006", "server.json is invalid JSON");
      }
    }

    const localChallenge = await readOptional(join(root, "public", ".well-known", "mcp-registry-auth"));
    if (localChallenge !== null) {
      if (localChallenge.trim().startsWith("v=MCPv1")) pass("mcp/registry-auth-local", "local MCP registry auth challenge parses");
      else fail("mcp/registry-auth-local", "E-MCP-007", "local MCP registry auth challenge must start with v=MCPv1");
    }
    try {
      const response = await fetchImpl(`${origin}/.well-known/mcp-registry-auth`, {
        headers: { accept: "text/plain" },
      });
      if (response.ok) {
        const challenge = await response.text();
        if (challenge.trim().startsWith("v=MCPv1")) pass("mcp/registry-auth-live", "MCP registry auth challenge parses");
        else fail("mcp/registry-auth-live", "E-MCP-008", "MCP registry auth challenge must start with v=MCPv1");
      }
    } catch {
      // The HTTP proof is optional; DNS verification may be in use instead.
    }
  }

  // execution-v2 Lane D — machine + schedule REPORTING (no new subcommand):
  // which apps carry a machine, whether a schedule caller is configured for
  // the authenticated /tick surface, and each schedule's last-fired time.
  // /doctor/machines is a dev-only route, so an unreachable or older host
  // simply skips the section (reporting must never break doctor).
  if (liveComposition) {
    try {
      const response = await fetchImpl(`${statusUrl}/doctor/machines`, { headers: { accept: "application/json" } });
      if (response.ok) {
        const body = await response.json() as {
          scheduleCallerConfigured?: unknown;
          machines?: Array<{
            appId?: string;
            name?: string;
            awake?: boolean;
            schedules?: Array<{ cron?: string; fn?: string; lastFiredAt?: string; lastStatus?: string }>;
          }>;
        };
        const machines = Array.isArray(body.machines) ? body.machines : [];
        pass("machines/apps", machines.length === 0
          ? "no machine-bearing apps"
          : `${machines.length} machine-bearing app${machines.length === 1 ? "" : "s"}`);
        for (const machine of machines) {
          note(`  ${machine.appId ?? "?"} (${machine.name ?? "unnamed"}): ${machine.awake === true ? "awake" : "asleep"}`);
          for (const schedule of machine.schedules ?? []) {
            const lastFired = schedule.lastFiredAt === undefined
              ? "never fired"
              : `last fired ${schedule.lastFiredAt}${schedule.lastStatus === "error" ? " (error)" : ""}`;
            note(`    ${schedule.cron ?? "?"} -> POST /fn/${schedule.fn ?? "?"} — ${lastFired}`);
          }
        }
        const declaresSchedules = machines.some((machine) => (machine.schedules?.length ?? 0) > 0);
        if (body.scheduleCallerConfigured === true) {
          pass("machines/schedule-caller", "schedule caller configured (VENDO_TICK_SECRET); point an external cron at POST /api/vendo/tick");
        } else if (declaresSchedules) {
          warn("machines/schedule-caller", "E-SCHED-001", "apps declare vendo.json schedules but no schedule caller is configured — set VENDO_TICK_SECRET and point an external cron (Vercel cron, GitHub Actions, crontab) at POST /api/vendo/tick");
        } else if (machines.length > 0) {
          note("  no schedule caller configured (VENDO_TICK_SECRET unset) — needed once an app declares vendo.json schedules");
        }
      }
    } catch {
      // Reporting only — an unreachable machines route never fails doctor.
    }
  }

  note("Ladder: execution venue is checked above; actAs for away host actions; connectors for external tools.");

  // One real model turn through the wired route (design §5). Exit 0 == a user
  // would have gotten an answer. Reuses the resolver + devModel: the running
  // dev server serves the turn over the same credential doctor reports.
  let liveTurn: LiveTurnResult;
  if (liveComposition) {
    liveTurn = await (options.liveTurn ?? ((base: string) => liveModelTurn({
      base,
      fetchImpl,
      env,
    })))(statusUrl);
    if (liveTurn.ok) {
      pass("turn/model", `live model turn answered over ${liveTurn.credential} (${liveTurn.elapsedMs}ms)`);
      if (liveTurn.reply !== undefined) note(`\n  ${liveTurn.reply.trim()}\n`);
    } else {
      fail("turn/model", "E-TURN-001", `live model turn did not answer over ${liveTurn.credential}: ${liveTurn.error ?? "no reply"}`);
    }
  } else {
    liveTurn = { attempted: false, ok: false, rung: "none", credential: "n/a", elapsedMs: 0, error: "dev server unreachable" };
    fail("turn/model", "E-TURN-002", `live model turn cannot run; start the dev server at ${statusUrl} and retry`);
  }

  // VENDO_API_KEY local shape check + what Cloud unlocks (design §5-6). Key
  // problems surface on the first real service call — no validate round-trip.
  const cloud = await (options.cloudProbe ?? cloudDoctor)({ env });
  if (cloud.present && cloud.ok) {
    pass("cloud/key", "Vendo Cloud key present and well-formed");
  } else if (cloud.present) {
    warn("cloud/key", "E-CLOUD-001", `VENDO_API_KEY is set but not usable: ${cloud.error ?? "malformed"}`);
  } else {
    note(`Vendo Cloud (optional): no VENDO_API_KEY. A key unlocks ${cloud.unlocks.join("; ")}. Run \`vendo login\` to start.`);
  }

  if (devServerStop !== null) devServerStop();

  const wired = failures === 0;
  await telemetry.track("doctor_run", { failures, warnings, wired });

  if (json) {
    output.log(JSON.stringify({
      vendo: "doctor",
      version: CLI_VERSION,
      wired,
      exit: wired ? 0 : 1,
      checks,
      liveTurn,
      cloud,
      summary: { failures, warnings },
    }, null, 2));
  }
  return wired ? 0 : 1;
}
