import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Install-eval fixtures: real host apps copied to a clean directory with the
 * Vendo footprint stripped — no `.vendo/` contract, no vendoai/@vendoai
 * dependency, no lockfile, no vendor tarballs, no agent-config files — so a
 * headless coding agent starts from what a real pre-Vendo repo looks like.
 *
 * KNOWN LIMIT (documented on purpose): the demo apps' SOURCE still imports
 * Vendo (layout wiring, vendo/ server files) because de-integrating the app
 * code would be a hand-maintained fork. The fixture therefore measures
 * "restore a working install from a repo whose deps and contract are gone",
 * which exercises the same playbook loop (install → init → hand-wire →
 * doctor) with a head start on wiring. express-host is closest to a truly
 * pre-Vendo host; treat demo rows accordingly in the report.
 */

export interface InstallEvalFixture {
  name: string;
  /** Repo-root-relative source directory. */
  sourcePath: string;
  devServer: {
    command: string;
    readinessUrl: string;
    env?: Record<string, string>;
    readinessTimeoutMs?: number;
  };
  doctorUrl: string;
}

export const INSTALL_EVAL_FIXTURES: readonly InstallEvalFixture[] = [
  {
    name: "express-host",
    sourcePath: "corpus/hosts/express-host",
    devServer: {
      command: "npm run dev",
      readinessUrl: "http://127.0.0.1:3210",
      env: { PORT: "3210", VENDO_BASE_URL: "http://127.0.0.1:3210" },
    },
    doctorUrl: "http://127.0.0.1:3210/api/vendo",
  },
  {
    name: "demo-bank",
    sourcePath: "apps/demo-bank",
    devServer: {
      command: "npm run dev",
      readinessUrl: "http://127.0.0.1:3000",
      readinessTimeoutMs: 180_000,
    },
    doctorUrl: "http://127.0.0.1:3000/api/vendo",
  },
  {
    name: "demo-accounting",
    sourcePath: "apps/demo-accounting",
    devServer: {
      command: "npm run dev",
      readinessUrl: "http://127.0.0.1:3000",
      readinessTimeoutMs: 180_000,
    },
    doctorUrl: "http://127.0.0.1:3000/api/vendo",
  },
];

export function selectFixtures(names: readonly string[]): InstallEvalFixture[] {
  if (names.length === 0) return [...INSTALL_EVAL_FIXTURES];
  const byName = new Map(INSTALL_EVAL_FIXTURES.map((fixture) => [fixture.name, fixture]));
  return names.map((name) => {
    const fixture = byName.get(name);
    if (!fixture) {
      throw new Error(
        `Unknown install-eval fixture "${name}". Known fixtures: ${INSTALL_EVAL_FIXTURES.map((entry) => entry.name).join(", ")}`,
      );
    }
    return fixture;
  });
}

/** Directory/file names never copied into a fixture. Beyond build output,
 * the agent-config files (CLAUDE.md/AGENTS.md/.claude) go too: a clean host
 * repo would not ship Vendo-flavored agent instructions, and leaving them in
 * would leak monorepo context into the eval. */
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "vendor",
  ".vendo",
  ".git",
  ".claude",
]);
const EXCLUDED_ROOT_FILES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVendoPackageName(name: string): boolean {
  return name === "vendoai" || name.startsWith("@vendoai/");
}

function isVendoSelector(name: string): boolean {
  return name === "vendoai" || name.startsWith("vendoai@") || name.startsWith("@vendoai/");
}

