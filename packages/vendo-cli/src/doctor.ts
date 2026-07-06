/**
 * `vendo doctor` — deterministic health checks for a Vendo install. No LLM, no
 * network, and STRICTLY read-only: doctor never writes to the target app (or
 * anywhere else). Every check is a plain filesystem/env read, so its verdict is
 * reproducible and safe to run at any time.
 *
 * It groups its findings into: Keys (which provider key is set and the
 * capabilities it unlocks), Model (VENDO_MODEL/VENDO_CLI_MODEL override
 * sanity), Wiring (route handler, layout wrap, vendo-root, next.config
 * entries, sandbox assets, installed deps), .vendo state (theme/tools/component
 * counts), Storage (Postgres vs embedded PGlite), Scheduler (instrumentation
 * boot), and Telemetry.
 *
 * EXIT CODE CONTRACT (see each check's inline classification comment):
 *   - HARD FAILURE (contributes to exit 1) = the install won't work: no route
 *     handler / vendo-root, root layout not wrapped, a Vendo dependency not
 *     installed, next.config missing the required Vendo entries, or a model
 *     override that names an unknown provider WHILE a key is set (it would
 *     throw on the first chat request).
 *   - WARNING (exit 0) = degraded but functional: no provider key
 *     (deterministic-only), empty-fallback tools, missing/stale sandbox assets
 *     (chat still works, only generated UI degrades), no scheduler, a PGlite
 *     data dir not yet created, an unverifiable next.config/layout. Telemetry
 *     is purely informational.
 * Warnings never flip the exit code; only hard failures do.
 */
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { hasProviderKey, resolveModelChoice, type ModelProvider } from "@vendoai/server/model";
import { loadConfig, configPath } from "@vendoai/telemetry";
import { PROVIDER_ENV_VAR } from "./keys.js";
import { cliEnvForDir, parseEnvFile } from "./llm.js";
import { inspectVendoState } from "./state.js";
import { findAppDir, wrapLayoutChildren, mergeNextConfig, VENDO_TRANSPILE_PACKAGES } from "./next-wiring.js";
import { createUi, type Ui } from "./ui.js";

export interface DoctorOptions {
  targetDir: string;
  /** Injectable renderer (tests pass a capturing Ui). Defaults to a real one. */
  ui?: Ui;
  /** Home dir for the telemetry config read (tests inject a tmp dir). */
  home?: string;
  /** Environment for key/model/storage reads (tests inject a hermetic env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory holding the CLI's bundled sandbox assets, used to judge whether
   * the app's installed `public/vendo/*.js` are stale. Defaults to the build's
   * `./assets/` next to this module — which only exists in the bundled dist, so
   * unbuilt/test runs degrade to "freshness unverified" rather than guessing.
   * Tests inject a dir to exercise the stale/fresh branches deterministically.
   */
  bundledAssetsDir?: string;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function readFileOr(p: string, fallback: null = null): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return fallback;
  }
}

