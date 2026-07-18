import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Telemetry } from "@vendoai/telemetry";
import type { ResolveDevCredentialOptions } from "../dev-creds/resolve.js";
import {
  cloudDoctor,
  codexDrift,
  liveModelTurn,
  startDevServerForProbe,
  type CloudDoctorResult,
  type CodexDriftResult,
  type LiveTurnResult,
} from "./doctor-live.js";
import { detectFramework, detectVendoWiring } from "./framework.js";
import { remoteUrls, sameUrl, validateRegistryServer } from "./mcp/registry.js";
import { CLI_VERSION, consoleOutput, exists, readOptional, toolingTelemetry, type Output } from "./shared.js";

export interface DoctorOptions {
  targetDir: string;
  url?: string;
  fetchImpl?: typeof fetch;
  output?: Output;
  /** Machine-readable single-object output (design §5). */
  json?: boolean;
  /** Auto-confirm the dev-server-probe consent (non-interactive). */
  yes?: boolean;
  env?: Record<string, string | undefined>;
  probes?: ResolveDevCredentialOptions["probes"];
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
  /** Seams (tests): each new probe is injectable so doctor runs without keys,
   *  a running server, or the codex CLI. */
  interactive?: boolean;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  liveTurn?: (base: string) => Promise<LiveTurnResult>;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  startDevServer?: (options: { root: string; statusUrl: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }) => Promise<{ ok: boolean; stop: () => void }>;
  codexDriftProbe?: () => Promise<CodexDriftResult>;
}

