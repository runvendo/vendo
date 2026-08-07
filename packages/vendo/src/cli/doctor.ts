import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import type { Telemetry } from "@vendoai/telemetry";
import {
  cloudDoctor,
  liveModelTurn,
  startDevServerForProbe,
  type CloudDoctorResult,
  type LiveTurnResult,
} from "./doctor-live.js";
import { installedAiVersion, installedZodVersion, isOlderVersion, npmLatestVersion } from "./dep-versions.js";
import { zodBelowAiSdkFloor, zodBumpInvocation } from "./provider-deps.js";
import { describeDevCredential, resolveDevCredential } from "../dev-creds/resolve.js";
// Relative (not the #dev-creds condition): the CLI is Node-only and the edge
// build deliberately does not export the pin map.
import { SLOT_PIN_ENV } from "../dev-creds/model.js";
import { DOCTOR_INFO_CODES, doctorFixRef, type DoctorErrorCode } from "./doctor-codes.js";
import { cloudMcpTenant, type EnsureTenantResult } from "../cloud-mcp.js";
import { publicBaseUrl } from "../mcp-broker-select.js";
import { EJECT_MANIFEST_FILE, type EjectedManifest } from "./eject.js";
import { applyJudgment, judgmentsFileSchema, overridesFileSchema, toolsFileSchema, type ToolJudgment } from "@vendoai/actions";
import { firstOpenApiSpec, openApiMountPath } from "@vendoai/actions/sync";
import { publicBase, type RiskLabel } from "@vendoai/core";
import { detectFramework, detectVendoWiring } from "./framework.js";
import { importsGeneratedMap, missingRegistrations, registrationKey, requiredServerActions, serverActionsWiring } from "./init-scaffolds.js";
import { CONFIG_SURFACES, OVERRIDES_ENABLEMENT_NOTE } from "../config-surface.js";
import { walk } from "./theme/walk.js";
import { remoteUrls, sameUrl, validateRegistryServer } from "./mcp/registry.js";
import { askYesNo, clientRoot, CLI_VERSION, consoleOutput, exists, readOptional, toolingTelemetry, type Output } from "./shared.js";
import { readEnvFiles } from "./sync-flow.js";

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
  /** The npm `latest` lookup behind the version-skew line — its own seam, not
      fetchImpl, so a scripted wire probe never doubles as a registry answer. */
  npmLatest?: () => Promise<string | null>;
  /** The broker ensure-tenant call behind the hosted-MCP line — its own seam
      for the same reason as npmLatest: it rides the Cloud console, not the
      probed wire. */
  ensureTenant?: (input: { baseUrl: string; mount: string }) => Promise<EnsureTenantResult>;
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

