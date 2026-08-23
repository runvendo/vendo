import { readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initTelemetry, repoHost, type Telemetry } from "@vendoai/telemetry";
import { walk } from "./theme/walk.js";

export const CLI_VERSION = "0.37.1";

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export const consoleOutput: Output = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
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

/** True when this process was started by a package-manager lifecycle script
    (`predev`, `prebuild`, any `npm run …`). Such a run is NOT interactive, even
    on a TTY: npm inherits the terminal, so a command that stops to ask would
    block what the human thinks is a dev-server start — and a reflexive Enter on
    a default-yes prompt would spend money. A run the human did not invoke never
    gets a question.

    `npx` is the one event name that is not a script: `npx`/`npm exec` runs its
    target as a synthetic script literally named `npx`, so the docs' own
    `npx vendo init` arrived here looking like a hook and ran mute. A human
    typing `npx vendo …` is a human; real hooks have their own names. */
export function invokedByPackageScript(env: Record<string, string | undefined> = process.env): boolean {
  const event = (env.npm_lifecycle_event ?? "").trim();
  return event !== "" && event !== "npx";
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** A leading UTF-8 BOM, stripped before any read is parsed or compared:
    Notepad and PowerShell's Set-Content both write one, and npm and Node's
    own require() both tolerate it — a host file must never be less readable
    to vendo than to npm (FINDINGS, linkwarden field test 2026-08-08: a BOM'd
    package.json crashed init with a raw SyntaxError). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return stripBom(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function noTelemetry(): Telemetry {
  return { async track() {} };
}

/** The injectable telemetry deps every CLI command's options carry
    (init/doctor already ride this exact shape). */
export interface TelemetryOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  posthogKey?: string;
  fetchImpl?: typeof fetch;
  /** The command's TARGET project dir: projectIdHash/packageManager derive
      from it (not the shell cwd — `vendo sync ../app` must attribute to
      ../app), and it is where the .env.local cloud-key read looks. Defaults
      to process.cwd(). */
  cwd?: string;
}

/**
 * The value of one NAME=value line in the project's dotenv. The SYNC half of
 * the one env reader — telemetry client creation cannot await — reading the
 * same files in the same precedence as sync-flow.ts's `readEnvFiles`: `.env`
 * then `.env.local`, local wins. Matches dotenv semantics for hand-authored
 * entries: surrounding quotes are stripped, and unquoted values lose their
 * ` #…` inline comment. Non-throwing: a missing or unreadable file is null.
 */
export function envFileValueSync(root: string, name: string): string | null {
  let found: string | null = null;
  for (const file of [".env", ".env.local"]) {
    try {
      const value = parseDotEnv(readFileSync(join(root, file), "utf8"))[name];
      // A bare `NAME=` never overrides a value the earlier file supplied.
      if (value !== undefined && value !== "") found = value;
    } catch {
      // A missing file is the common case.
    }
  }
  return found;
}

/** THE dotenv parser, for both halves of the CLI's env reader (this file's
 * envFileValueSync and sync-flow.ts's readEnvFiles). Minimal KEY=VALUE:
 * `export ` prefix, `#` comment lines skipped, value grammar below. */
export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    parsed[match[1]!] = normalizeDotEnvValue(match[2]!.trim());
  }
  return parsed;
}

/** One value grammar for the parser above: matching surrounding quotes are
 * stripped; unquoted values lose their ` #…` inline comment. */
