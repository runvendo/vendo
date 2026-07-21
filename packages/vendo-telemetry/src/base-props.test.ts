import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { baseProps, normalizeRemoteUrl, projectProps, PROJECT_ID_SALT } from "./base-props.js";

describe("baseProps", () => {
  it("returns only allowlisted base keys with primitive values", () => {
    const p = baseProps("1.2.3");
    expect(p.vendoVersion).toBe("1.2.3");
    expect(typeof p.osPlatform).toBe("string");
    expect(typeof p.nodeVersion).toBe("string");
    expect(Object.keys(p).sort()).toEqual(["nodeVersion", "osPlatform", "vendoVersion"]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vendo-tele-proj-"));
  dirs.push(dir);
  return dir;
}

function gitRepoDir(originUrl?: string): string {
  const dir = tempDir();
  mkdirSync(join(dir, ".git"));
  const origin =
    originUrl === undefined
      ? ""
      : `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  writeFileSync(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${origin}`);
  return dir;
}

function expectedHash(input: string): string {
  return createHash("sha256").update(PROJECT_ID_SALT + input).digest("hex");
}

describe("normalizeRemoteUrl", () => {
  it.each([
    ["git@github.com:RunVendo/Vendo.git", "github.com/runvendo/vendo"],
    ["https://github.com/runvendo/vendo.git", "github.com/runvendo/vendo"],
    ["ssh://git@github.com/runvendo/vendo.git", "github.com/runvendo/vendo"],
    [" https://github.com/runvendo/vendo/ ", "github.com/runvendo/vendo"],
  ])("normalizes %s to %s", (url, expected) => {
    expect(normalizeRemoteUrl(url)).toBe(expected);
  });

  it("strips an explicit port so ssh and https spellings still match", () => {
    expect(normalizeRemoteUrl("https://git.corp.example:8443/group/repo.git")).toBe(
      "git.corp.example/group/repo",
    );
    expect(normalizeRemoteUrl("ssh://git@git.corp.example:8443/group/repo.git")).toBe(
      "git.corp.example/group/repo",
    );
  });

  it("leaves scp-style paths intact when there is no port", () => {
    expect(normalizeRemoteUrl("git@github.com:a/b.git")).toBe("github.com/a/b");
  });
});

describe("projectProps.projectIdHash", () => {
  it("is a deterministic salted sha256 of the normalized origin url", () => {
    const dir = gitRepoDir("https://github.com/runvendo/vendo.git");
    const p = projectProps({}, dir);
    expect(p.projectIdHash).toBe(expectedHash("github.com/runvendo/vendo"));
    expect(projectProps({}, dir).projectIdHash).toBe(p.projectIdHash);
  });

  it("hashes ssh and https variants of the same repo identically", () => {
    const variants = [
      "git@github.com:RunVendo/Vendo.git",
      "https://github.com/runvendo/vendo",
      "https://github.com/runvendo/vendo.git",
      "ssh://git@github.com/runvendo/vendo.git",
      " https://github.com/runvendo/vendo/ ",
    ];
    const hashes = variants.map((url) => projectProps({}, gitRepoDir(url)).projectIdHash);
    for (const h of hashes) expect(h).toBe(expectedHash("github.com/runvendo/vendo"));
  });

  it("distinct repos hash to distinct values", () => {
    const a = projectProps({}, gitRepoDir("https://github.com/a/one")).projectIdHash;
    const b = projectProps({}, gitRepoDir("https://github.com/a/two")).projectIdHash;
    expect(a).not.toBe(b);
  });

  it("falls back to package.json name when there is no git remote", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(projectProps({}, dir).projectIdHash).toBe(expectedHash("my-app"));
  });

  it("falls back to package.json name when the repo has no origin remote", () => {
    const dir = gitRepoDir(undefined);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(projectProps({}, dir).projectIdHash).toBe(expectedHash("my-app"));
  });

  it("is omitted entirely when neither source exists", () => {
    const p = projectProps({}, tempDir());
    expect("projectIdHash" in p).toBe(false);
  });

  it("resolves a linked worktree's .git pointer file back to the main repo config", () => {
    // Mirror `git worktree add` layout: the linked checkout gets a `.git` FILE
    // pointing at <main>/.git/worktrees/<name>, whose `commondir` file points
    // back at the shared <main>/.git that holds the real config.
    const main = gitRepoDir("https://github.com/runvendo/vendo.git");
    const worktreeGitDir = join(main, ".git", "worktrees", "wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    const linked = tempDir();
    writeFileSync(join(linked, ".git"), `gitdir: ${worktreeGitDir}\n`);
    expect(projectProps({}, linked).projectIdHash).toBe(expectedHash("github.com/runvendo/vendo"));
  });

  it("never throws on unreadable or malformed git state", () => {
    const broken = tempDir();
    writeFileSync(join(broken, ".git"), "not a real gitdir pointer");
    writeFileSync(join(broken, "package.json"), "{ malformed json");
    expect(() => projectProps({}, broken)).not.toThrow();
    expect(projectProps({}, broken).projectIdHash).toBeUndefined();
  });
});

describe("projectProps.packageManager", () => {
  it.each([
    ["npm/10.5.0 node/v20.11.0 darwin arm64", "npm"],
    ["pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64", "pnpm"],
    ["yarn/4.1.1 npm/? node/v20.11.0 darwin arm64", "yarn"],
    ["bun/1.1.0 npm/? node/v20.11.0 darwin arm64", "bun"],
  ])("parses %s as %s", (ua, expected) => {
    expect(projectProps({ npm_config_user_agent: ua }, tempDir()).packageManager).toBe(expected);
  });

  it("is omitted for unknown agents", () => {
    const p = projectProps({ npm_config_user_agent: "weirdpm/1.0.0 node/v20" }, tempDir());
    expect("packageManager" in p).toBe(false);
  });

  it("is omitted when the env var is absent", () => {
    const p = projectProps({}, tempDir());
    expect("packageManager" in p).toBe(false);
  });
});
