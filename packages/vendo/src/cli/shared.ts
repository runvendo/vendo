import { readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initTelemetry, repoHost, type Telemetry } from "@vendoai/telemetry";

export const CLI_VERSION = "0.8.0";

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
    gets a question. */
export function invokedByPackageScript(env: Record<string, string | undefined> = process.env): boolean {
  return (env.npm_lifecycle_event ?? "").trim() !== "";
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
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
 * The value of one NAME=value line in `<root>/.env.local`. Matches dotenv
 * semantics for hand-authored entries: surrounding quotes are stripped, and
 * unquoted values lose their ` #…` inline comment. Non-throwing: a missing
 * or unreadable file is null. Sync on purpose — telemetry client creation is
 * synchronous.
 */
export function envLocalValueSync(root: string, name: string): string | null {
  try {
    const raw = readFileSync(join(root, ".env.local"), "utf8");
    const match = raw.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
    const value = match?.[1];
    if (value === undefined) return null;
    return normalizeDotEnvValue(value);
  } catch {
    return null;
  }
}

/** One value grammar for every CLI dotenv reader (envLocalValueSync, doctor's
 * readDotEnvFallback): matching surrounding quotes are stripped; unquoted
 * values lose their ` #…` inline comment. */
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
    // Cloud-lane key sourcing widens to the project's .env.local — exactly
    // where `vendo login` / cloud-init / --cloud-key land the key — because
    // a Cloud-minted key almost never lives in the process env. Only
    // VENDO_API_KEY widens: consent vars (DO_NOT_TRACK, CI, …) keep coming
    // from the caller's env untouched, and an explicit non-blank env value
    // always wins over .env.local (the same precedence init's credential
    // merge uses).
    if ((env.VENDO_API_KEY ?? "").trim() === "") {
      const stored = envLocalValueSync(options.cwd ?? process.cwd(), "VENDO_API_KEY");
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

/** The file whose client root the <VendoRoot> paste belongs in, and the child
    expression it wraps there. A pages-only host has NO app/layout.tsx to wrap
    — its client root is pages/_app.tsx, and the generated vendo-root.tsx is a
    client component that mounts there unchanged. (Where the API route segment
    gets scaffolded is a separate, deliberate choice — see appDirectory.)
    Keyed on the layout FILE, not on a router probe: the scaffold creates app/
    mid-run, and the answer must be the same before and after it.

    Shared with doctor on purpose: init tells the user which file to paste into
    and doctor grades whether they did. Two copies of this rule meant doctor
    failed every pages-only host forever, naming a file init never mentioned. */
export async function clientRoot(root: string): Promise<{ file: string; children: string }> {
  const layout = join(await appDirectory(root), "layout.tsx");
  if (!(await exists(layout))) {
    for (const pages of [join(root, "src", "pages"), join(root, "pages")]) {
      if (await exists(pages)) return { file: join(pages, "_app.tsx"), children: "<Component {...pageProps} />" };
    }
  }
  return { file: layout, children: "{children}" };
}