export function normalizeDotEnvValue(value: string): string {
  const quoted = value.match(/^(["'])(.*)\1$/);
  if (quoted?.[2] !== undefined) return quoted[2];
  return value.replace(/\s+#.*$/, "").trimEnd();
}

export function toolingTelemetry(options: TelemetryOptions & {
  log?: (message: string) => void;
} = {}): Telemetry {
  try {
    let env = options.env ?? process.env;
    // Cloud-lane key sourcing widens to the project's dotenv — exactly
    // where `vendo login` / cloud-init / --cloud-key land the key — because
    // a Cloud-minted key almost never lives in the process env. Only
    // VENDO_API_KEY widens: consent vars (DO_NOT_TRACK, CI, …) keep coming
    // from the caller's env untouched, and an explicit non-blank env value
    // always wins over the files (the same precedence readEnvFiles uses).
    if ((env.VENDO_API_KEY ?? "").trim() === "") {
      const stored = envFileValueSync(options.cwd ?? process.cwd(), "VENDO_API_KEY");
      if (stored !== null) env = { ...env, VENDO_API_KEY: stored };
    }
    return initTelemetry({
      version: CLI_VERSION,
      runtime: false,
      home: options.home,
      env,
      cwd: options.cwd,
      posthogKey: options.posthogKey ?? process.env.VENDO_POSTHOG_KEY,
      fetchImpl: options.fetchImpl,
      log: options.log,
    });
  } catch {
    return noTelemetry();
  }
}

export function errorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return "unknown";
}

/** The closed `command_run.command` enum (TELEMETRY.md). init keeps its own
    richer events; "theme" is reserved — no `vendo theme` entrypoint exists
    yet. "login" is the top-level claim ceremony; init's embedded run of the
    same ceremony stays "cloud-init". */
export type CommandName =
  | "login"
  | "extract"
  | "theme"
  | "eject"
  | "sync"
  | "cloud-init"
  | "mcp"
  | "knowledge";

/** Cloud-lane project identity (projectName + repoHost) for commands that
    have a target project dir. Anonymous-lane sends strip both keys. */
export async function cloudProjectProps(root: string | undefined): Promise<Record<string, unknown>> {
  if (root === undefined) return {};
  const props: Record<string, unknown> = {};
  try {
    const name = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) props.projectName = name;
  } catch {
    // No usable package.json — the cloud lane just omits projectName.
  }
  const forge = repoHost(root);
  if (forge !== undefined) props.repoHost = forge;
  return props;
}

/**
 * Run a CLI command body with one `command_run` telemetry row: ok is the
 * exit code (0 = true), a throw records the error class and rethrows, and a
 * body can name the step it failed at via the mutable `failure` argument.
 * The body also receives the telemetry client for extra events. Telemetry
 * NEVER changes command behavior or exit codes — the client never throws,
 * and this wrapper's own prop assembly is guarded too.
 */
export async function withCommandRun(
  input: {
    command: CommandName;
    telemetry?: TelemetryOptions;
    /** Host project dir for the cloud lane's projectName/repoHost; omitted
        for commands without a target project (mcp). */
    root?: string;
  },
  body: (failure: { failedStep?: string }, telemetry: Telemetry) => Promise<number>,
): Promise<number> {
  const started = Date.now();
  // The first-run notice keeps its console.error default — several wrapped
  // commands (sync --json, mcp server-json) own their stdout byte-for-byte.
  // The target root rides in as the client's cwd so projectIdHash and the
  // .env.local cloud-key read attribute to the project being operated on,
  // not the shell cwd (an explicit seam cwd still wins).
  const telemetry = toolingTelemetry({
    ...(input.root === undefined ? {} : { cwd: input.root }),
    ...(input.telemetry ?? {}),
  });
  const failure: { failedStep?: string } = {};
  const track = async (ok: boolean, thrown?: { error: unknown }): Promise<void> => {
    try {
      await telemetry.track("command_run", {
        command: input.command,
        ok,
        durationMs: Date.now() - started,
        ...(failure.failedStep === undefined ? {} : { failedStep: failure.failedStep }),
        ...(thrown === undefined ? {} : { errorClass: errorClass(thrown.error) }),
        ...(await cloudProjectProps(input.root)),
      });
    } catch {
      // Telemetry must never break a command. Intentional silent failure.
    }
  };
  try {
    const exit = await body(failure, telemetry);
    await track(exit === 0);
    return exit;
  } catch (error) {
    await track(false, { error });
    throw error;
  }
}

/** Windows' `start` is a cmd built-in, not an executable — execFile can only
 *  reach it through `cmd /c start "" <url>` (the empty string is the window
 *  title, so a URL is never mistaken for one). */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Lockfile-derived package manager for `run dev` (doctor's probe starter). */
export async function detectPackageManager(root: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock"))) return "bun";
  return "npm";
}

/** Where init scaffolds app/api/vendo/[...vendo] and (for a fresh scaffold)
    the app-router layout wrap. Next hard-fails ("pages and app directories
    should be under the same folder") when app/ and pages/ sit at different
    bases, so a host whose pages router already lives under src/ must get its
    NEW app/ segment there too, mirroring detectRouter's src/pages signal —
    even before any src/app exists to detect directly. This still hands a
    pure-Pages host an App-Router route segment by design (valid in Next as
    long as both share one base); whether pages-native hosts deserve a
    pages/api scaffold instead is a separate, unaddressed question. */
export async function appDirectory(root: string): Promise<string> {
  if (await exists(join(root, "src", "app"))) return join(root, "src", "app");
  if (await exists(join(root, "src", "pages"))) return join(root, "src", "app");
  return join(root, "app");
}

const LAYOUT_FILE = /(^|[\\/])layout\.(?:tsx|jsx|js)$/;

/** The file whose client root the <VendoProvider> paste belongs in, and the
    child expression it wraps there. The app router's ROOT layout is whichever
    layout sits shallowest — an i18n or route-group host (`app/[locale]/`,
    `app/(shop)/`) has no app/layout.tsx at all, so a literal app/layout.tsx
    probe named a file that does not exist and told the user to create a SECOND
    root layout, which is how you break such a host rather than mount in it.
    Shallowest wins, lexicographic on a tie (walk() sorts, and sort is stable).
    A pages-only host has no layout to wrap — its client root is pages/_app.tsx,
    and the paste mounts there unchanged. (Where the API route segment
    gets scaffolded is a separate, deliberate choice — see appDirectory.)
    Keyed on the layout FILE, not on a router probe: the scaffold creates app/
    mid-run, and the answer must be the same before and after it. The
    conventional app/layout.tsx survives only as the last resort — a host with
    no layout and no pages/ has no client root yet, and that is where Next
    wants the one it must create.

    Shared with doctor on purpose: init tells the user which file to paste into
    and doctor grades whether they did. Two copies of this rule meant doctor
    failed every pages-only host forever, naming a file init never mentioned. */
export async function clientRoot(root: string): Promise<{ file: string; children: string }> {
  const app = await appDirectory(root);
  const [layout] = (await walk(app, (file) => LAYOUT_FILE.test(file)))
    .sort((a, b) => a.split(sep).length - b.split(sep).length);
  if (layout !== undefined) return { file: layout, children: "{children}" };
  for (const pages of [join(root, "src", "pages"), join(root, "pages")]) {
    if (await exists(pages)) return { file: join(pages, "_app.tsx"), children: "<Component {...pageProps} />" };
  }
  return { file: join(app, "layout.tsx"), children: "{children}" };
}
