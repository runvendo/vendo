import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEnvLocalIgnored } from "../../src/cli/cloud-init.js";
import { workspaceHostCandidates } from "../../src/cli/framework.js";
import { runInit } from "../../src/cli/init.js";
import type { Output } from "../../src/cli/shared.js";
import { walk } from "../../src/cli/theme/walk.js";

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
  /** The verdict must come from the REPO, never from whoever runs the suite: a
      developer with .env.local in their global excludes (or a ~/.gitconfig
      core.excludesFile) would otherwise flip these assertions. */
  beforeEach(async () => {
    const home = await tempDir("vendo-git-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A repo holding an untracked .env.local — the state right after a mint. */
  async function repo(): Promise<string> {
    const root = await tempDir("vendo-gitignore-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".env.local"), "VENDO_API_KEY=x\n");
    return root;
  }

  it("ADDS the ignore line for an untracked .env.local and reports it, once", async () => {
    const root = await repo();
    const sink = output();
    expect(await ensureEnvLocalIgnored(root, sink.output)).toBe(".env.local");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".env.local\n");
    expect(sink.logs).toEqual(["Added .env.local to .gitignore"]);
    expect(sink.errors).toEqual([]);
    // Idempotent: the second run finds it ignored and says nothing at all.
    const again = output();
    expect(await ensureEnvLocalIgnored(root, again.output)).toBeNull();
    expect(again.logs).toEqual([]);
    expect(again.errors).toEqual([]);
  });

  it("stays silent when .gitignore already covers .env.local", async () => {
    const root = await repo();
    await writeFile(join(root, ".gitignore"), ".env*.local\n");
    const sink = output();
    expect(await ensureEnvLocalIgnored(root, sink.output)).toBeNull();
    expect(sink.errors).toEqual([]);
    expect(sink.logs).toEqual([]);
  });

  it("an ALREADY TRACKED .env.local is the one branch init must not silently fix", async () => {
    // git check-ignore reports a tracked file as NOT ignored even when a
    // pattern matches it, so adding the line would be both the wrong advice
    // and useless: the file is in the index and commits anyway.
    const root = await repo();
    await writeFile(join(root, ".gitignore"), ".env*.local\n");
    execFileSync("git", ["add", "-f", ".env.local"], { cwd: root });
    const sink = output();
    expect(await ensureEnvLocalIgnored(root, sink.output)).toBeNull();
    const warning = sink.errors.join("\n");
    expect(warning).toContain("TRACKED by git");
    expect(warning).toContain("git rm --cached .env.local");
    expect(sink.logs).toEqual([]);
  });

  it("stays silent outside a git repo — nothing to leak into", async () => {
    const sink = output();
    expect(await ensureEnvLocalIgnored(await tempDir("vendo-gitignore-nogit-"), sink.output)).toBeNull();
    expect(sink.errors).toEqual([]);
    expect(sink.logs).toEqual([]);
  });

  it("a symlinked .env.local is judged by the file the write really lands in", async () => {
    // The write follows the link, so a gitignored .env.local pointing at a
    // TRACKED file is the worst case: asking git about the link calls it safe.
    const root = await repo();
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "dev.env"), "SOMETHING=1\n");
    execFileSync("git", ["add", "-f", join("config", "dev.env")], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env.local\n");
    await rm(join(root, ".env.local"));
    await symlink(join(root, "config", "dev.env"), join(root, ".env.local"));
    const sink = output();
    expect(await ensureEnvLocalIgnored(root, sink.output)).toBeNull();
    const warning = sink.errors.join("\n");
    expect(warning).toContain("TRACKED by git");
    expect(warning).toContain(join("config", "dev.env"));
  });

  it("a real repo where git ERRORS is never silently treated as ignored", async () => {
    // Broken config inside a live repo: git can answer neither question, and
    // the old "anything but exit 1 means ignored" rule swallowed the warning.
    const root = await repo();
    await writeFile(join(root, ".git", "config"), "[core\nnot valid\n");
    const sink = output();
    expect(await ensureEnvLocalIgnored(root, sink.output)).toBeNull();
    const warning = sink.errors.join("\n");
    expect(warning).toContain("could not say whether it is ignored");
    expect(warning).toContain("bad config line");
  });

  it("--cloud-key adds the ignore line right after the write, and never blocks it", async () => {
    const root = await pagesHost();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const sink = output();
    expect(await run(root, sink, { cloudKey: `vnd_${"a".repeat(40)}` })).toBe(0);
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_API_KEY=vnd_");
    expect(sink.logs.join("\n")).toContain("Added .env.local to .gitignore");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".env.local");
  });
});

describe("exactly one askYesNo", () => {
  it("only shared.ts defines it, and that copy guards non-TTY callers", async () => {
    const cli = fileURLToPath(new URL("../../src/cli/", import.meta.url));
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

describe("an init at a monorepo root names the workspace host", () => {
  async function monorepo(prefix = "vendo-init-monorepo-"): Promise<string> {
    const root = await tempDir(prefix);
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await mkdir(join(root, "packages", "ui"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "monorepo", private: true }));
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "packages", "ui", "package.json"), JSON.stringify({ name: "ui" }));
    return root;
  }

  function hintFor(root: string, sink: { output: Output }): Promise<number> {
    return run(root, sink, { interactive: true, selectAuth: async () => "none" });
  }

  it("lists only the workspace packages that look like hosts", async () => {
    expect(await workspaceHostCandidates(await monorepo())).toEqual(["apps/web"]);
    expect(await workspaceHostCandidates(await tempDir("vendo-init-flat-"))).toEqual([]);
  });

  it("interactive: hints at apps/web instead of silently scaffolding the root", async () => {
    const root = await monorepo();
    const sink = output();
    expect(await hintFor(root, sink)).toBe(0);
    const hint = sink.errors.join("\n");
    expect(hint).toContain("did you mean apps/web?");
    expect(hint).toContain("looks like the host");
    expect(hint).toContain("--framework");
    // The suggested command has to resolve from the CALLER's cwd, not from
    // init's target root: `vendo init apps/web` run from elsewhere lands in a
    // sibling of the caller, not inside the monorepo.
    expect(hint).toContain(`vendo init ${join(root, "apps", "web")}`);
  });

  it("single-quotes a suggested path the shell would otherwise mangle", async () => {
    // Double quotes are NOT enough: `$(…)` inside them is command-substituted
    // by the shell the suggestion is pasted into.
    const root = await monorepo("vendo init $(printf SUBSTITUTED) ");
    const sink = output();
    expect(await hintFor(root, sink)).toBe(0);
    const hint = sink.errors.join("\n");
    expect(hint).toContain(`vendo init '${join(root, "apps", "web")}'`);
    expect(hint).not.toContain(`"${join(root, "apps", "web")}"`);
  });

  it("suggests `.` when the caller is already standing in the host dir", async () => {
    // `cd repo/apps/web && vendo init ../..` — the suggestion must be the cwd
    // itself, not an absolute path (relative() returns "" for that case).
    const root = await monorepo();
    const host = join(root, "apps", "web");
    const spy = vi.spyOn(process, "cwd").mockReturnValue(host);
    try {
      const sink = output();
      expect(await hintFor(root, sink)).toBe(0);
      expect(sink.errors.join("\n")).toContain("vendo init .");
    } finally {
      spy.mockRestore();
    }
  });

  it("non-interactive is unchanged: the exact-flag error, no hint", async () => {
    const sink = output();
    expect(await run(await monorepo(), sink, { yes: true })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Pass --framework");
    expect(sink.errors.join("\n")).not.toContain("did you mean");
  });
});
