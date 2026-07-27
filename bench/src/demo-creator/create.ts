import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DemoConfig } from "demo-template/demo-config";
import { injectDemoAuth } from "./inject-auth.js";
import {
  assertWorkspacePacksFresh,
  defaultDemoScratchDir,
  isStandaloneApp,
  pinWorkspaceDependencies,
  renderCloneDockerignore,
  renderClonePnpmWorkspace,
  renderCloneRailwayignore,
  vendorWorkspacePackages,
} from "./scratch.js";

/**
 * `demo:create` — the mechanical first stage of the demo-creator pipeline:
 * clone `apps/demo-template` into a per-prospect app directory, re-identify
 * it (package name + demo.config.json), and leave a RESEARCH/ pointer for the
 * evidence-gathering stage. Everything creative (rewriting the visible
 * product, real beats) is the creator agent's job afterwards, which is why
 * the template's sample beats are kept but fenced with a `TODO(creator): `
 * prefix — a lazy creator cannot ship them unnoticed, yet the skeleton still
 * parses against the template's own schema.
 *
 * Clones land OUTSIDE this checkout by default (`<os-tmp>/vendo-demos/`): a
 * generated demo is a prospect's brand, and while they lived in `apps/` one
 * `git add -A` published it in the OSS repo. `--target-dir apps` still works
 * for local poking (and is gitignored as a second line of defence); see
 * ./scratch.ts for what makes an out-of-repo clone self-contained.
 */

export interface DemoCreateArgs {
  /** Demo id — must satisfy the demo.config slug rule (validated via the template's own schema). */
  id: string;
  /** Display name of the prospect company. */
  prospect: string;
  /** Booking link shown in demo chrome. */
  ctaUrl: string;
  /** Directory that receives `demo-<id>/`; relative paths anchor at the repo
   * root, and the default is an absolute scratch dir outside it. */
  targetDir: string;
  /** The prospect's site, recorded in the RESEARCH stub for `demo:research`. */
  url?: string;
  /** Operator-provided product screenshots, copied into RESEARCH/ as
   * top-priority brand evidence (they often show logged-in screens a crawler
   * can't reach). */
  screenshots?: string[];
  /** Markdown file of operator instructions, copied into RESEARCH/ and inlined
   * into the brand brief + every agent prompt as AUTHORITATIVE. This is the
   * only way a fact the operator already established (a persona the product's
   * own screens show, a currency, a page title) survives the rewrite's
   * invent-everything default. */
  notes?: string;
}

export interface DemoCreateResult {
  appDir: string;
  packageName: string;
  configPath: string;
  researchReadme: string;
  /** The clone lives outside the repo, so it was made self-contained (this
   * tree's `@vendoai/*` vendored, plus its own pnpm-workspace/.dockerignore). */
  standalone: boolean;
}

/** Never carried into a clone: per-run state, installs, build output, and the
 * template's own verification evidence (plus turbo/tsc incremental caches). */
export const cloneExclusions = [
  ".vendo/data",
  "node_modules",
  ".next",
  "docs/verification",
  ".turbo",
  "tsconfig.tsbuildinfo",
  // Defensive: the template carries no env files today, but a future
  // .env.local with a real key must never be copied into generated demos.
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production.local",
] as const;

const defaultCtaUrl = "https://cal.com/yousefhelal";

const valueOptions = new Set(["--id", "--prospect", "--cta-url", "--target-dir", "--url", "--screenshots", "--notes"]);

/**
 * Fail-fast reachability probe (criterion 33) — runs at `demo:create` when a
 * --url is given, BEFORE anything touches disk, and again at the pipeline
 * entry. Reachable means "a live server answered at all": any HTTP status
 * below 500 passes (bot walls answer 403, some servers reject HEAD with 405 —
 * a challenge page still proves the site exists; the research stage deals
 * with junk evidence separately). HEAD first, then GET; network errors,
 * timeouts, and persistent 5xx are unreachable.
 */
export async function validateProspectUrl(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastFailure = "";
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetchImpl(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    }
  }
  throw new Error(`Prospect URL ${url} is unreachable (${lastFailure}) — nothing was created. Fix the URL and re-run.`);
}