type CheckStatus = "ok" | "broken" | "warning";
interface DoctorCheck { status: CheckStatus; message: string; }

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return ["y", "yes"].includes(answer);
  } finally {
    prompt.close();
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

function telemetryFor(options: DoctorOptions, output: Output): Telemetry {
  return toolingTelemetry({ ...options.telemetry, log: (message) => output.log(message) });
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

/** 09-vendo §5 / block-actions A — wiring checks plus live composition,
    present-credential, and actAs mint+verify round-trips. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  const env = options.env ?? process.env;
  const telemetry = telemetryFor(options, output);
  let failures = 0;
  let warnings = 0;
  const checks: DoctorCheck[] = [];
  // In --json mode nothing but the final object may reach stdout; human lines
  // are suppressed and the same information rides the checks array instead.
  const note = (message: string): void => { if (!json) output.log(message); };
  const pass = (message: string): void => { checks.push({ status: "ok", message }); if (!json) output.log(`ok: ${message}`); };
  const fail = (message: string): void => { failures += 1; checks.push({ status: "broken", message }); if (!json) output.error(`broken: ${message}`); };
  const warn = (message: string): void => { warnings += 1; checks.push({ status: "warning", message }); if (!json) output.error(`warning: ${message}`); };

  const framework = await detectFramework(root);
  if (framework === "express") {
    const wiring = await detectVendoWiring(root);
    if (wiring.server) pass("Express server is wired");
    else fail("Express server is not wired with createVendo from @vendoai/vendo/server");
    if (wiring.client) pass("<VendoRoot> wraps the client");
    else fail("Express client is not wrapped in <VendoRoot>");
  } else {
    const routeCandidates = [
      join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"),
    ];
    if ((await Promise.all(routeCandidates.map(exists))).some(Boolean)) pass("catch-all handler is wired");
    else fail("missing app/api/vendo/[...vendo]/route.ts");

    const layoutCandidates = [join(root, "app", "layout.tsx"), join(root, "src", "app", "layout.tsx")];
    let rootWired = false;
    for (const path of layoutCandidates) {
      try {
        if ((await readFile(path, "utf8")).includes("<VendoRoot")) rootWired = true;
      } catch {
        // Try the other layout convention.
      }
    }
    if (rootWired) pass("<VendoRoot> wraps the app");
    else fail("root layout is not wrapped in <VendoRoot>");
  }

  if (await hasDependency(root)) pass("@vendoai/vendo dependency is declared");
  else fail("@vendoai/vendo (or vendoai alias) is not declared");

  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
    if (await exists(join(root, ".vendo", file))) pass(`.vendo/${file}`);
    else fail(`missing .vendo/${file}`);
  }
  if (!await exists(join(root, ".vendo", "data", ".gitignore"))) warn(".vendo/data/.gitignore is missing");

  const statusUrl = options.url
    ?? env.VENDO_URL?.replace(/\/$/, "")
    ?? "http://localhost:3000/api/vendo";
  const fetchImpl = options.fetchImpl ?? fetch;

  // Consent-gated dev-server start (design §5): when nothing is listening on
  // the dev port and doctor is interactive, offer to boot it so the live probes
  // have something to reach. Skipped in --json and non-interactive runs.
  const interactive = options.interactive ?? (Boolean(stdout.isTTY) && Boolean(stdin.isTTY));
  const confirm = options.confirm ?? askYesNo;
  let devServerStop: (() => void) | null = null;
  if (!json && interactive) {
    let listening = false;
    try { listening = (await fetchImpl(`${statusUrl}/status`)).ok; } catch { listening = false; }
    if (!listening) {
      const go = options.yes === true
        || await confirm("Nothing is listening on the dev port. Start the dev server for the probe?", true);
      if (go) {
        note(`\nStarting the dev server so the probe has a live composition to reach…`);
        const start = options.startDevServer
          ?? ((o) => startDevServerForProbe(o));
        const started = await start({ root, statusUrl, env, fetchImpl });
        if (started.ok) { devServerStop = started.stop; pass("started the dev server for the probe"); }
        else warn("could not start the dev server for the probe; start it yourself (e.g. `npm run dev`) and re-run `vendo doctor`");
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
      fail(`/status returned an invalid composition response (${response.status})`);
    } else {
      pass(`/status live round-trip (${body.version}, ${body.posture})`);
      liveComposition = true;
      // 10-mcp §1 — the door flag lives under blocks.mcp.
      mcpEnabled = body.blocks.mcp === true;
      sandboxVenue = body.blocks.sandbox;
      if (sandboxVenue === "e2b" || sandboxVenue === "modal" || sandboxVenue === "cloud" || sandboxVenue === "custom") {
        pass(`execution venue: ${sandboxVenue}`);
      } else if (sandboxVenue === false) {
        warn("install the e2b package and set E2B_API_KEY, or install modal and set MODAL_TOKEN_ID+MODAL_TOKEN_SECRET, or set VENDO_API_KEY for the managed Cloud sandbox, or pass sandbox: to createVendo; without one, server apps (rungs 2-4) return sandbox-unavailable");
      } else if (sandboxVenue === undefined) {
        // Older hosts predate blocks.sandbox — version skew, not a broken install.
        warn("host /status does not report an execution venue; upgrade @vendoai/vendo to enable the venue check");
      } else {
        fail("/status returned an invalid execution venue");
      }
    }
  } catch {
    fail(`/status is unreachable at ${statusUrl}/status`);
  }

  if (!liveComposition) {
    fail(`present credential probe cannot run; start the dev server at ${statusUrl} and retry`);
    fail(`cannot probe actAs; start the dev server at ${statusUrl} and retry`);
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
        pass("present credentials reach the host API");
      } else {
        fail("present credentials did not reach the host API; set VENDO_BASE_URL to the running host origin and restart the dev server");
      }
    } catch {
      fail(`present credential probe is unreachable at ${statusUrl}/doctor/present; restart the dev server and verify VENDO_BASE_URL`);
    }

    try {
      const response = await fetchImpl(`${statusUrl}/doctor/act-as`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{}",
      });
      const body = await probeBody(response);
      if (response.ok && body.ok === true) {
        pass("actAs mint + host verification live round-trip");
      } else if (body.error?.code === "act-as-not-configured") {
        warn("actAs is not configured; pass createVendo({ actAs }) before enabling away host actions");
      } else {
        fail("actAs mint + host verification failed; check createVendo({ actAs }), its verifier middleware, and the host principal resolver");
      }
    } catch {
      fail(`actAs probe is unreachable at ${statusUrl}/doctor/act-as; restart the dev server and check createVendo({ actAs })`);
    }
  }

  // 10-mcp §5 — when the door is open, verify both discovery documents resolve
  // and the server card parses. The metadata is path-inserted (RFC 9728 §3): a
  // door mounted at /api/vendo/mcp serves /.well-known/...-resource/api/vendo/mcp.
  if (mcpEnabled) {
    const origin = new URL(statusUrl).origin;
    const mountPath = `${new URL(statusUrl).pathname.replace(/\/$/, "")}/mcp`;
    const resolves = async (url: string, valid: (body: Record<string, unknown>) => boolean, label: string): Promise<void> => {
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" } });
        const body = await response.json() as Record<string, unknown>;
        if (response.ok && valid(body)) pass(label);
        else fail(`${label} (${response.status})`);
      } catch {
        fail(`${label} is unreachable`);
      }
    };
    await resolves(
      `${origin}/.well-known/oauth-protected-resource${mountPath}`,
      (body) => typeof body.resource === "string",
      "MCP protected-resource metadata resolves",
    );
    await resolves(
      `${origin}/.well-known/oauth-authorization-server${mountPath}`,
      (body) => typeof body.issuer === "string",
      "MCP authorization-server metadata resolves",
    );
    await resolves(
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
        if (errors.length === 0) pass("server.json matches MCP registry discovery requirements");
        else fail(`server.json is invalid: ${errors.join("; ")}`);

        const liveDoorUrl = `${origin}${mountPath}`;
        if (remoteUrls(server).some((remote) => sameUrl(remote, liveDoorUrl))) {
          pass("server.json remote agrees with the live MCP door");
        } else {
          fail(`server.json remote does not match the live MCP door ${liveDoorUrl}`);
        }
      } catch {
        fail("server.json is invalid JSON");
      }
    }

    const localChallenge = await readOptional(join(root, "public", ".well-known", "mcp-registry-auth"));
    if (localChallenge !== null) {
      if (localChallenge.trim().startsWith("v=MCPv1")) pass("local MCP registry auth challenge parses");
      else fail("local MCP registry auth challenge must start with v=MCPv1");
    }
    try {
      const response = await fetchImpl(`${origin}/.well-known/mcp-registry-auth`, {
        headers: { accept: "text/plain" },
      });
      if (response.ok) {
        const challenge = await response.text();
        if (challenge.trim().startsWith("v=MCPv1")) pass("MCP registry auth challenge parses");
        else fail("MCP registry auth challenge must start with v=MCPv1");
      }
    } catch {
      // The HTTP proof is optional; DNS verification may be in use instead.
    }
  }

  note("Ladder: execution venue is checked above; actAs for away host actions; connectors for external tools.");

  // One real model turn through the wired route (design §5). Exit 0 == a user
  // would have gotten an answer. Reuses the wave-2 resolver + devModel: the
  // running dev server serves the turn over the same ladder doctor reports.
  let liveTurn: LiveTurnResult;
  if (liveComposition) {
    liveTurn = await (options.liveTurn ?? ((base: string) => liveModelTurn({
      base,
      fetchImpl,
      env,
      ...(options.probes === undefined ? {} : { probes: options.probes }),
    })))(statusUrl);
    if (liveTurn.ok) {
      pass(`live model turn answered over ${liveTurn.credential} (${liveTurn.elapsedMs}ms)`);
      if (liveTurn.reply !== undefined) note(`\n  ${liveTurn.reply.trim()}\n`);
    } else {
      fail(`live model turn did not answer over ${liveTurn.credential}: ${liveTurn.error ?? "no reply"}`);
    }
  } else {
    liveTurn = { attempted: false, ok: false, rung: "none", credential: "n/a", elapsedMs: 0, error: "dev server unreachable" };
    fail(`live model turn cannot run; start the dev server at ${statusUrl} and retry`);
  }

  // VENDO_API_KEY local shape check + what Cloud unlocks (design §5-6). Key
  // problems surface on the first real service call — no validate round-trip.
  const cloud = await (options.cloudProbe ?? ((o) => cloudDoctor(o)))({ env });
  if (cloud.present && cloud.ok) {
    pass("Vendo Cloud key present and well-formed");
  } else if (cloud.present) {
    warn(`VENDO_API_KEY is set but not usable: ${cloud.error ?? "malformed"}`);
  } else {
    note(`Vendo Cloud (optional): no VENDO_API_KEY. A key unlocks ${cloud.unlocks.join("; ")}. Run \`vendo cloud login\` to start.`);
  }

  // Codex app-server protocol-drift warning (dev-only, informational).
  const codex = await (options.codexDriftProbe ?? codexDrift)();
  if (codex.installed && codex.drifted) {
    warn(`codex ${codex.version} is off the tested ${codex.tested}.x line; the app-server tool-call surface may have drifted. Re-verify with \`codex app-server generate-ts\` before relying on the codex rung.`);
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
      codex,
      summary: { failures, warnings },
    }, null, 2));
  }
  return wired ? 0 : 1;
}
