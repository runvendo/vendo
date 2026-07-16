import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  describeDevCredential,
  hasSessionConsent,
  resolveDevCredential,
  writeDevSessionConsent,
  type DevCredential,
} from "../dev-creds/resolve.js";
import { exists, readOptional, type Output } from "./shared.js";

/**
 * ENG-338 — init's dev-mode ladder step and the init-ends-in-the-product
 * finale (install-dx design §1–2). The wizard always STATES what the ladder
 * found; session rungs are used only after explicit consent recorded here;
 * production messaging is explicit at every rung.
 */

const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";

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

/** Lockfile-derived package manager for installs and `run dev`. */
export async function detectPackageManager(root: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function sdkResolvable(root: string): boolean {
  try {
    createRequire(join(root, "package.json")).resolve(CLAUDE_SDK);
    return true;
  } catch {
    return false;
  }
}

function installDevDependency(root: string, packageManager: string, name: string): Promise<boolean> {
  const args = packageManager === "yarn" ? ["add", "--dev", name] : packageManager === "bun" ? ["add", "-d", name] : ["install", "-D", name];
  return new Promise((resolve) => {
    execFile(packageManager, args, { cwd: root, timeout: 180_000 }, (error) => resolve(error === null));
  });
}

export interface DevModeStepOptions {
  root: string;
  output: Output;
  /** Non-interactive (`--yes` / no TTY): state findings, never prompt. */
  yes: boolean;
  env?: Record<string, string | undefined>;
  /** Test seams. */
  resolve?: typeof resolveDevCredential;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  install?: (root: string, packageManager: string, name: string) => Promise<boolean>;
}

/** The wizard's model-ladder step. Returns what the ladder found. */
export async function runDevModeStep(options: DevModeStepOptions): Promise<DevCredential> {
  const { root, output } = options;
  const env = options.env ?? process.env;
  const resolve = options.resolve ?? resolveDevCredential;
  const confirm = options.confirm ?? askYesNo;
  const install = options.install ?? installDevDependency;

  const credential = await resolve({ env });
  output.log(`\nModel for dev mode: ${describeDevCredential(credential)}.`);

  if (credential.rung === "env-key") {
    output.log("Production deploys use this same key server-side.");
    return credential;
  }

  if (credential.rung === "claude-session" || credential.rung === "codex-session") {
    if (await hasSessionConsent(root, credential.rung, env)) {
      output.log("Consent already recorded (.vendo/data/dev-credential.json). Production needs a real key.");
      return credential;
    }
    if (options.yes) {
      output.log("Not used without consent: re-run `vendo init` interactively (or set VENDO_DEV_ALLOW_SESSIONS=1) to ride it in dev mode. Production needs a real key.");
      return credential;
    }
    const label = credential.rung === "claude-session" ? "Claude Code login" : "Codex login";
    const consented = await confirm(
      `Use your ${label} for dev-mode model calls? Local development only — production always needs a real key.`,
    );
    if (!consented) {
      output.log("Okay — dev mode will need a model key (.env.local) instead. Production needs a real key either way.");
      return credential;
    }
    await writeDevSessionConsent(root, credential.rung);
    output.log("Consent recorded in .vendo/data/dev-credential.json (per machine, gitignored).");

    if (credential.rung === "claude-session" && !sdkResolvable(root)) {
      const packageManager = await detectPackageManager(root);
      const installNow = await confirm(
        `The Claude rung runs over ${CLAUDE_SDK}. Install it now as a devDependency (${packageManager})?`,
        true,
      );
      if (installNow) {
        output.log(`Installing ${CLAUDE_SDK}…`);
        if (await install(root, packageManager, CLAUDE_SDK)) output.log("Installed.");
        else output.error(`Install failed — run \`${packageManager === "yarn" ? "yarn add --dev" : `${packageManager} install -D`} ${CLAUDE_SDK}\` yourself before starting the dev server.`);
      } else {
        output.log(`Skipped — install ${CLAUDE_SDK} before starting the dev server, or the ladder falls through.`);
      }
    }
    return credential;
  }

  if (credential.rung === "vendo-cloud") {
    output.log("VENDO_API_KEY unlocks cloud features; dev-mode starter model keys arrive with `vendo cloud login` (doctor v2). Until then set a provider key or log in to the Claude Code / Codex CLI.");
    return credential;
  }

  output.log("Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY in .env.local, or log in to the Claude Code (`claude`) or Codex (`codex login`) CLI and re-run `vendo init`.");
  output.log("Production deploys always need a real server-side key.");
  return credential;
}

/* ------------------------------------------------------------------------ */

export interface SeedChoice {
  kind: "tool-demo" | "on-brand-ui" | "tour";
  prompt: string;
}

/** Adaptive seeding (design §1): tools → live tool demo; theme-only → on-brand
 *  UI generation; blank → self-aware tour. */
export function chooseSeedPrompt(input: { toolCount: number; hasTheme: boolean }): SeedChoice {
  if (input.toolCount > 0) {
    return {
      kind: "tool-demo",
      prompt: "Introduce yourself in one sentence, then pick ONE safe read-only action from your tools, run it, and show me what came back.",
    };
  }
  if (input.hasTheme) {
    return {
      kind: "on-brand-ui",
      prompt: "Introduce yourself in one sentence, then generate a small on-brand UI card that shows off what you can build inside this product.",
    };
  }
  return {
    kind: "tour",
    prompt: "Introduce yourself: what can you help with in this app, what did Vendo find during setup, and what unlocks next as tools and theme are added?",
  };
}

export interface InitFinaleOptions {
  root: string;
  output: Output;
  framework: string;
  credential: DevCredential;
  /** Non-interactive: print the hint, never launch. */
  yes: boolean;
  env?: Record<string, string | undefined>;
  /** Test seams. */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  spawnDev?: (packageManager: string, root: string) => ChildProcess;
  openBrowser?: (url: string) => void;
  fetchImpl?: typeof fetch;
  statusTimeoutMs?: number;
  /** When false (default true), do not block on the dev server after the
   *  seeded turn — used by tests. */
  waitForServerExit?: boolean;
}

function defaultSpawnDev(packageManager: string, root: string): ChildProcess {
  return spawn(packageManager, ["run", "dev"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

function defaultOpenBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(command, [url], () => undefined);
}

async function waitForStatus(base: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${base}/api/vendo/status`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

/** Stream one seeded turn through the live wire, printing text deltas. */
async function seedFirstTurn(
  base: string,
  seed: SeedChoice,
  fetchImpl: typeof fetch,
  output: Output,
): Promise<boolean> {
  const response = await fetchImpl(`${base}/api/vendo/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        id: `msg_seed_${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: seed.prompt }],
      },
    }),
  });
  if (!response.ok || response.body === null) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteAny = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const frameEnd = buffer.indexOf("\n\n");
      if (frameEnd === -1) break;
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      if (!frame.startsWith("data: ") || frame === "data: [DONE]") continue;
      try {
        const part = JSON.parse(frame.slice("data: ".length)) as { type?: string; delta?: string; toolName?: string };
        if (part.type === "text-delta" && typeof part.delta === "string") {
          stdout.write(part.delta);
          wroteAny = true;
        } else if (part.type === "tool-input-available" && typeof part.toolName === "string") {
          stdout.write(`\n[tool] ${part.toolName}…\n`);
        } else if (part.type === "error") {
          output.error("\nThe first turn hit an error — check the dev-server log above.");
        }
      } catch {
        // skip malformed frame
      }
    }
  }
  if (wroteAny) stdout.write("\n");
  return wroteAny;
}

/** Init ends in the product (design §1): consent-gated dev-server start, open
 *  the browser on the host app, seed an adaptive first turn, and print the
 *  live reply in the terminal. */
export async function runInitFinale(options: InitFinaleOptions): Promise<void> {
  const { root, output, credential } = options;
  const env = options.env ?? process.env;
  if (options.framework !== "next") return;
  if (credential.rung === "none" || credential.rung === "vendo-cloud") return;

  const confirm = options.confirm ?? askYesNo;
  if (options.yes || !(await confirm("Start the dev server and see your agent's first turn now?", true))) {
    output.log("Next: start your dev server and open the app — the Vendo agent is live in your product. (Production needs a real model key.)");
    return;
  }

  const packageManager = await detectPackageManager(root);
  const port = env["PORT"] ?? "3000";
  const base = `http://localhost:${port}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  output.log(`\nStarting the dev server (${packageManager} run dev)…`);
  const child = (options.spawnDev ?? defaultSpawnDev)(packageManager, root);
  const bootLog: string[] = [];
  const record = (data: Buffer): void => {
    bootLog.push(data.toString());
    if (bootLog.length > 200) bootLog.shift(); // bounded: init may hold the server open for hours
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const up = await waitForStatus(base, fetchImpl, options.statusTimeoutMs ?? 120_000);
  if (!up) {
    output.error(`The dev server did not answer ${base}/api/vendo/status in time. Recent output:\n${bootLog.slice(-20).join("")}`);
    child.kill("SIGTERM");
    return;
  }

  (options.openBrowser ?? defaultOpenBrowser)(base);

  let toolCount = 0;
  try {
    const tools = JSON.parse((await readOptional(join(root, ".vendo", "tools.json"))) ?? "{}") as { tools?: unknown[] };
    toolCount = tools.tools?.length ?? 0;
  } catch {
    // extraction warnings were already reported
  }
  const hasTheme = await exists(join(root, ".vendo", "theme.json"));
  const seed = chooseSeedPrompt({ toolCount, hasTheme });
  const rung = describeDevCredential(credential);
  output.log(`Opened ${base}. Seeding a first turn (${seed.kind}) over ${rung}${credential.rung === "claude-session" ? " — the first turn warms the session (~10s)" : ""}…\n`);

  try {
    const answered = await seedFirstTurn(base, seed, fetchImpl, output);
    if (answered) {
      output.log(`\nThat reply came from your app's own agent. Ask it the same thing in the browser (${base}).`);
    } else {
      output.error("\nNo reply text arrived — run `vendo doctor` against the running server to diagnose.");
    }
  } catch (error) {
    output.error(`\nSeeded turn failed: ${error instanceof Error ? error.message : "unknown error"}. Run \`vendo doctor\` to diagnose.`);
  }

  output.log("The dev server is still running — press Ctrl+C to stop it.");
  // Hand the server's own logs through from here on.
  child.stdout?.on("data", (data: Buffer) => stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  if (options.waitForServerExit !== false) {
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}