function stripVendoEntries(record: unknown): Record<string, unknown> | undefined {
  if (!isRecord(record)) return undefined;
  const kept = Object.entries(record).filter(([name]) => !isVendoSelector(name) && !isVendoPackageName(name));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** Strip every Vendo dependency, override, and resolution from a fixture
 * package.json — the agent must add the dependency itself. */
export function stripVendoFromPackageJson(source: string): string {
  const pkg = JSON.parse(source) as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    const stripped = stripVendoEntries(pkg[section]);
    if (stripped === undefined) delete pkg[section];
    else pkg[section] = stripped;
  }
  if (isRecord(pkg["pnpm"])) {
    const pnpm = { ...pkg["pnpm"] };
    const overrides = stripVendoEntries(pnpm["overrides"]);
    if (overrides === undefined) delete pnpm["overrides"];
    else pnpm["overrides"] = overrides;
    if (Object.keys(pnpm).length === 0) delete pkg["pnpm"];
    else pkg["pnpm"] = pnpm;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkedGit(args: readonly string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr || result.stdout}`);
  }
}

export interface PrepareFixtureOptions {
  fixture: InstallEvalFixture;
  workspaceRoot: string;
  /** Parent directory the fixture copy is created under (wiped per fixture). */
  fixturesRoot: string;
  /** Local registry URL written into the fixture .npmrc. */
  registryUrl: string;
}

/** Copy the fixture source to a clean directory, strip the Vendo footprint,
 * point npm at the local registry, and snapshot it as a one-commit git repo
 * (same trick as the corpus localPath checkout) so the agent's edits are
 * diffable afterwards. */
export async function prepareFixture(options: PrepareFixtureOptions): Promise<string> {
  const sourceDir = path.resolve(options.workspaceRoot, options.fixture.sourcePath);
  const fixtureDir = path.join(options.fixturesRoot, options.fixture.name);
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(path.dirname(fixtureDir), { recursive: true });

  await cp(sourceDir, fixtureDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceDir, source);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
      return !(segments.length === 1 && EXCLUDED_ROOT_FILES.has(segments[0]!));
    },
  });

  const packageJsonPath = path.join(fixtureDir, "package.json");
  await writeFile(packageJsonPath, stripVendoFromPackageJson(await readFile(packageJsonPath, "utf8")));
  await writeFile(path.join(fixtureDir, ".npmrc"), `registry=${options.registryUrl}/\n`);

  await checkedGit(["init"], fixtureDir);
  await checkedGit(["add", "-A"], fixtureDir);
  await checkedGit([
    "-c", "user.name=Vendo Install Eval",
    "-c", "user.email=install-eval@vendo.local",
    "commit", "-m", "Clean fixture snapshot (pre-agent)",
  ], fixtureDir);

  return fixtureDir;
}

/** Final repo state the scorer needs: generated tool names vs names the
 * overrides/policy files reference. Missing files read as empty — a run that
 * never produced a contract simply has nothing to cross-reference. */
export async function readFinalToolState(fixtureDir: string): Promise<{ toolNames: string[]; referencedToolNames: string[] }> {
  const readJson = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path.join(fixtureDir, ".vendo", file), "utf8")) as unknown;
    } catch {
      return null;
    }
  };

  const toolNames: string[] = [];
  const tools = await readJson("tools.json");
  if (isRecord(tools) && Array.isArray(tools["tools"])) {
    for (const tool of tools["tools"]) {
      if (isRecord(tool) && typeof tool["name"] === "string") toolNames.push(tool["name"]);
    }
  }

  const referencedToolNames: string[] = [];
  const overrides = await readJson("overrides.json");
  if (isRecord(overrides) && isRecord(overrides["tools"])) {
    referencedToolNames.push(...Object.keys(overrides["tools"]));
  }
  // policy.json rules match on risk classes or explicit tool names; only the
  // explicit names can be invented.
  const policy = await readJson("policy.json");
  if (isRecord(policy) && Array.isArray(policy["rules"])) {
    for (const rule of policy["rules"]) {
      if (!isRecord(rule) || !isRecord(rule["match"])) continue;
      const tool = rule["match"]["tool"];
      if (typeof tool === "string") referencedToolNames.push(tool);
      if (Array.isArray(tool)) referencedToolNames.push(...tool.filter((name): name is string => typeof name === "string"));
    }
  }
  return { toolNames, referencedToolNames };
}