function requireHttpUrl(option: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${option} must be an http(s) URL (received ${value})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${option} must be an http(s) URL (received ${value})`);
  }
  return value;
}

export function parseDemoCreateArgs(argv: string[]): DemoCreateArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  const id = options.get("--id");
  if (id === undefined) throw new Error("--id is required");
  const prospect = options.get("--prospect");
  if (prospect === undefined) throw new Error("--prospect is required");
  const url = options.get("--url");
  const rawScreenshots = options.get("--screenshots");
  let screenshots: string[] | undefined;
  if (rawScreenshots !== undefined) {
    screenshots = rawScreenshots.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (screenshots.length === 0) throw new Error("--screenshots needs at least one image path (comma-separated)");
  }
  const notes = options.get("--notes");
  return {
    id,
    prospect,
    ctaUrl: options.get("--cta-url") ?? defaultCtaUrl,
    targetDir: options.get("--target-dir") ?? defaultDemoScratchDir(),
    ...(url === undefined ? {} : { url: requireHttpUrl("--url", url) }),
    ...(screenshots === undefined ? {} : { screenshots }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/** Loaded lazily for the same reason as demo-capture's `configDemoHost`: the
 * demo-template/demo-config export resolves to TypeScript SOURCE that node
 * executes via type stripping (Node >= 23.6), while bench's engines floor is
 * >= 20 — only the demo-creator commands pay this cost. */
async function loadDemoConfigModule(): Promise<typeof import("demo-template/demo-config")> {
  try {
    return await import("demo-template/demo-config");
  } catch (error) {
    throw new Error(
      "demo:create needs Node >= 23.6 (native TypeScript type stripping) to load the template's own demo.config schema. "
      + `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function excludedFromClone(templateDir: string, source: string): boolean {
  const relative = path.relative(templateDir, source).split(path.sep).join("/");
  return cloneExclusions.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
}

/** Repo-root-relative when the app lives inside the repo (the documented
 * `--app apps/demo-<id>` shape); absolute for scratch targets outside it. */
export function displayAppPath(repoRoot: string, appDir: string): string {
  const relative = path.relative(repoRoot, appDir);
  return relative.startsWith("..") ? appDir : relative.split(path.sep).join("/");
}

/** One operator-supplied screenshot as indexed in RESEARCH/manifest.json —
 * top-priority brand evidence for the research + judge stages. */
export interface OperatorScreenshot {
  /** Saved name, relative to RESEARCH/ (e.g. "operator-1-board.png"). */
  file: string;
  provenance: "operator-provided";
  /** The path the operator passed to --screenshots. */
  source: string;
}

export const operatorManifestName = "manifest.json";

/** RESEARCH-relative name of the operator's instruction file (--notes). */
export const operatorNotesName = "OPERATOR-NOTES.md";

function researchStub(appPath: string, prospectUrl: string | undefined, screenshots: readonly OperatorScreenshot[]): string {
  const operatorSection = screenshots.length === 0 ? "" : `
Operator-provided screenshots (TOP-PRIORITY brand evidence — often logged-in
product screens a crawler can't reach; indexed in ${operatorManifestName}):

${screenshots.map((shot) => `- ${shot.file} (from ${shot.source})`).join("\n")}
`;
  return `# RESEARCH

Prospect brand evidence for the creator agent — screenshots, page metadata,
and a computed-style palette sample. Populate this directory with:

\`\`\`sh
pnpm --filter @vendoai/bench demo:research -- --app ${appPath} --url ${prospectUrl ?? "<prospect site>"}
\`\`\`
${operatorSection}
Prospect site: ${prospectUrl ?? "TODO(creator): record the prospect's site URL"}
`;
}

export async function runDemoCreate(args: DemoCreateArgs, options: { repoRoot: string; fetchImpl?: typeof fetch }): Promise<DemoCreateResult> {
  const templateDir = path.join(options.repoRoot, "apps", "demo-template");
  if (!existsSync(path.join(templateDir, "demo.config.json"))) {
    throw new Error(`demo:create clones apps/demo-template, but there is no demo.config.json in "${templateDir}"`);
  }

  // Validated up front, with the rest of the input checks: a typo'd path or a
  // dead prospect URL must fail the run before anything touches disk
  // (criterion 33: no app dir left behind). Creates WITHOUT --url stay
  // offline-capable (the CLI-compat pin).
  for (const screenshot of args.screenshots ?? []) {
    if (!existsSync(screenshot)) throw new Error(`--screenshots file not found: ${screenshot}`);
  }
  if (args.notes !== undefined && !existsSync(args.notes)) {
    throw new Error(`--notes file not found: ${args.notes}`);
  }
  if (args.url !== undefined) {
    await validateProspectUrl(args.url, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl });
  }

  const { parseDemoConfig } = await loadDemoConfigModule();
  const templateConfig = parseDemoConfig(
    JSON.parse(await readFile(path.join(templateDir, "demo.config.json"), "utf8")),
    `template demo config at "${path.join(templateDir, "demo.config.json")}"`,
  );

  // The template's sample beats stay as placeholders, TODO-fenced so a lazy
  // creator cannot ship them; the expectsView/expectsApproval declarations
  // are the verification contract and are kept verbatim. Re-parsing through
  // the template's own schema validates the --id slug (and everything else)
  // BEFORE anything touches disk, and guarantees the skeleton parses.
  const config: DemoConfig = parseDemoConfig({
    ...templateConfig,
    id: args.id,
    prospect: args.prospect,
    ctaUrl: args.ctaUrl,
    beats: templateConfig.beats.map((beat) => ({
      ...beat,
      prompt: `TODO(creator): ${beat.prompt}`,
      chip: `TODO(creator): ${beat.chip}`,
    })),
  }, `generated demo config for "${args.id}"`);

  const packageName = `demo-${args.id}`;
  const appDir = path.join(path.resolve(options.repoRoot, args.targetDir), packageName);
  if (existsSync(appDir)) {
    throw new Error(`Refusing to overwrite existing "${appDir}" — delete it first or pick another --id`);
  }

  // An out-of-repo clone is nobody's workspace member: its `workspace:*` deps
  // resolve to nothing, it inherits none of the root's pnpm settings, and its
  // deploy uploads itself rather than the monorepo. Make it self-contained.
  const standalone = isStandaloneApp(options.repoRoot, appDir);

  // Vendoring's precondition is checked with the other input validation, while
  // nothing exists on disk — a stale package must not abort a half-written
  // clone, because "refusing to overwrite" would then block the retry.
  if (standalone) await assertWorkspacePacksFresh(options.repoRoot);

  await mkdir(path.dirname(appDir), { recursive: true });
  await cp(templateDir, appDir, {
    recursive: true,
    filter: (source) => !excludedFromClone(templateDir, source),
  });

  // From here on the clone exists, so ANY failure has to take it with it:
  // whatever went wrong, a half-made prospect-branded directory must never
  // survive to block the next attempt with "refusing to overwrite".
  try {
    const packagePath = path.join(appDir, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    const identified = { ...packageJson, name: packageName };

    if (standalone) {
      const rootPackageJson = JSON.parse(
        await readFile(path.join(options.repoRoot, "package.json"), "utf8"),
      ) as { packageManager?: string };
      const vendorSpecs = await vendorWorkspacePackages({ repoRoot: options.repoRoot, appDir });
      const pinned = pinWorkspaceDependencies(identified, vendorSpecs, {
        ...(rootPackageJson.packageManager === undefined ? {} : { packageManager: rootPackageJson.packageManager }),
      });
      await writeFile(packagePath, `${JSON.stringify(pinned, null, 2)}\n`);
      await writeFile(
        path.join(appDir, "pnpm-workspace.yaml"),
        renderClonePnpmWorkspace(await readFile(path.join(options.repoRoot, "pnpm-workspace.yaml"), "utf8"), vendorSpecs),
      );
      await writeFile(path.join(appDir, ".dockerignore"), renderCloneDockerignore());
      await writeFile(path.join(appDir, ".railwayignore"), renderCloneRailwayignore());
    } else {
      await writeFile(packagePath, `${JSON.stringify(identified, null, 2)}\n`);
    }

    const configPath = path.join(appDir, "demo.config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // Every clone gets the demo login wall (criterion 37: the final gate LOGS
    // IN); the template itself stays anonymous by design and is never edited.
    await injectDemoAuth(appDir, { id: args.id, prospect: args.prospect });

    const appPath = displayAppPath(options.repoRoot, appDir);
    const researchDir = path.join(appDir, "RESEARCH");
    const researchReadme = path.join(researchDir, "README.md");
    await mkdir(researchDir, { recursive: true });

    const operatorScreenshots: OperatorScreenshot[] = [];
    for (const [index, source] of (args.screenshots ?? []).entries()) {
      const file = `operator-${index + 1}-${path.basename(source)}`;
      await cp(source, path.join(researchDir, file));
      operatorScreenshots.push({ file, provenance: "operator-provided", source });
    }
    if (args.notes !== undefined) {
      await cp(args.notes, path.join(researchDir, operatorNotesName));
    }
    if (operatorScreenshots.length > 0) {
      await writeFile(
        path.join(researchDir, operatorManifestName),
        `${JSON.stringify({ screenshots: operatorScreenshots }, null, 2)}\n`,
      );
    }

    await writeFile(researchReadme, researchStub(appPath, args.url, operatorScreenshots));

    return { appDir, packageName, configPath, researchReadme, standalone };
  } catch (error) {
    await rm(appDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
