import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { installedVersion } from "./dep-versions.js";
import { CLERK_PRESET_IMPORT, composesOwnStore, detectFramework, detectVendoWiring, SUPABASE_PRESET_IMPORT, wiresClerkAuth, wiresSupabaseAuth, wiresTenantConnectors, type VendoWiring } from "./framework.js";
import { vendoPackageInvocation } from "./provider-deps.js";
import { compositionModulePath, importsGeneratedMap, importsSplitComposition, missingRegistrations, registrationKey, requiredServerActions, serverActionsWiring } from "./init-scaffolds.js";
import { readUseCase } from "./install-record.js";
import { checkMcpBaseUrl, checkMcpSignInKeys } from "./doctor-mcp-checks.js";
import { CLERK_ENV_GUIDANCE, clerkServerEnvSatisfied, SUPABASE_ENV_GUIDANCE, supabaseServerEnvSatisfied } from "./init-auth.js";
import type { DoctorRun } from "./doctor-report.js";
import { walk } from "./theme/walk.js";
import { clientRoot, exists, readOptional, stripBom } from "./shared.js";

async function hasDependency(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(stripBom(await readFile(join(root, "package.json"), "utf8"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [manifest.dependencies, manifest.devDependencies].some((deps) =>
      deps?.["@vendoai/vendo"] !== undefined || deps?.vendoai !== undefined);
  } catch {
    return false;
  }
}

/** No framework to pattern-match (field case: a Cloudflare Worker + Vite host
 *  failed E-WIRE-003/004 forever) — judge the wiring by the same bounded source
 *  scan init uses, never by another framework's file layout. The surface check
 *  in `checkWiring` still runs; it is source-generic. */
function checkGenericWiring(run: DoctorRun, wiring: VendoWiring, mountedUi: boolean): void {
  if (wiring.server) run.pass("wiring/server", "createVendo server wiring found");
  else run.fail("wiring/server", "E-WIRE-007", "no createVendo server wiring found — import createVendo from @vendoai/vendo/server and mount vendo.handler on your runtime's request entry");
  if (!mountedUi) return;
  if (wiring.client) run.pass("wiring/client", "<VendoProvider> wraps the client");
  else run.warn("wiring/client", "E-WIRE-008", "no <VendoProvider> found in the host source — the @vendoai/ui hooks and embeds need it; ignore this if the host renders a fully custom surface");
}

function checkExpressWiring(run: DoctorRun, wiring: VendoWiring, mountedUi: boolean): void {
  if (wiring.server) run.pass("wiring/express-server", "Express server is wired");
  else run.fail("wiring/express-server", "E-WIRE-001", "Express server is not wired with createVendo from @vendoai/vendo/server");
  if (!mountedUi) return;
  if (wiring.client) run.pass("wiring/express-client", "<VendoProvider> wraps the client");
  else run.fail("wiring/express-client", "E-WIRE-002", "Express client is not wrapped in <VendoProvider>");
}

async function nextRoutePath(root: string): Promise<string | null> {
  const routeCandidates = [
    join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
    join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"),
  ];
  return (await Promise.all(
    routeCandidates.map(async (candidate) => (await exists(candidate)) ? candidate : null),
  )).find((candidate) => candidate !== null) ?? null;
}

/** Server actions (ENG-248): init only ever CREATES, so a route or a
 *  registration map that predates the host's `"use server"` surface stays
 *  exactly as the developer left it — and every server-action tool then
 *  fails closed at execution time with nothing else red. Doctor is where
 *  that shows up. Every judgment below is the SAME one init makes, from the
 *  same shared helpers: the two must never disagree about whether a host is
 *  wired, or one of them is lying. Silent when the host has no live server
 *  actions at all. */
async function checkServerActionsWiring(run: DoctorRun, routePath: string): Promise<void> {
  const { root } = run;
  const registrations = await requiredServerActions(root);
  if (registrations.length === 0) return;
  const { path: compositionPath, source } = await compositionOf(root, routePath);
  const wiring = serverActionsWiring(source);
  if (wiring === "unknown") {
    // No recognizable createVendo({ … }) — the same shape init declines to
    // name a paste for. Nothing honest to grade.
    return;
  }
  if (wiring === "wired" && !importsGeneratedMap(source)) {
    // The route passes a map it composes itself (a local object, an aliased
    // import). Init leaves that alone by design, and there is no generated
    // map to grade against — so doctor says nothing rather than guessing.
    return;
  }
  // The map sits beside the composition that imports it (`./vendo-actions`),
  // which is where init writes it — the module for a current install, the route
  // itself for one that still composes inline.
  const mapPath = join(dirname(compositionPath), "vendo-actions.ts");
  const map = await readOptional(mapPath);
  const missing = map === null ? registrations : missingRegistrations(map, registrations);
  if (wiring === "wired" && missing.length === 0) {
    run.pass("wiring/server-actions", `${registrations.length} server action${registrations.length === 1 ? " is" : "s are"} registered and wired`);
  } else {
    run.fail("wiring/server-actions", "E-WIRE-009",
      `server actions fail closed — ${[
        ...(missing.length === 0 ? [] : [map === null
          ? `${relative(root, mapPath)} is missing`
          : `${relative(root, mapPath)} does not register ${missing.map(registrationKey).join(", ")}`]),
        // Scoped to the call on purpose: an import line alone is not
        // wiring, and it is exactly where a half-applied paste lands.
        ...(wiring === "unwired" ? [`${relative(root, compositionPath)} does not pass serverActions inside createVendo({ … })`] : []),
      ].join("; ")}. Re-run \`npx vendo init\`: it prints the exact paste for each (it never rewrites a file you already have).`);
  }
}

/** Which file holds this route's `createVendo({ … })`. Init splits it into a
 *  composition module — a Next.js route module may export only route handlers,
 *  and the discovery route and the host's own agent loop have to import the
 *  SAME instance — so a thin route.ts is WIRED, not unrecognized. Grading the
 *  thin file instead would go silent on a host that is correctly wired. Two
 *  candidates, because both shapes are in the field: `lib/vendo.ts` (what init
 *  writes) and the route's sibling `vendo.ts` (what earlier MCP installs got). */
async function compositionOf(root: string, routePath: string): Promise<{ path: string; source: string }> {
  const source = await readFile(routePath, "utf8").catch(() => "");
  if (!importsSplitComposition(source)) return { path: routePath, source };
  for (const split of [await compositionModulePath(root), join(dirname(routePath), "vendo.ts")]) {
    const splitSource = await readOptional(split);
    if (splitSource !== null) return { path: split, source: splitSource };
  }
  return { path: routePath, source };
}

/** The mount may live in ANY layout, not just the root one (i18n/route-group
 *  hosts mount in e.g. app/[locale]/layout.tsx — the literal root-layout grep
 *  fought exactly that correct wiring in the 0.4.1 E2E cert). */
async function checkProviderMount(run: DoctorRun): Promise<void> {
  const { root } = run;
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
    run.pass("wiring/next-root", "<VendoProvider> wraps the app");
  } else {
    // The exact paste, not a description of it: init never edits user source,
    // so this is the one step a by-the-book install still owes, and doctor is
    // where a missed paste surfaces. `clientRoot` is init's own answer to
    // "which file", so the two can never name different files again.
    const { file: layoutPath, children } = await clientRoot(root);
    const file = relative(root, layoutPath);
    run.fail("wiring/next-root", "E-WIRE-004",
      `no client entry mounts <VendoProvider> — Vendo is wired but nothing on the page can reach it. In ${file}, paste: `
      + `import { VendoProvider } from "@vendoai/vendo/react";  … then wrap: <VendoProvider baseUrl="/api/vendo">${children}</VendoProvider>. `
      + "(Any layout that covers your pages works. `vendo init` never edits your source, so this paste is always yours.)");
  }
}

async function checkNextWiring(run: DoctorRun, mountedUi: boolean): Promise<void> {
  const routePath = await nextRoutePath(run.root);
  if (routePath !== null) run.pass("wiring/next-route", "catch-all handler is wired");
  else run.fail("wiring/next-route", "E-WIRE-003", "missing app/api/vendo/[...vendo]/route.ts");
  if (routePath !== null) await checkServerActionsWiring(run, routePath);
  if (mountedUi) await checkProviderMount(run);
}

/** VendoRoot is gone in this release (spec 2026-08-06 §B2). A host that still
 *  names it, or still carries the wrapper init used to generate, gets the
 *  three-line fix by name instead of a build error it has to decode. */
async function checkLegacyRoot(run: DoctorRun, legacyRoot: boolean): Promise<void> {
  const { root } = run;
  const legacyWrapper = (await Promise.all(
    [join(root, "vendo", "vendo-root.tsx"), join(root, "src", "vendo", "vendo-root.tsx")]
      .map(async (candidate) => (await exists(candidate)) ? candidate : null),
  )).find((candidate) => candidate !== null);
  if (legacyWrapper !== undefined || legacyRoot) {
    run.warn("wiring/vendo-root", "E-WIRE-010",
      `<VendoRoot> was removed — swap it for <VendoProvider baseUrl="/api/vendo">. `
      + (legacyWrapper === undefined ? "" : `${relative(root, legacyWrapper)} is YOUR file now: change its import to \`import { VendoProvider } from "@vendoai/vendo/react"\`, rename the tag, and add baseUrl. `)
      + "Nothing else moves — the props are identical.");
  }
}

/** #1153: a declared dependency the host source cannot REACH. The `vendoai`
 *  alias keeps `@vendoai/vendo` inside its own nested resolution, and under
 *  pnpm's strict node_modules host source may only resolve its direct
 *  dependencies — so every `@vendoai/vendo/*` import in the wiring fails at
 *  compile time and the route answers Next's HTML error page. The live probes
 *  can only read that as "unreachable" (E-LIVE-002 / E-AUTH-002 named none of
 *  it), so the cause has to be named here, statically. Silent until the host
 *  has installed at all: an empty tree is the install story, not this one. */
async function checkVendoResolvable(run: DoctorRun): Promise<void> {
  const { root } = run;
  if (await installedVersion(root, "@vendoai/vendo") !== null) {
    run.pass("wiring/vendo-resolvable", "host source can resolve @vendoai/vendo");
  } else if (await installedVersion(root, "vendoai") !== null) {
    run.fail("wiring/vendo-resolvable", "E-WIRE-011",
      `the vendoai alias is installed but @vendoai/vendo is not resolvable from this app — the alias keeps its copy nested, so under pnpm every \`@vendoai/vendo/*\` import in your wiring fails to compile ("Module not found") and the route 500s before anything can run. Fix: ${await vendoPackageInvocation(root)} (keep the alias; both names ship the same wire).`);
  }
}

/** ENG-422 (field: expense.fyi): a composition wiring supabase() with neither
 *  server-side env name set passes every static check and then fails its FIRST
 *  signed-in turn — init detects the family from the NEXT_PUBLIC_* pair, but
 *  the preset verifies sessions with the server-side names. Same helper as
 *  init's advisory, so the two can never disagree. Warn, not fail: a host may
 *  keep production-only env outside the local files doctor can read.
 *  Discovery is framework-neutral (greptile on #1374 proved Express/custom
 *  hosts never reached this check): with a Next route we read its composition,
 *  where a bare `supabase()` call is trusted; anywhere else only the preset
 *  IMPORT is evidence — a bare call in arbitrary host source is the host's
 *  own Supabase client. */
const PRESET_ENV_CHECKS = [
  {
    id: "wiring/supabase-env",
    code: "E-AUTH-009",
    importMarker: SUPABASE_PRESET_IMPORT,
    bareCall: /[^\w.]supabase\s*\(/,
    wiresAnywhere: wiresSupabaseAuth,
    satisfied: supabaseServerEnvSatisfied,
    pass: "supabase() has a server-side session secret (SUPABASE_JWT_SECRET and/or SUPABASE_URL)",
    warn: () => `${SUPABASE_ENV_GUIDANCE} Neither is set — the first signed-in turn fails loud until one lands in .env.local.`,
  },
  {
    // #1338 — the same disease, third preset. The consequence differs: the
    // keyless clerk wire resolves signed-in users as ANONYMOUS (one loud
    // server warning), so nothing fails loud enough to send anyone here —
    // which makes the static warning the only early signpost.
    id: "wiring/clerk-env",
    code: "E-AUTH-010",
    importMarker: CLERK_PRESET_IMPORT,
    bareCall: /[^\w.]clerk\s*\(/,
    wiresAnywhere: wiresClerkAuth,
    satisfied: clerkServerEnvSatisfied,
    pass: "clerk() has a server-side verification key (CLERK_SECRET_KEY and/or CLERK_JWT_KEY)",
    warn: () => `${CLERK_ENV_GUIDANCE} Neither is set — signed-in users resolve as anonymous until one lands in .env.local.`,
  },
] as const;

async function checkPresetEnv(run: DoctorRun): Promise<void> {
  const { root } = run;
  const routePath = await nextRoutePath(root);
  const source = routePath === null ? null : (await compositionOf(root, routePath)).source;
  for (const check of PRESET_ENV_CHECKS) {
    // With a Next route we read its composition, where a bare call is trusted;
    // anywhere else only the preset IMPORT is evidence (both spellings — the
    // #1374/#1383 lessons baked into the table).
    const wires = source !== null
      ? check.importMarker.test(source) || check.bareCall.test(source)
      : await check.wiresAnywhere(root);
    if (!wires) continue;
    if (await check.satisfied(root, run.env)) run.pass(check.id, check.pass);
    else run.warn(check.id, check.code, check.warn());
  }
}

/** A tenant's pasted token is vaulted in the store's encrypted secrets, and the
 *  store keeps a secret encrypted or not at all: in production a keyless write
 *  is REFUSED (store/secrets.ts's `keyFor`), and in development it lands in the
 *  clear. So a host that registers tenant connectors with no key ships a feature
 *  whose every credentialed registration fails the moment it is deployed.
 *
 *  Static, like everything else doctor does: a source marker and two env names.
 *  It never opens the store and never dials a tenant's server — the registration
 *  rows live in a database doctor deliberately cannot reach (the CLI must not
 *  pull the store's engine module, checkStorePersistence's note), and connecting
 *  is `vendo.tenantConnectors.test`'s job, at runtime, where it belongs.
 *
 *  Cloud's hosted store holds the key server-side, so a keyed deployment is
 *  satisfied by the key alone — but ONLY when Cloud is really the store. An
 *  explicitly passed `createStore()` wins over VENDO_API_KEY (the adapter rule,
 *  compose-store.ts's `selectStore`), so reading the key as proof of a vault
 *  greened a deployment whose very next registration was refused. A check that
 *  passes a broken deployment is worse than no check, so the key only counts
 *  where nothing else claimed the seam. */
async function checkTenantConnectorVault(run: DoctorRun): Promise<void> {
  const { root, env } = run;
  if (!await wiresTenantConnectors(root)) return;
  // Deliberately the LOOSER `environment()` predicate composition uses, not the
  // trimmed one — doctor and runtime must agree on what counts as set.
  const ownKey = (env.VENDO_STORE_ENCRYPTION_KEY ?? "") !== "";
  const cloudStore = (env.VENDO_API_KEY ?? "") !== "" && !await composesOwnStore(root);
  if (ownKey || cloudStore) {
    run.pass("wiring/tenant-connector-vault",
      `tenant connector tokens have an encrypted vault to live in (${ownKey ? "VENDO_STORE_ENCRYPTION_KEY" : "the Cloud store"})`);
    return;
  }
  run.warn("wiring/tenant-connector-vault", "E-TENANT-001",
    "vendo.tenantConnectors is wired, but no store encryption key is set — a tenant's pasted token is stored in the "
    + "clear in development and REFUSED outright in production, so every registration carrying one fails on deploy. "
    + "Set VENDO_STORE_ENCRYPTION_KEY to a base64 32-byte key (openssl rand -base64 32)."
    + ((env.VENDO_API_KEY ?? "") === ""
      ? " Vendo Cloud's hosted store (VENDO_API_KEY) holds the key server-side instead."
      : " VENDO_API_KEY does not cover it here: this host passes its own createStore(), and an explicitly passed store wins."));
}

/** The static half of doctor: is this host wired at all, does anything visible
 *  reach the agent, and is the dependency declared. No network. */
export async function checkWiring(run: DoctorRun): Promise<void> {
  const { root } = run;
  const framework = await detectFramework(root);
  const wiring = await detectVendoWiring(root);
  // The install's own answer to "how will people reach the agent?" (init writes
  // it to .vendo/install.json). An agent-loop or MCP install mounts no Vendo UI
  // by design, so grading the provider and the visible surface fails a host
  // that is correct by construction — the shape that made doctor unusable as a
  // gate for exactly those two paths. An install with no recorded answer is an
  // old one: grade it exactly as before.
  const useCase = await readUseCase(root);
  const mountedUi = useCase !== "agent-loop" && useCase !== "mcp";
  if (!mountedUi) {
    run.pass("wiring/use-case", `use case ${useCase} — the mounted-UI checks (<VendoProvider>, a visible surface) do not apply: this install reaches the agent through ${useCase === "mcp" ? "the MCP door" : "your own agent loop"}`);
  }
  if (framework === "unknown") checkGenericWiring(run, wiring, mountedUi);
  else if (framework === "express") checkExpressWiring(run, wiring, mountedUi);
  else await checkNextWiring(run, mountedUi);

  // Visible surface (0.4.1 E2E cert B3): <VendoProvider> is a context provider
  // that renders NOTHING — two certified stacks ended doctor-green with no
  // way for a user to reach the agent. Green must mean visible.
  if (mountedUi) {
    if (wiring.surface) run.pass("wiring/surface", "a visible agent surface is mounted (<VendoOverlay /> or an equivalent)");
    else run.fail("wiring/surface", "E-WIRE-006", "no visible agent surface is mounted — <VendoProvider> renders nothing by itself; add <VendoOverlay /> (the conversation panel) or render your own surface (<VendoThread />, <VendoToolResult>, the BYO embeds)");
  }

  await checkLegacyRoot(run, wiring.legacyRoot);
  // Static, so it fires on a project nobody has started yet — which is exactly
  // when a missing base URL is still cheap to fix.
  await checkMcpBaseUrl(run);
  await checkMcpSignInKeys(run);
  await checkPresetEnv(run);
  await checkTenantConnectorVault(run);

  if (await hasDependency(root)) run.pass("wiring/dependency", "@vendoai/vendo dependency is declared");
  else run.fail("wiring/dependency", "E-WIRE-005", "@vendoai/vendo (or vendoai alias) is not declared");
  await checkVendoResolvable(run);
}