/** 09-vendo §5 / block-actions A — wiring checks plus live composition,
    present-credential, and actAs mint+verify round-trips. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  // The ONE env reader for the whole CLI (sync-flow.ts): doctor runs
  // standalone, so unlike the dev server it gets no framework dotenv loading —
  // without this, a VENDO_API_KEY sitting in `.env.local` is invisible to the
  // cloud and live-turn checks and users must export it by hand.
  const env = options.env ?? await readEnvFiles(root);
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
  const wiring = await detectVendoWiring(root);
  if (framework === "unknown") {
    // No framework to pattern-match (field case: a Cloudflare Worker + Vite
    // host failed E-WIRE-003/004 forever) — judge the wiring by the same
    // bounded source scan init uses, never by another framework's file
    // layout. The surface check below still runs; it is source-generic.
    if (wiring.server) pass("wiring/server", "createVendo server wiring found");
    else fail("wiring/server", "E-WIRE-007", "no createVendo server wiring found — import createVendo from @vendoai/vendo/server and mount vendo.handler on your runtime's request entry");
    if (wiring.client) pass("wiring/client", "<VendoProvider> wraps the client");
    else warn("wiring/client", "E-WIRE-008", "no <VendoProvider> found in the host source — the @vendoai/ui hooks and embeds need it; ignore this if the host renders a fully custom surface");
  } else if (framework === "express") {
    if (wiring.server) pass("wiring/express-server", "Express server is wired");
    else fail("wiring/express-server", "E-WIRE-001", "Express server is not wired with createVendo from @vendoai/vendo/server");
    if (wiring.client) pass("wiring/express-client", "<VendoProvider> wraps the client");
    else fail("wiring/express-client", "E-WIRE-002", "Express client is not wrapped in <VendoProvider>");
  } else {
    const routeCandidates = [
      join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"),
    ];
    const routePath = (await Promise.all(
      routeCandidates.map(async (candidate) => (await exists(candidate)) ? candidate : null),
    )).find((candidate) => candidate !== null) ?? null;
    if (routePath !== null) pass("wiring/next-route", "catch-all handler is wired");
    else fail("wiring/next-route", "E-WIRE-003", "missing app/api/vendo/[...vendo]/route.ts");

    // Server actions (ENG-248): init only ever CREATES, so a route or a
    // registration map that predates the host's `"use server"` surface stays
    // exactly as the developer left it — and every server-action tool then
    // fails closed at execution time with nothing else red. Doctor is where
    // that shows up. Every judgment below is the SAME one init makes, from the
    // same shared helpers: the two must never disagree about whether a host is
    // wired, or one of them is lying. Silent when the host has no live server
    // actions at all.
    const registrations = routePath === null ? [] : await requiredServerActions(root);
    if (routePath !== null && registrations.length > 0) {
      const routeSource = await readFile(routePath, "utf8").catch(() => "");
      const wiring = serverActionsWiring(routeSource);
      if (wiring === "unknown") {
        // No recognizable createVendo({ … }) — the same shape init declines to
        // name a paste for. Nothing honest to grade.
      } else if (wiring === "wired" && !importsGeneratedMap(routeSource)) {
        // The route passes a map it composes itself (a local object, an aliased
        // import). Init leaves that alone by design, and there is no generated
        // map to grade against — so doctor says nothing rather than guessing.
      } else {
        const mapPath = join(dirname(routePath), "vendo-actions.ts");
        const map = await readOptional(mapPath);
        const missing = map === null ? registrations : missingRegistrations(map, registrations);
        if (wiring === "wired" && missing.length === 0) {
          pass("wiring/server-actions", `${registrations.length} server action${registrations.length === 1 ? " is" : "s are"} registered and wired`);
        } else {
          fail("wiring/server-actions", "E-WIRE-009",
            `server actions fail closed — ${[
              ...(missing.length === 0 ? [] : [map === null
                ? `${relative(root, mapPath)} is missing`
                : `${relative(root, mapPath)} does not register ${missing.map(registrationKey).join(", ")}`]),
              // Scoped to the call on purpose: an import line alone is not
              // wiring, and it is exactly where a half-applied paste lands.
              ...(wiring === "unwired" ? [`${relative(root, routePath)} does not pass serverActions inside createVendo({ … })`] : []),
            ].join("; ")}. Re-run \`npx vendo init\`: it prints the exact paste for each (it never rewrites a file you already have).`);
        }
      }
    }

    // The mount may live in ANY layout, not just the root one (i18n/route-group
    // hosts mount in e.g. app/[locale]/layout.tsx — the literal root-layout
    // grep fought exactly that correct wiring in the 0.4.1 E2E cert).
    let rootWired = false;
    const mountCandidates = [
      ...await walk(join(root, "app"), (rel) => /(^|[\\/])layout\.(?:tsx|jsx|js)$/.test(rel)),
      ...await walk(join(root, "src", "app"), (rel) => /(^|[\\/])layout\.(?:tsx|jsx|js)$/.test(rel)),
      // A pages-only host has no layout to wrap: init hands it pages/_app, so
      // that is where the mount lives. Without this the check can never pass on
      // a router shape init explicitly supports.
      ...["pages", join("src", "pages")].flatMap((pages) =>
        ["_app.tsx", "_app.jsx", "_app.js"].map((file) => join(root, pages, file))),
    ];
    for (const path of mountCandidates) {
      const source = await readFile(path, "utf8").catch(() => "");
      if (source.includes("<VendoProvider")) rootWired = true;
    }
    if (rootWired) {
      pass("wiring/next-root", "<VendoProvider> wraps the app");
    } else {
      // The exact paste, not a description of it: init never edits user source,
      // so this is the one step a by-the-book install still owes, and doctor is
      // where a missed paste surfaces. `clientRoot` is init's own answer to
      // "which file", so the two can never name different files again.
      const { file: layoutPath, children } = await clientRoot(root);
      const file = relative(root, layoutPath);
      fail("wiring/next-root", "E-WIRE-004",
        `no client entry mounts <VendoProvider> — Vendo is wired but nothing on the page can reach it. In ${file}, paste: `
        + `import { VendoProvider } from "@vendoai/vendo/react";  … then wrap: <VendoProvider baseUrl="/api/vendo">${children}</VendoProvider>. `
        + "(Any layout that covers your pages works. `vendo init` never edits your source, so this paste is always yours.)");
    }
  }

  // Visible surface (0.4.1 E2E cert B3): <VendoProvider> is a context provider
  // that renders NOTHING — two certified stacks ended doctor-green with no
  // way for a user to reach the agent. Green must mean visible.
  if (wiring.surface) {
    pass("wiring/surface", "a visible agent surface is mounted (<VendoOverlay /> or an equivalent)");
  } else {
    fail("wiring/surface", "E-WIRE-006", "no visible agent surface is mounted — <VendoProvider> renders nothing by itself; add <VendoOverlay /> (the launcher pill + panel) or render your own surface (<VendoThread />, <VendoToolResult>, the BYO embeds)");
  }

  // VendoRoot is gone in this release (spec 2026-08-06 §B2). A host that still
  // names it, or still carries the wrapper init used to generate, gets the
  // three-line fix by name instead of a build error it has to decode.
  const legacyWrapper = (await Promise.all(
    [join(root, "vendo", "vendo-root.tsx"), join(root, "src", "vendo", "vendo-root.tsx")]
      .map(async (candidate) => (await exists(candidate)) ? candidate : null),
  )).find((candidate) => candidate !== null);
  if (legacyWrapper !== undefined || wiring.legacyRoot) {
    warn("wiring/vendo-root", "E-WIRE-010",
      `<VendoRoot> was removed — swap it for <VendoProvider baseUrl="/api/vendo">. `
      + (legacyWrapper === undefined ? "" : `${relative(root, legacyWrapper)} is YOUR file now: change its import to \`import { VendoProvider } from "@vendoai/vendo/react"\`, rename the tag, and add baseUrl. `)
      + "Nothing else moves — the props are identical.");
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

  // FINDINGS F2 — ai@6 imports the zod/v3 + zod/v4 subpaths that arrive in
  // zod 3.25; a host pinning older zod builds red inside ai the moment the
  // vendo wiring pulls it into the bundle. An absent zod skips silently: a
  // host without its own zod resolves ai's copy, which always satisfies.
  const zodVersion = await installedZodVersion(root);
  if (zodVersion !== null && zodBelowAiSdkFloor(zodVersion)) {
    fail("deps/zod-floor", "E-DEP-003", `installed zod@${zodVersion} predates the zod/v3 + zod/v4 subpaths the AI SDK imports (needs >=3.25) — the app build fails inside ai@6; bump within zod 3: ${await zodBumpInvocation(root)}`);
  } else if (zodVersion !== null) {
    pass("deps/zod-floor", `installed zod@${zodVersion} exposes the AI SDK's zod/v3 + zod/v4 subpaths (>=3.25)`);
  }

  // Self-serve audit F1 — npm release-cooldown configs (`min-release-age`)
  // resolve an old @vendoai/vendo silently, and Vendo ships often enough that
  // those users stay permanently behind with nothing ever saying so. A hint,
  // not a check: it has no fix_ref registry code and never changes the exit
  // code, and an unreachable registry says nothing at all. Skipped outright
  // under --json, so an agent run never pays for a lookup it cannot see.
  if (!json) {
    const latestPublished = await (options.npmLatest ?? (() => npmLatestVersion("@vendoai/vendo")))();
    if (latestPublished !== null && isOlderVersion(CLI_VERSION, latestPublished)) {
      output.error(`warning: installed @vendoai/vendo ${CLI_VERSION} is behind latest ${latestPublished} — npm install @vendoai/vendo@latest (release-cooldown npm configs like min-release-age resolve old versions silently)`);
    }
  }

  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
    if (await exists(join(root, ".vendo", file))) pass(`config/${file}`, `.vendo/${file}`);
    else fail(`config/${file}`, "E-CFG-001", `missing .vendo/${file}`);
  }
  if (!await exists(join(root, ".vendo", "data", ".gitignore"))) warn("config/data-gitignore", "E-CFG-002", ".vendo/data/.gitignore is missing");

  // Spec 2026-08-06 §B1 — the deployment's path prefix has exactly one home:
  // VENDO_BASE_URL. A spec that declares a DIFFERENT relative server mount is the
  // #914 shape by another route: every page renders and every tool call 404s.
  const specPath = await firstOpenApiSpec(root);
  const declaredMount = specPath === null ? "" : await openApiMountPath(specPath);
  const configuredBase = env["VENDO_BASE_URL"];
  if (declaredMount !== "" && configuredBase !== undefined && configuredBase.trim() !== "") {
    let basePath = "";
    try {
      basePath = publicBase(configuredBase).path;
    } catch {
      basePath = "";
    }
    if (basePath !== declaredMount) {
      fail("config/mount", "E-CFG-003",
        `${relative(root, specPath!)} declares servers[0].url ${JSON.stringify(declaredMount)} but VENDO_BASE_URL's path is `
        + `${JSON.stringify(basePath)} — one of them is wrong, and the disagreement 404s every host tool while every page renders. `
        + `Set VENDO_BASE_URL to the app's FULL public URL including ${JSON.stringify(declaredMount)}, or drop the relative server from the spec.`);
    } else {
      pass("config/mount", `the OpenAPI server mount and VENDO_BASE_URL agree on ${JSON.stringify(declaredMount)}`);
    }
  }

  // cse lane 3 — per-surface OWNERSHIP: for each cloud-resolvable content
  // surface, is the local file the source of truth, or is it resolved at
  // runtime (from hosted config when VENDO_API_KEY is set, else unset)? Local
  // only (no console call) — `vendo config status` does the cloud-aware view.
  // A programmatic `explicit` override in createVendo is not observable here.
  const surfaceOwners = await Promise.all(
    CONFIG_SURFACES.map(async (surface) => `${surface}=${(await exists(join(root, ".vendo", surface))) ? "file" : "runtime"}`),
  );
  pass("config/ownership", `surface ownership (file = local source of truth; runtime = resolved from hosted config or unset): ${surfaceOwners.join(", ")}. ${OVERRIDES_ENABLEMENT_NOTE}`);

  // Models spec 2026-07-22 — exactly two honest model facts, resolver-based
  // (the same resolver the runtime rides, no network): which credential rung
  // wins, and any active VENDO_MODEL_* pins. Deliberately NO role/alias
  // table: on the Cloud rung the family names map to concrete models
  // SERVER-SIDE, so the client would only be guessing.
  const modelCredential = await resolveDevCredential({ env });
  if (modelCredential.rung !== "none") {
    pass("model/credential", `model credential: ${describeDevCredential(modelCredential)}`);
  } else {
    note("model credential: none found — the live turn check below carries the honest failure");
  }
  const activePins = Object.values(SLOT_PIN_ENV)
    .map((name) => ({ name, value: env[name]?.trim() }))
    .filter((pin): pin is { name: string; value: string } => (pin.value ?? "").length > 0);
  if (activePins.length > 0) {
    pass("model/pins", `model pins: ${activePins.map(({ name, value }) => `${name}=${value}`).join(", ")}`);
  }

  // The core promise, statically checkable: does the agent have any HOST
  // tool it may actually call? All-disabled is an explicit misconfiguration
  // (fail); an empty extraction is a strong warning — connector-only hosts
  // are legitimate, but a fresh install landing here means extraction found
  // nothing user-facing (field case: an infra product whose surface was all
  // internal endpoints ended with tools: [] and a silently useless agent).
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  const overridesRaw = await readOptional(join(root, ".vendo", "overrides.json"));
  const judgmentsRaw = await readOptional(join(root, ".vendo", "judgments.json"));
  if (toolsRaw !== null) {
    try {
      const toolsParsed: unknown = JSON.parse(toolsRaw);
      const toolsFile = toolsFileSchema.parse(toolsParsed);
      let overridesTools: Record<string, { disabled?: boolean; risk?: RiskLabel }> = {};
      if (overridesRaw !== null) {
        try {
          const overridesParsed: unknown = JSON.parse(overridesRaw);
          overridesTools = overridesFileSchema.parse(overridesParsed).tools;
        } catch {
          // Malformed overrides are their own (pre-existing) failure surface.
        }
      }
      let judgments: Record<string, ToolJudgment> = {};
      if (judgmentsRaw !== null) {
        try {
          const judgmentsParsed: unknown = JSON.parse(judgmentsRaw);
          judgments = judgmentsFileSchema.parse(judgmentsParsed).tools;
        } catch {
          // Malformed judgments are the judgment pass's own loud failure; the
          // grade below reads the skeleton rather than guessing at the file.
        }
      }
      // The SAME three-layer stack the runtime resolves: skeleton ⊕ judgments ⊕
      // overrides. `applyJudgment` ignores an entry whose binding moved and
      // applies the fail-closed audience exclusion, so a disable this check
      // reports is one the agent will actually see. A human override still wins
      // last — including a deliberate wake of something a judgment disabled.
      const live = toolsFile.tools.filter((tool) => {
        const effective = applyJudgment(tool, judgments[tool.name]);
        return (overridesTools[tool.name]?.disabled ?? effective.disabled ?? false) !== true;
      });
      if (toolsFile.tools.length === 0) {
        warn("tools/live-surface", "E-TOOLS-002", "the extracted tool surface is empty — the agent cannot act on this product's API; re-run `vendo init` extraction (or ignore if this deployment is connector-only)");
      } else if (live.length === 0) {
        fail("tools/live-surface", "E-TOOLS-001", `zero live host tools — all ${toolsFile.tools.length} extracted tools are disabled or excluded; review the audience exclusions in .vendo/overrides.json and re-enable the end-user surface (disabled: false)`);
      } else {
        pass("tools/live-surface", `${live.length} live host tool${live.length === 1 ? "" : "s"}`);
      }
      // Risk-grading redesign D4 — not-knowing must be FELT. Extraction only
      // asserts protocol facts, so a catalog nobody has judged is mostly
      // `ungraded`, and every ungraded tool asks on each call. Counted over the
      // same three-layer effective stack, so a judged or overridden grade is
      // reflected here exactly as the guard will see it.
      const ungraded = toolsFile.tools.filter((tool) => {
        const effective = applyJudgment(tool, judgments[tool.name]);
        return (overridesTools[tool.name]?.risk ?? effective.risk) === "ungraded";
      });
      if (ungraded.length > 0) {
        warn("tools/graded", "E-TOOLS-003", `catalog: ${ungraded.length}/${toolsFile.tools.length} tools ungraded — each one asks on every call; run \`vendo sync\` with a model key to grade`);
      } else {
        pass("tools/graded", `catalog: all ${toolsFile.tools.length} tools graded`);
      }
      // Not-knowing must be FELT here too. A blind slot is not a failure — the
      // tool still works permissively — but it is why an agent pastes a whole
      // response into a card instead of binding two fields, and why it calls a
      // tool with no arguments when the handler wanted three.
      const blindInputs = toolsFile.tools
        .filter((tool) => (tool.inputSchemaSource ?? "unknown") === "unknown")
        .map((tool) => tool.name);
      const blindOutputs = toolsFile.tools
        .filter((tool) => (tool.outputSchemaSource ?? "unknown") === "unknown")
        .map((tool) => tool.name);
      const total = toolsFile.tools.length;
      const coverage = `inputs ${total - blindInputs.length}/${total} · outputs ${total - blindOutputs.length}/${total}`;
      if (blindInputs.length > 0 || blindOutputs.length > 0) {
        const blind = [...new Set([...blindInputs, ...blindOutputs])].sort();
        warn(
          "tools/schemas",
          "E-TOOLS-004",
          `catalog: ${coverage} — blind: ${blind.slice(0, 8).join(", ")}${blind.length > 8 ? ` +${blind.length - 8} more` : ""};`
          + " declare them in your OpenAPI/tRPC contract, or run `vendo sync` with a model key so the judge reads the handlers",
        );
      } else if (total > 0) {
        pass("tools/schemas", `catalog: ${coverage}`);
      }
    } catch {
      // Not a vendo/tools@3 shape (e.g. a placeholder {}) — the config
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

  let mcpPosture: "local" | "broker" | false = false;
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
      // 10-mcp §1 — the door flag lives under blocks.mcp. Since the broker
      // seam it is a posture ("local" | "broker" | false); older wires still
      // send a boolean (version skew), which predates the broker — "local".
      mcpPosture = body.blocks.mcp === "broker" ? "broker"
        : body.blocks.mcp === true || body.blocks.mcp === "local" ? "local"
        : false;
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
          // This reads doctor's OWN env and project root, not the server's, so
          // a live e2b venue failing here means the two disagree.
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
        fail("live/render", "E-LIVE-006", `the app's root page returned ${response.status} — the site is crashing for users even though the wire answers (typical cause: the component registry declared in a Server Component layout; move it into your own "use client" file with the provider). Check the dev server log.`);
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
      } else if (response.status === 404) {
        fail("auth/present", "E-AUTH-001", await probe404Message());
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
      } else if (response.status === 404) {
        fail("auth/act-as", "E-AUTH-004", await probe404Message());
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
  if (mcpPosture !== false) {
    const origin = new URL(statusUrl).origin;
    const mountPath = `${new URL(statusUrl).pathname.replace(/\/$/, "")}/mcp`;
    const resolves = async (id: string, code: DoctorErrorCode, url: string, valid: (body: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown> | null> => {
      let status: number | undefined;
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" } });
        status = response.status;
        const body = await response.json() as Record<string, unknown>;
        if (response.ok && valid(body)) { pass(id, label); return body; }
        fail(id, code, `${label} (${status})`);
      } catch {
        // A non-JSON error page still names its status; only a fetch that
        // never answered is "unreachable".
        if (status === undefined) fail(id, code, `${label} is unreachable`);
        else fail(id, code, `${label} (${status})`);
      }
      return null;
    };
    const resource = await resolves(
      "mcp/protected-resource",
      "E-MCP-001",
      `${origin}/.well-known/oauth-protected-resource${mountPath}`,
      (body) => typeof body.resource === "string",
      "MCP protected-resource metadata resolves",
    );
    if (mcpPosture === "broker") {
      // Remote-AS posture: the door deliberately 404s its own authorization-
      // server metadata — an external AS fronts it, named in the protected-
      // resource document (RFC 9728 §2). The contract still requires BOTH
      // documents to resolve (10-mcp §5), and the runtime fetches the
      // EXTERNAL issuer's metadata before it can verify a single token
      // (remote-as.ts) — so doctor must resolve that document, not re-read
      // the one it already validated.
      const servers = resource?.authorization_servers;
      const advertised = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] as string : undefined;
      const parses = (value: string): boolean => { try { new URL(value); return true; } catch { return false; } };
      if (advertised === undefined) {
        fail("mcp/authorization-server", "E-MCP-002", "MCP protected-resource metadata does not name the external authorization server fronting the door");
      } else if (!parses(advertised)) {
        fail("mcp/authorization-server", "E-MCP-002", `the advertised authorization server "${advertised}" is not a valid URL — the runtime cannot resolve its metadata`);
      } else {
        await resolves(
          "mcp/authorization-server",
          "E-MCP-002",
          `${advertised.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
          (body) => body.issuer === advertised,
          `MCP authorization-server metadata at ${advertised} resolves`,
        );
      }
    } else {
      await resolves(
        "mcp/authorization-server",
        "E-MCP-002",
        `${origin}/.well-known/oauth-authorization-server${mountPath}`,
        (body) => typeof body.issuer === "string",
        "MCP authorization-server metadata resolves",
      );
    }
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

  // Machine + schedule REPORTING (no new subcommand): which apps carry a
  // machine, what their manifests declare, and whether a schedule caller is
  // configured for the authenticated /tick surface. Declarations only — when a
  // schedule last ran is the automation's run records now, and printing "never
  // fired" from a payload that no longer carries last-fired state would be a
  // doctor telling you something untrue. /doctor/machines is a dev-only route,
  // so an unreachable or older host simply skips the section (reporting must
  // never break doctor).
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
            schedules?: Array<{ cron?: string; fn?: string }>;
          }>;
        };
        const machines = Array.isArray(body.machines) ? body.machines : [];
        pass("machines/apps", machines.length === 0
          ? "no machine-bearing apps"
          : `${machines.length} machine-bearing app${machines.length === 1 ? "" : "s"}`);
        for (const machine of machines) {
          note(`  ${machine.appId ?? "?"} (${machine.name ?? "unnamed"}): ${machine.awake === true ? "awake" : "asleep"}`);
          for (const schedule of machine.schedules ?? []) {
            note(`    ${schedule.cron ?? "?"} -> POST /fn/${schedule.fn ?? "?"}`);
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
  // would have gotten an answer. Reuses the resolver + vendoModel: the running
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

  // MCP broker seam (provisioning plan 2026-08-03): with a usable key and an
  // open door, doctor explains what the broker default does — the seam skips
  // the broker SILENTLY on a private base URL (the broker cannot forward
  // visitors to a laptop), so doctor is where that decision gets said. With a
  // public URL it resolves and prints the tenant the composition WOULD/did
  // front the door with; the ensure is idempotent — the very call boot makes.
  if (cloud.present && cloud.ok && mcpPosture !== false) {
    const brokerBase = publicBaseUrl(env["VENDO_BASE_URL"]);
    if (brokerBase === undefined) {
      // Informational, not a failure: nothing is broken — deploying to a
      // public URL is simply what arms the broker.
      note(`I-CLOUD-002: ${DOCTOR_INFO_CODES["I-CLOUD-002"]} — VENDO_BASE_URL is unset or private, so the door serves its own local OAuth surface for now`);
    } else {
      // Explicit-adapter precedence (the seam's rule): /status reports both
      // an explicit `mcp.remoteAs` and the Cloud-managed broker as "broker",
      // but only the Cloud-managed arm ever calls ensure — against an
      // explicitly configured AS the same POST could provision or repoint an
      // unrelated Cloud tenant. Read the composition's own selection off the
      // dev-only probe; anything but a confirmed "broker" skips the ensure.
      let selection: unknown;
      try {
        const probed = await fetchImpl(`${statusUrl}/doctor/mcp`, { headers: { accept: "application/json" } });
        if (probed.ok) selection = (await probed.json() as { selection?: unknown }).selection;
      } catch {
        // Unreachable probe — same conservative skip as an older wire below.
      }
      if (selection === "explicit") {
        note("hosted MCP broker: an explicit mcp.remoteAs fronts the door — the broker default does not apply, so doctor ensures no tenant");
      } else if (selection !== "broker") {
        note("hosted MCP broker: the composition did not report selecting the broker (older wire, or a probe the dev-only route cannot answer) — skipping the tenant ensure");
      } else {
        const ensure = options.ensureTenant ?? ((input: { baseUrl: string; mount: string }) =>
          cloudMcpTenant({
            apiKey: env["VENDO_API_KEY"] ?? "",
            ...(env["VENDO_CLOUD_URL"] === undefined ? {} : { baseUrl: env["VENDO_CLOUD_URL"] }),
          }).ensure(input));
        try {
          const { tenant } = await ensure({
            baseUrl: brokerBase,
            mount: `${new URL(statusUrl).pathname.replace(/\/$/, "")}/mcp`,
          });
          pass("cloud/mcp-broker", `hosted MCP broker tenant: ${tenant.issuer}${tenant.status === "disabled" ? " (disabled in the console — the broker refuses traffic)" : ""} — the door composes against it when deployed at ${brokerBase}`);
        } catch (error) {
          // Informational like the arm above: the composition itself degrades
          // to the local door on the same failure, loudly, at boot.
          note(`hosted MCP broker: the tenant could not be resolved (${error instanceof Error ? error.message : String(error)}) — the door falls back to its own local OAuth surface until the console answers`);
        }
      }
    }
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
