import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { warnEnvLocalNotIgnored } from "./cloud-init.js";
import { workspaceHostCandidates } from "./framework.js";
import { runInit } from "./init.js";
import type { Output } from "./shared.js";
import { walk } from "./theme/walk.js";

/**
 * Onboarding safety + honesty: the four things a first `vendo init` must not
 * do — leak a secret into a committed file, hang a non-TTY caller on a
 * question, claim the agent is live when no model key exists, or hand a host
 * wiring instructions for a file it doesn't have.
 */

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

/** A Next host whose ONLY router is pages/ — no app/layout.tsx exists. */
async function pagesHost(): Promise<string> {
  const root = await tempDir("vendo-init-pagesonly-");
  await mkdir(join(root, "pages"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
  await writeFile(join(root, "pages", "index.tsx"), "export default function Home() { return null; }\n");
  await writeFile(join(root, "pages", "_app.tsx"),
    "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n");
  return root;
}

function run(root: string, sink: { output: Output }, extra: Partial<Parameters<typeof runInit>[0]> = {}): Promise<number> {
  return runInit({
    targetDir: root,
    output: sink.output,
    env: {},
    cloud: { cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] as readonly string[] }) },
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    // A resolved credential makes init install the provider it needs — never
    // a real npm install from a test fixture.
    installProvider: async () => 0,
    ...extra,
  });
}

describe("the .env.local secret write warns when git would commit it", () => {
  it("warns, naming the fix, when .env.local is not ignored", async () => {
    const root = await tempDir("vendo-gitignore-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const sink = output();
    await warnEnvLocalNotIgnored(root, sink.output);
    const warning = sink.errors.join("\n");
    expect(warning).toContain(".env.local");
    expect(warning).toContain(".gitignore");
    expect(sink.logs).toEqual([]);
  });

  it("stays silent when .gitignore covers .env.local", async () => {
    const root = await tempDir("vendo-gitignore-ok-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env*.local\n");
    const sink = output();
    await warnEnvLocalNotIgnored(root, sink.output);
    expect(sink.errors).toEqual([]);
  });

  it("stays silent outside a git repo — nothing to leak into", async () => {
    const sink = output();
    await warnEnvLocalNotIgnored(await tempDir("vendo-gitignore-nogit-"), sink.output);
    expect(sink.errors).toEqual([]);
  });

  it("--cloud-key surfaces the warning right after the write, and never blocks it", async () => {
    const root = await pagesHost();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const sink = output();
    expect(await run(root, sink, { cloudKey: `vnd_${"a".repeat(40)}` })).toBe(0);
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_API_KEY=vnd_");
    expect(sink.errors.join("\n")).toContain("NOT gitignored");
  });
});

describe("exactly one askYesNo", () => {
  it("only shared.ts defines it, and that copy guards non-TTY callers", async () => {
    const cli = fileURLToPath(new URL(".", import.meta.url));
    const sources = await walk(cli, (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
    const definers: string[] = [];
    for (const file of sources) {
      if ((await readFile(file, "utf8")).includes("function askYesNo")) definers.push(file.slice(cli.length));
    }
    // A second, unguarded copy is how non-TTY callers used to hang.
    expect(definers).toEqual(["shared.ts"]);
    expect(await readFile(join(cli, "shared.ts"), "utf8")).toContain("if (!stdin.isTTY || !stdout.isTTY) return false;");
  });
});

describe("the closing line tells the truth about the model key", () => {
  it("keyless: live once a key is added", async () => {
    const sink = output();
    expect(await run(await pagesHost(), sink)).toBe(0);
    expect(sink.logs.join("\n")).toContain("Then start your dev server — the agent is live once you add a model key.");
    expect(sink.logs.join("\n")).not.toContain("the agent is live in your app.");
  });

  it("keyed: live in your app", async () => {
    const sink = output();
    expect(await run(await pagesHost(), sink, { env: { ANTHROPIC_API_KEY: "sk-a" } })).toBe(0);
    expect(sink.logs.join("\n")).toContain("Then start your dev server — the agent is live in your app.");
  });
});

describe("a pages-only host is told to wire the file it actually has", () => {
  it("names pages/_app.tsx and never app/layout.tsx", async () => {
    const sink = output();
    expect(await run(await pagesHost(), sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Last steps are yours:");
    expect(logs).toContain(`In ${join("pages", "_app.tsx")}:`);
    // The wrapped child is the pages-router one, not app-router's {children}.
    expect(logs).toContain("<VendoRoot><Component {...pageProps} /></VendoRoot>");
    expect(logs).not.toContain(join("app", "layout.tsx"));
  });
});

describe("an init at a monorepo root names the workspace host", () => {
  async function monorepo(): Promise<string> {
    const root = await tempDir("vendo-init-monorepo-");
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await mkdir(join(root, "packages", "ui"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "monorepo", private: true }));
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "packages", "ui", "package.json"), JSON.stringify({ name: "ui" }));
    return root;
  }

  it("lists only the workspace packages that look like hosts", async () => {
    expect(await workspaceHostCandidates(await monorepo())).toEqual(["apps/web"]);
    expect(await workspaceHostCandidates(await tempDir("vendo-init-flat-"))).toEqual([]);
  });

  it("interactive: hints at apps/web instead of silently scaffolding the root", async () => {
    const sink = output();
    expect(await run(await monorepo(), sink, {
      interactive: true,
      confirmAuth: async () => false,
      selectAuth: async () => "none",
    })).toBe(0);
    const hint = sink.errors.join("\n");
    expect(hint).toContain("did you mean apps/web?");
    expect(hint).toContain("vendo init apps/web");
    expect(hint).toContain("--framework");
  });

  it("non-interactive is unchanged: the exact-flag error, no hint", async () => {
    const sink = output();
    expect(await run(await monorepo(), sink, { yes: true })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Pass --framework");
    expect(sink.errors.join("\n")).not.toContain("did you mean");
  });
});
