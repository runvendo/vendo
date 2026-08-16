import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { installedVersion } from "./dep-versions.js";
import { detectFramework, detectVendoWiring, SUPABASE_PRESET_IMPORT, wiresSupabaseAuth, type VendoWiring } from "./framework.js";
import { vendoPackageInvocation } from "./provider-deps.js";
import { importsGeneratedMap, importsSplitComposition, missingRegistrations, registrationKey, requiredServerActions, serverActionsWiring } from "./init-scaffolds.js";
import { checkMcpBaseUrl } from "./doctor-mcp-checks.js";
import { SUPABASE_ENV_GUIDANCE, supabaseServerEnvSatisfied } from "./init-auth.js";
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
function checkGenericWiring(run: DoctorRun, wiring: VendoWiring): void {
  if (wiring.server) run.pass("wiring/server", "createVendo server wiring found");
  else run.fail("wiring/server", "E-WIRE-007", "no createVendo server wiring found — import createVendo from @vendoai/vendo/server and mount vendo.handler on your runtime's request entry");
  if (wiring.client) run.pass("wiring/client", "<VendoProvider> wraps the client");
  else run.warn("wiring/client", "E-WIRE-008", "no <VendoProvider> found in the host source — the @vendoai/ui hooks and embeds need it; ignore this if the host renders a fully custom surface");
}

function checkExpressWiring(run: DoctorRun, wiring: VendoWiring): void {
  if (wiring.server) run.pass("wiring/express-server", "Express server is wired");
  else run.fail("wiring/express-server", "E-WIRE-001", "Express server is not wired with createVendo from @vendoai/vendo/server");
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
  const { path: compositionPath, source } = await compositionOf(routePath);
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
  const mapPath = join(dirname(routePath), "vendo-actions.ts");
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

/** Which file holds this route's `createVendo({ … })`. The MCP path splits the
 *  composition into a sibling `vendo.ts` — a Next.js route module may export
 *  only route handlers, and the origin-root discovery route has to import the
 *  SAME instance — so a thin route.ts is WIRED, not unrecognized. Grading the
 *  thin file instead would go silent on a host that is correctly wired. */
async function compositionOf(routePath: string): Promise<{ path: string; source: string }> {
  const source = await readFile(routePath, "utf8").catch(() => "");
  if (!importsSplitComposition(source)) return { path: routePath, source };
  const split = join(dirname(routePath), "vendo.ts");
  const splitSource = await readOptional(split);
  return splitSource === null ? { path: routePath, source } : { path: split, source: splitSource };
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

async function checkNextWiring(run: DoctorRun): Promise<void> {
  const routePath = await nextRoutePath(run.root);
  if (routePath !== null) run.pass("wiring/next-route", "catch-all handler is wired");
  else run.fail("wiring/next-route", "E-WIRE-003", "missing app/api/vendo/[...vendo]/route.ts");
  if (routePath !== null) await checkServerActionsWiring(run, routePath);
  await checkProviderMount(run);
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
async function checkSupabasePresetEnv(run: DoctorRun): Promise<void> {
  const { root } = run;
  const routePath = await nextRoutePath(root);
  let wiresSupabase: boolean;
  if (routePath === null) {
    wiresSupabase = await wiresSupabaseAuth(root);
  } else {
    const { source } = await compositionOf(routePath);
    wiresSupabase = SUPABASE_PRESET_IMPORT.test(source) || /[^\w.]supabase\s*\(/.test(source);
  }
  if (!wiresSupabase) return;
  if (await supabaseServerEnvSatisfied(root, run.env)) {
    run.pass("wiring/supabase-env", "supabase() has a server-side session secret (SUPABASE_JWT_SECRET and/or SUPABASE_URL)");
  } else {
    run.warn("wiring/supabase-env", "E-AUTH-009",
      `${SUPABASE_ENV_GUIDANCE} Neither is set — the first signed-in turn fails loud until one lands in .env.local.`);
  }
}

/** The static half of doctor: is this host wired at all, does anything visible
 *  reach the agent, and is the dependency declared. No network. */
export async function checkWiring(run: DoctorRun): Promise<void> {
  const { root } = run;
  const framework = await detectFramework(root);
  const wiring = await detectVendoWiring(root);
  if (framework === "unknown") checkGenericWiring(run, wiring);
  else if (framework === "express") checkExpressWiring(run, wiring);
  else await checkNextWiring(run);

  // Visible surface (0.4.1 E2E cert B3): <VendoProvider> is a context provider
  // that renders NOTHING — two certified stacks ended doctor-green with no
  // way for a user to reach the agent. Green must mean visible.
  if (wiring.surface) {
    run.pass("wiring/surface", "a visible agent surface is mounted (<VendoOverlay /> or an equivalent)");
  } else {
    run.fail("wiring/surface", "E-WIRE-006", "no visible agent surface is mounted — <VendoProvider> renders nothing by itself; add <VendoOverlay /> (the launcher pill + panel) or render your own surface (<VendoThread />, <VendoToolResult>, the BYO embeds)");
  }

  await checkLegacyRoot(run, wiring.legacyRoot);
  // Static, so it fires on a project nobody has started yet — which is exactly
  // when a missing base URL is still cheap to fix.
  await checkMcpBaseUrl(run);
  await checkSupabasePresetEnv(run);

  if (await hasDependency(root)) run.pass("wiring/dependency", "@vendoai/vendo dependency is declared");
  else run.fail("wiring/dependency", "E-WIRE-005", "@vendoai/vendo (or vendoai alias) is not declared");
  await checkVendoResolvable(run);
}