function present(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** First provider whose env var is set, in Anthropic > OpenAI > Google order. */
function detectProviderFromEnv(env: Record<string, string | undefined>): ModelProvider | null {
  for (const provider of ["anthropic", "openai", "google"] as const) {
    if (present(env[PROVIDER_ENV_VAR[provider]])) return provider;
  }
  return null;
}

/** Default location of the CLI's bundled sandbox assets (bundled dist only). */
function defaultBundledAssetsDir(): string {
  return fileURLToPath(new URL("./assets/", import.meta.url));
}

/** bundled file name in the CLI's assets dir -> installed name under public/vendo/. */
const SANDBOX_ASSETS: ReadonlyArray<readonly [bundled: string, installed: string]> = [
  ["vendo-react-runtime.js", "react-runtime.js"],
  ["vendo-components-sandbox.js", "components-sandbox.js"],
];

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const { targetDir } = opts;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const ui = opts.ui ?? createUi();
  const bundledAssetsDir = opts.bundledAssetsDir ?? defaultBundledAssetsDir();

  let hardFailed = false;
  const ok = (label: string, detail?: string): void => ui.step("ok", label, detail);
  const warn = (label: string, fix?: string): void => ui.step("warn", label, fix ? `fix: ${fix}` : undefined);
  const fail = (label: string, fix: string): void => {
    hardFailed = true;
    ui.error(label, fix);
  };
  const section = (title: string): void => ui.note(`\n${title}`);

  const appName = await readAppName(targetDir);
  ui.header("vendo doctor", appName ?? targetDir);

  const state = await inspectVendoState(targetDir);
  // The merged env view init/refresh use: real env overlaid on .env.local,
  // restricted to the provider keys + model overrides.
  const envView = await cliEnvForDir(targetDir, env as Record<string, string | undefined>);

  // ── Keys ──────────────────────────────────────────────────────────────────
  // Missing key = WARNING: deterministic checks/extraction still run, only the
  // LLM-assisted capabilities (chat, generated UI, assisted discovery) are off.
  section("Keys");
  const provider = detectProviderFromEnv(envView);
  if (provider) {
    ok(`provider key detected`, PROVIDER_ENV_VAR[provider]);
    ok("capabilities: chat, generated UI, tools/components/remix discovery");
  } else {
    warn("no provider key found", "set ANTHROPIC_API_KEY (or OPENAI_/GOOGLE_) in .env.local, or run `vendo init`");
    warn("capabilities: deterministic-only (chat, generated UI, assisted discovery disabled)");
  }

  // ── Model override ──────────────────────────────────────────────────────────
  // Unknown-provider override = HARD FAILURE when a key is set (resolveModel
  // would throw on the first request); a WARNING when no key is set (chat is
  // already off, so the broken override has no live effect yet).
  section("Model");
  const override = envView["VENDO_CLI_MODEL"]?.trim() || envView["VENDO_MODEL"]?.trim();
  if (!override) {
    if (provider) {
      const choice = resolveModelChoice(envView);
      ok("model override: none", choice.kind === "configured" ? `default ${choice.provider}/${choice.modelId}` : undefined);
    } else {
      ok("model override: none");
    }
  } else {
    try {
      const choice = resolveModelChoice({ ...envView, VENDO_MODEL: override });
      /* istanbul ignore next -- resolveModelChoice returns "configured" whenever VENDO_MODEL is set. */
      const resolved = choice.kind === "configured" ? `${choice.provider}/${choice.modelId}` : "none";
      ok(`model override: ${override}`, `resolves to ${resolved}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fixMsg = 'use "provider/model" with provider one of anthropic, openai, google (or a bare model id)';
      if (provider) fail(`model override invalid: ${reason}`, fixMsg);
      else warn(`model override invalid (no key set, so inactive): ${reason}`, fixMsg);
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  section("Wiring");
  // Route handler + vendo-root are the load-bearing files: without either, the
  // app cannot serve Vendo or mount the assistant → HARD FAILURE.
  if (state.wired.routeFile) ok("route handler: app/api/vendo/[...path]/route.*");
  else fail("route handler missing (app/api/vendo/[...path]/route.*)", "run `vendo init` to wire the API route");

  if (state.wired.rootFile) ok("vendo-root wrapper: vendo-root.*");
  else fail("vendo-root wrapper missing (app/vendo-root.*)", "run `vendo init` to generate the provider wrapper");

  // Layout wrap: an unwrapped {children} means the assistant never renders →
  // HARD FAILURE; a non-standard layout we can't read confidently = WARNING.
  const app = await findAppDir(targetDir);
  if (app) {
    const layoutSource = await readFileOr(app.layoutFile);
    if (layoutSource === null) {
      warn("root layout unreadable — cannot verify <AppVendoRoot> wrap", "ensure the layout wraps {children} with <AppVendoRoot>");
    } else {
      const wrapped = wrapLayoutChildren(layoutSource);
      if (wrapped === layoutSource) ok("root layout wraps <AppVendoRoot>");
      else if (wrapped === null) warn("cannot verify root layout wrap (non-standard {children})", "ensure {children} is wrapped with <AppVendoRoot>");
      else fail("root layout does not wrap {children} with <AppVendoRoot>", "run `vendo init`, or wrap {children} with <AppVendoRoot> by hand");
    }
  } else {
    warn("no App Router layout found — cannot verify layout wrap", "add app/layout.* (or src/app/layout.*) and run `vendo init`");
  }

  // next.config: transpilePackages + serverExternalPackages (PGlite) are
  // required for Vendo's packages to build → missing entries = HARD FAILURE; a
  // config we can't parse with certainty = WARNING (mergeNextConfig "skipped").
  await checkNextConfig(targetDir, { ok, warn, fail });

  // Sandbox assets: chat works without them (only generated UI degrades), so
  // any asset problem is a WARNING, never a hard failure.
  await checkSandboxAssets(targetDir, bundledAssetsDir, { ok, warn });

  // Dependencies: the wiring adds @vendoai/next + @electric-sql/pglite as
  // direct deps; an uninstalled one breaks the server → HARD FAILURE.
  await checkDeps(targetDir, { ok, fail });

  // ── .vendo state ────────────────────────────────────────────────────────────
  // All informational/degraded — never a hard failure.
  section(".vendo");
  if (state.theme.status === "real") ok("theme.json: customized");
  else if (state.theme.status === "default-stub") warn("theme.json: default stub (no brand extracted)", "edit .vendo/theme.json, or re-run `vendo init`");
  else warn("theme.json: missing", "run `vendo init` to generate it");

  if (state.tools.status === "real") {
    const count = await readToolCount(targetDir);
    ok("tools.json: host API tools", count === null ? undefined : `${count} tool${count === 1 ? "" : "s"}`);
  } else if (state.tools.status === "empty-fallback") {
    warn("tools.json: empty fallback (no host API tools)", "re-run `vendo init` to extract tools from your OpenAPI/routes");
  } else {
    warn("tools.json: missing", "run `vendo init`");
  }

  const componentCount = state.components.length;
  ok("components wrapped", `${componentCount}`);

  // ── Storage ─────────────────────────────────────────────────────────────────
  // DATABASE_URL → Postgres (ok); otherwise embedded PGlite. A not-yet-created
  // or unwritable data dir is a WARNING (created on first run / fixable), never
  // a hard failure.
  section("Storage");
  await checkStorage(targetDir, env as Record<string, string | undefined>, { ok, warn });

  // ── Scheduler ────────────────────────────────────────────────────────────────
  // Absent/unbooted scheduler = WARNING: automations won't run, but everything
  // else works.
  section("Scheduler");
  await checkScheduler(targetDir, env as Record<string, string | undefined>, { ok, warn });

  // ── Telemetry ────────────────────────────────────────────────────────────────
  // Purely informational — never affects the exit code.
  section("Telemetry");
  const telemetry = loadConfig(home);
  ok(`telemetry: ${telemetry.optedOut ? "disabled" : "enabled"}`, `anonymous; ${configPath(home)}`);

  return hardFailed ? 1 : 0;
}

async function readAppName(targetDir: string): Promise<string | null> {
  const raw = await readFileOr(path.join(targetDir, "package.json"));
  if (!raw) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

async function readToolCount(targetDir: string): Promise<number | null> {
  const raw = await readFileOr(path.join(targetDir, ".vendo/tools.json"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tools?: unknown };
    return Array.isArray(parsed.tools) ? parsed.tools.length : null;
  } catch {
    return null;
  }
}

interface Reporters {
  ok: (label: string, detail?: string) => void;
  warn: (label: string, fix?: string) => void;
  fail: (label: string, fix: string) => void;
}

async function checkNextConfig(targetDir: string, r: Pick<Reporters, "ok" | "warn" | "fail">): Promise<void> {
  const names = ["next.config.ts", "next.config.mjs", "next.config.js"];
  let configFile: string | null = null;
  for (const name of names) {
    if (await exists(path.join(targetDir, name))) {
      configFile = name;
      break;
    }
  }
  if (!configFile) {
    r.fail("next.config not found", "run `vendo init` to create next.config with the required Vendo entries");
    return;
  }
  const source = await readFileOr(path.join(targetDir, configFile));
  if (source === null) {
    r.warn(`${configFile}: unreadable — cannot verify Vendo entries`, "ensure transpilePackages + serverExternalPackages include the Vendo packages");
    return;
  }
  const merged = mergeNextConfig(source, configFile);
  if (merged.kind === "unchanged") {
    r.ok(`${configFile}: transpilePackages + PGlite externalization present`);
  } else if (merged.kind === "updated") {
    r.fail(
      `${configFile}: missing required Vendo entries`,
      `run \`vendo init\`, or add transpilePackages (${VENDO_TRANSPILE_PACKAGES.length} @vendoai/* packages) and serverExternalPackages: ["@electric-sql/pglite"]`,
    );
  } else {
    r.warn(`${configFile}: cannot verify Vendo entries (${merged.reason})`, "add the Vendo transpilePackages + serverExternalPackages entries by hand");
  }
}

async function checkSandboxAssets(
  targetDir: string,
  bundledAssetsDir: string,
  r: Pick<Reporters, "ok" | "warn">,
): Promise<void> {
  const publicDir = path.join(targetDir, "public/vendo");
  for (const [bundled, installed] of SANDBOX_ASSETS) {
    const installedPath = path.join(publicDir, installed);
    const installedBytes = await readFileBytes(installedPath);
    if (installedBytes === null) {
      r.warn(`sandbox asset public/vendo/${installed} missing`, "run `vendo init --force` to install the sandbox assets");
      continue;
    }
    const bundledBytes = await readFileBytes(path.join(bundledAssetsDir, bundled));
    if (bundledBytes === null) {
      // No reference to compare against (CLI running unbuilt / assets not
      // bundled) — degrade honestly rather than inventing a staleness verdict.
      r.ok(`sandbox asset public/vendo/${installed} present`, "freshness not verified");
    } else if (bundledBytes.equals(installedBytes)) {
      r.ok(`sandbox asset public/vendo/${installed} up to date`);
    } else {
      r.warn(`sandbox asset public/vendo/${installed} is stale vs this CLI build`, "run `vendo init --force` to refresh the sandbox assets");
    }
  }
}

async function readFileBytes(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

async function checkDeps(targetDir: string, r: Pick<Reporters, "ok" | "fail">): Promise<void> {
  const deps = ["@vendoai/next", "@electric-sql/pglite"] as const;
  for (const dep of deps) {
    // Presence of the package's own package.json is the resolution signal;
    // works whether node_modules holds a real copy or a workspace symlink.
    if (await exists(path.join(targetDir, "node_modules", dep, "package.json"))) {
      r.ok(`dependency installed: ${dep}`);
    } else {
      r.fail(`dependency not installed: ${dep}`, "run your package manager's install (npm/pnpm/yarn install)");
    }
  }
}

async function readEnvValue(
  targetDir: string,
  env: Record<string, string | undefined>,
  key: string,
): Promise<string | undefined> {
  // Real env wins over .env.local (dotenv/Next.js convention).
  if (present(env[key])) return env[key];
  const raw = await readFileOr(path.join(targetDir, ".env.local"));
  if (!raw) return undefined;
  const parsed = parseEnvFile(raw);
  return present(parsed[key]) ? parsed[key] : undefined;
}

async function checkStorage(
  targetDir: string,
  env: Record<string, string | undefined>,
  r: Pick<Reporters, "ok" | "warn">,
): Promise<void> {
  const databaseUrl = await readEnvValue(targetDir, env, "DATABASE_URL");
  if (present(databaseUrl)) {
    r.ok("storage: Postgres (DATABASE_URL set)");
    return;
  }
  const dataDirRel = (await readEnvValue(targetDir, env, "VENDO_DATA_DIR")) ?? ".vendo/data";
  const dataDir = path.isAbsolute(dataDirRel) ? dataDirRel : path.join(targetDir, dataDirRel);
  if (await exists(dataDir)) {
    if (await isWritable(dataDir)) r.ok(`storage: embedded PGlite (${dataDirRel})`);
    else r.warn(`storage: PGlite data dir not writable (${dataDirRel})`, "fix its permissions, or set VENDO_DATA_DIR / DATABASE_URL");
    return;
  }
  // Not yet created — fine as long as the parent can create it on first run.
  const parent = path.dirname(dataDir);
  if (await isWritable(parent)) {
    r.warn(`storage: embedded PGlite — data dir not created yet (${dataDirRel})`, "created automatically on first run; no action needed");
  } else {
    r.warn(`storage: PGlite data dir parent not writable (${dataDirRel})`, "fix permissions on its parent, or set VENDO_DATA_DIR / DATABASE_URL");
  }
}

async function isWritable(p: string): Promise<boolean> {
  return fs.access(p, fsConstants.W_OK).then(() => true, () => false);
}

async function checkScheduler(
  targetDir: string,
  env: Record<string, string | undefined>,
  r: Pick<Reporters, "ok" | "warn">,
): Promise<void> {
  // instrumentation.ts lives at the project root, or under src/ (Next.js
  // instrumentation-file convention) — check both, either extension.
  const candidates = [
    "instrumentation.ts",
    "instrumentation.js",
    "src/instrumentation.ts",
    "src/instrumentation.js",
  ];
  let source: string | null = null;
  let foundAt: string | null = null;
  for (const rel of candidates) {
    const s = await readFileOr(path.join(targetDir, rel));
    if (s !== null) {
      source = s;
      foundAt = rel;
      break;
    }
  }
  if (source === null) {
    r.warn("scheduler: not wired (no instrumentation.ts) — automations won't run", "run `vendo init` to add instrumentation.ts");
    return;
  }
  if (!source.includes("startVendoScheduler")) {
    r.warn(`scheduler: ${foundAt} does not boot the Vendo scheduler`, "merge startVendoScheduler() into register() (see instrumentation.vendo-example.*)");
    return;
  }
  if (present(env["VENDO_SCHEDULER"]) && env["VENDO_SCHEDULER"] === "external") {
    r.ok("scheduler: external (in-process timer disabled by VENDO_SCHEDULER=external)");
  } else {
    r.ok(`scheduler: in-process (${foundAt} boots startVendoScheduler)`);
  }
}
