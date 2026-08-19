import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checked, freePort, run, sleep, type CommandResult } from "./process.js";
import { DIRECT_DEPENDENCIES, fileSpec, packedVersions, packWorkspace, vendorInto, type Packed } from "./pack.js";

export const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const appSource = path.join(workspaceRoot, "fixtures/install-seam/app");
const vendoCli = path.join(workspaceRoot, "packages/vendo/bin/vendo.mjs");

/** A key-shaped string that is not a key. The BYO rung only has to RESOLVE for
 *  init to write an explicit `models` line and install the matching provider;
 *  nothing in this suite ever calls that model, so nothing ever presents it. */
const FAKE_PROVIDER_KEY = "sk-ant-api03-install-seam-fixture-not-a-real-key";

/** One of the model's moves, in the wire form the stranger's chat route
 *  accepts (`app/lib/scripted-model.ts`). */
export type TurnSpec =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown };

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export interface ExtractedTool {
  name: string;
  risk?: string;
  binding: { kind: string; method?: string; path?: string };
}

export interface Stranger {
  scaffoldDir: string;
  /** Package name → the version this workspace packed for it. */
  packedVersions: Record<string, string>;
  baseUrl: string;
  /** `pnpm add <tarballs>` — assertion 1. */
  add: CommandResult;
  /** `vendo init …` — assertion 2. */
  init: CommandResult;
  /** `tsc --noEmit` over the app INCLUDING what init generated — assertion 3. */
  typecheck: CommandResult;
  /** Every dependency name/spec the scaffold declares after install + init. */
  declaredDependencies: Record<string, string>;
  /** The scaffold's pnpm-lock.yaml — assertion 5 reads provenance out of it. */
  lockfile: string;
  /** Entries the isolated HOME grew that belong to Vendo (must be none). */
  vendoHomeEntries: string[];
  /** Entries in init's isolated cwd (must be none). */
  strayCwdEntries: string[];
  /** Every request that reached the stand-in Vendo Cloud (must be none). */
  cloudRequests: string[];
  /** The scaffold's .env.local, or "" when init wrote none. */
  envLocal: string;
  /** What init's extraction wrote into `.vendo/tools.json`. */
  tools: ExtractedTool[];
  /** The agent-visible name of the tool bound to one of the stranger's own
   *  routes — never guessed, always read back off the catalog init wrote. */
  toolFor(method: string, routePath: string): string;
  /** One turn through the stranger's own agent loop. Resolves to the streamed
   *  UI message body. */
  chat(prompt: string, script: TurnSpec[]): Promise<string>;
  /** Drives ONE host tool to an executed result: script the call, and if the
   *  guard parks it, approve it over the wire the embeds use and let the loop
   *  run it. Resolves to the stream that carries the tool's real output. */
  callTool(prompt: string, toolName: string, input: unknown): Promise<string>;
  /** The stranger's own API, read over real HTTP. */
  todos(): Promise<Todo[]>;
}

async function copyApp(destination: string): Promise<void> {
  await fs.cp(appSource, destination, { recursive: true });
}

/**
 * A stand-in for the Vendo console that answers nothing and remembers
 * everything. Init's cloud paths all resolve their base from
 * `VENDO_CLOUD_URL`, so a request recorded here is a key-mint attempt — which
 * is how "asks before accounts" is asserted as an absence rather than as the
 * lack of a string in some output.
 */
async function startCloudRecorder(): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":"the install seam allows no cloud calls"}');
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The stranger's environment: this machine's, minus every key and every
 * package-manager setting that would change the install's posture, plus
 * exactly what the run means to hand it.
 */
function strangerEnv(home: string, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "VENDO_API_KEY",
    "VENDO_CLOUD_URL",
    "VENDO_DEV_CREDENTIAL",
    "VENDO_MODEL",
    "VENDO_MODEL_APPS",
    "VENDO_MODEL_REVIEW",
    "VENDO_MODEL_JUDGE",
    "E2B_API_KEY",
    "COMPOSIO_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "VENDO_STORE_ENCRYPTION_KEY",
  ]) {
    delete env[name];
  }
  // The suite runs under pnpm, which exports its own config as npm_config_*
  // (a minimum-release-age window among it). A fresh user's app gets a clean
  // package-manager environment.
  for (const name of Object.keys(env)) {
    if (name.toLowerCase().startsWith("npm_") || name === "NODE_ENV" || name === "PNPM_HOME") delete env[name];
  }
  env["HOME"] = home;
  env["USERPROFILE"] = home;
  env["npm_config_min_release_age"] = "0";
  // The isolated HOME is there to make "init wrote nothing outside the app"
  // checkable, not to force a cold download of 400 packages on every run. The
  // package manager's own caches are pnpm's state, never Vendo's, so they live
  // outside it and survive between runs.
  env["npm_config_store_dir"] = path.join(tmpdir(), "vendo-install-seam-store");
  env["COREPACK_HOME"] = path.join(tmpdir(), "vendo-install-seam-corepack");
  env["NEXT_TELEMETRY_DISABLED"] = "1";
  env["VENDO_TELEMETRY_DISABLED"] = "1";
  env["DO_NOT_TRACK"] = "1";
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Waits for the stranger's dev server, with NO wall-clock budget of its own.
 * The test's timeout is the hang detector; a tighter inner deadline would be a
 * second, invisible speed limit that reports a product bug on a busy machine.
 * A crashed child is a real signal rather than a clock, so that still fails
 * immediately.
 */
async function waitForServer(baseUrl: string, dev: ChildProcess, logFile: string): Promise<void> {
  for (;;) {
    if (dev.exitCode !== null) {
      const log = await fs.readFile(logFile, "utf8").catch(() => "");
      throw new Error(`dev server exited ${dev.exitCode} before answering:\n${log.slice(-6000)}`);
    }
    const response = await fetch(`${baseUrl}/api/todos`).catch(() => null);
    if (response !== null && response.status < 500) return;
    await sleep(500);
  }
}

let packedOnce: Promise<Packed> | null = null;
function packOnce(): Promise<Packed> {
  packedOnce ??= (async () => {
    const dest = await fs.mkdtemp(path.join(tmpdir(), "vendo-install-seam-pack-"));
    return packWorkspace(workspaceRoot, dest);
  })();
  return packedOnce;
}

/**
 * The whole install seam, once: pack the publish set → scaffold a stranger app
 * in a temp dir → `pnpm add` the tarballs → `vendo init` → typecheck → boot.
 *
 * Everything happens OUTSIDE the workspace, in `os.tmpdir()`. That is also what
 * keeps the dist-dir law satisfied by construction: the stranger's `.next` can
 * never be a child (or a parent) of any directory a repo build wipes.
 */
export async function bootStranger(artifactsDir: string): Promise<{ stranger: Stranger; stop(): Promise<void> }> {
  await fs.mkdir(artifactsDir, { recursive: true });
  const log = (name: string): string => path.join(artifactsDir, name);
  const writeLog = async (name: string, body: string): Promise<void> => { await fs.writeFile(log(name), body); };

  const scaffoldDir = await fs.mkdtemp(path.join(tmpdir(), "vendo-install-seam-app-"));
  // Init runs with an isolated HOME and an isolated, empty cwd, so "wrote
  // nothing outside the fixture" is checkable rather than assumed.
  const home = await fs.mkdtemp(path.join(tmpdir(), "vendo-install-seam-home-"));
  const elsewhere = await fs.mkdtemp(path.join(tmpdir(), "vendo-install-seam-cwd-"));

  const cloud = await startCloudRecorder();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = strangerEnv(home, {
    ANTHROPIC_API_KEY: FAKE_PROVIDER_KEY,
    VENDO_CLOUD_URL: cloud.url,
  });

  let dev: ChildProcess | null = null;
  const stop = async (): Promise<void> => {
    if (dev !== null && dev.exitCode === null) {
      dev.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => dev!.once("close", resolve)), sleep(10_000)]);
      if (dev.exitCode === null) dev.kill("SIGKILL");
    }
    await cloud.close();
    if (process.env.VENDO_INSTALL_SEAM_KEEP === "1") {
      console.log(`VENDO_INSTALL_SEAM_KEEP=1 — stranger retained at ${scaffoldDir}`);
      return;
    }
    for (const dir of [scaffoldDir, home, elsewhere]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    // The tarballs are only as good as `dist/`, and a pack of an unbuilt
    // package succeeds — it just ships an empty one. Say so here instead of
    // three minutes later, as a module-not-found inside a Next dev server.
    await fs.access(path.join(workspaceRoot, "packages/vendo/dist/cli.js")).catch(() => {
      throw new Error("the workspace is not built — run `pnpm build` before the install seam");
    });
    const packed = await packOnce();
    await copyApp(scaffoldDir);
    await vendorInto(scaffoldDir, packed);

    // Assertion 1: the BUILT packages install into a stranger. `-w` because
    // the overrides above make the scaffold its own pnpm workspace root and
    // pnpm 11 refuses an implicit root add.
    const add = await checked(
      "pnpm add",
      run(
        "pnpm",
        ["add", "-w", ...DIRECT_DEPENDENCIES.map((name) => fileSpec(packed, name))],
        { cwd: scaffoldDir, env },
      ),
    );
    await writeLog("add.log", add.output);

    // Assertion 2: one non-interactive init, answered entirely by flags.
    // `--yes` and NOT `--byo`: an unattended run that already has a working
    // local key is exactly the run that must not quietly mint a cloud account.
    const init = await run(
      process.execPath,
      [
        vendoCli,
        "init",
        scaffoldDir,
        "--yes",
        "--no-ai",
        "--no-check",
        "--framework", "next",
        "--auth", "none",
        "--use-case", "agent-loop",
        "--base-url", baseUrl,
      ],
      { cwd: elsewhere, env },
    );
    await writeLog("init.log", init.output);

    // Assertion 3: the app compiles WITH what init generated.
    const typecheck = await run(
      path.join(scaffoldDir, "node_modules/.bin/tsc"),
      ["--noEmit"],
      { cwd: scaffoldDir, env },
    );
    await writeLog("typecheck.log", typecheck.output);

    const declaredDependencies = await readDeclaredDependencies(scaffoldDir);
    const lockfile = await fs.readFile(path.join(scaffoldDir, "pnpm-lock.yaml"), "utf8");
    const envLocal = await fs.readFile(path.join(scaffoldDir, ".env.local"), "utf8").catch(() => "");
    const vendoHomeEntries = (await fs.readdir(home).catch(() => []))
      .filter((entry) => entry.toLowerCase().includes("vendo"));
    const strayCwdEntries = await fs.readdir(elsewhere).catch(() => []);
    const tools = await readExtractedTools(scaffoldDir);

    // Straight through the next bin: `pnpm dev` would fire init's `predev`
    // hook, and a re-extraction in the middle of the boot is not what this
    // suite is measuring.
    const devLog = log("dev.log");
    const devLogStream = createWriteStream(devLog);
    dev = spawn(
      process.execPath,
      [path.join(scaffoldDir, "node_modules/next/dist/bin/next"), "dev", "--port", String(port)],
      { cwd: scaffoldDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    dev.stdout!.on("data", (chunk) => devLogStream.write(chunk));
    dev.stderr!.on("data", (chunk) => devLogStream.write(chunk));
    dev.once("close", () => devLogStream.end());
    await waitForServer(baseUrl, dev, devLog);

    let turn = 0;
    const stranger: Stranger = {
      scaffoldDir,
      packedVersions: packedVersions(packed),
      baseUrl,
      add,
      init,
      typecheck,
      declaredDependencies,
      lockfile,
      vendoHomeEntries,
      strayCwdEntries,
      cloudRequests: cloud.requests,
      envLocal,
      tools,
      toolFor(method, routePath) {
        const found = tools.find((tool) =>
          tool.binding.kind === "route" && tool.binding.method === method && tool.binding.path === routePath);
        if (found === undefined) {
          throw new Error(
            `init extracted no tool for ${method} ${routePath}; catalog: ${JSON.stringify(tools.map((tool) => tool.name))}`,
          );
        }
        return `vendo_${found.name}`;
      },
      async chat(prompt, script) {
        turn += 1;
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: `turn-${turn}`,
            messages: [{ id: `m${turn}`, role: "user", parts: [{ type: "text", text: prompt }] }],
            script,
          }),
        });
        const body = await response.text();
        await writeLog(`turn-${turn}.log`, body);
        if (response.status !== 200) throw new Error(`chat turn ${turn} returned ${response.status}:\n${body}`);
        return body;
      },
      async callTool(prompt, toolName, input) {
        const script: TurnSpec[] = [
          { kind: "tool", name: toolName, input },
          { kind: "text", text: "Done." },
        ];
        // A keyless install grades nothing, so the shipped posture is "ungraded
        // asks". Approving with a STANDING tool grant is what a person does in
        // <VendoApprovalEmbed>; the second call then runs unattended and its
        // real output comes back through the loop. A posture that already runs
        // the call unattended never enters the branch, so this asserts the
        // outcome without pinning which of the two the product does today.
        let body = await stranger.chat(prompt, script);
        const parked = approvalIdIn(body);
        if (parked === null) return body;
        const decided = await fetch(`${baseUrl}/api/vendo/approvals/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ids: [parked],
            decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
          }),
        });
        if (decided.status !== 200) {
          throw new Error(`approving ${parked} returned ${decided.status}: ${await decided.text()}`);
        }
        body = await stranger.chat(prompt, script);
        const stillParked = approvalIdIn(body);
        if (stillParked !== null) {
          throw new Error(`${toolName} parked again after a standing grant (${stillParked})`);
        }
        return body;
      },
      async todos() {
        const response = await fetch(`${baseUrl}/api/todos`);
        const body = (await response.json()) as { todos: Todo[] };
        return body.todos;
      },
    };
    return { stranger, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The approval the guard parked this turn's tool call behind, or null when it
 *  ran. The envelope is the product's own `vendo/approval-ref@1`. */
function approvalIdIn(streamBody: string): string | null {
  if (!streamBody.includes("vendo/approval-ref@1")) return null;
  const id = /"approvalId":"(apr_[^"]+)"/.exec(streamBody)?.[1];
  if (id === undefined) throw new Error(`an approval-ref envelope carried no approvalId:\n${streamBody.slice(0, 2000)}`);
  return id;
}

async function readExtractedTools(scaffoldDir: string): Promise<ExtractedTool[]> {
  const raw = await fs.readFile(path.join(scaffoldDir, ".vendo/tools.json"), "utf8").catch(() => null);
  if (raw === null) return [];
  return ((JSON.parse(raw) as { tools?: ExtractedTool[] }).tools ?? []);
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

async function readDeclaredDependencies(scaffoldDir: string): Promise<Record<string, string>> {
  const pkg = JSON.parse(await fs.readFile(path.join(scaffoldDir, "package.json"), "utf8")) as Record<string, unknown>;
  const declared: Record<string, string> = {};
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, spec] of Object.entries((pkg[section] as Record<string, string> | undefined) ?? {})) {
      declared[name] = spec;
    }
  }
  return declared;
}
