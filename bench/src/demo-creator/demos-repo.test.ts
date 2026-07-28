import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultDemosRepo, demosRepoRemote, ensureDemosRepo } from "./demos-repo.js";
import type { ExecFn, ExecResult } from "./exec.js";

const head = "9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";

function stubExec(reply: (command: string[]) => ExecResult): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec = vi.fn<ExecFn>(async (command) => {
    calls.push(command);
    return reply(command);
  });
  return { exec, calls };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

function defaultReply(command: string[]): ExecResult {
  if (command.includes("rev-parse")) return { code: 0, stdout: `${head}\n`, stderr: "" };
  if (command.join(" ") === "git remote") return { code: 0, stdout: "origin\n", stderr: "" };
  return ok;
}

describe("defaultDemosRepo", () => {
  it("is ~/.vendo/vendo-demos", () => {
    expect(defaultDemosRepo({ HOME: "/Users/vendo" })).toBe("/Users/vendo/.vendo/vendo-demos");
  });
});

describe("ensureDemosRepo", () => {
  it("clones the host repo when the directory holds no git checkout", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    const dir = path.join(parent, "vendo-demos");
    const { exec, calls } = stubExec(defaultReply);
    const result = await ensureDemosRepo(dir, { exec, write: () => {} });
    expect(calls[0]).toEqual(["git", "clone", demosRepoRemote, dir]);
    expect(result).toEqual({ dir, cloned: true, head });
  });

  it("fast-forwards an existing checkout and never resets local state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const { exec, calls } = stubExec(defaultReply);
    const result = await ensureDemosRepo(dir, { exec, write: () => {} });
    expect(calls[1]).toEqual(["git", "pull", "--ff-only", "origin", "main"]);
    expect(calls.flat()).not.toContain("reset");
    expect(calls.flat()).not.toContain("clone");
    expect(result).toEqual({ dir, cloned: false, head });
  });

  it("uses an origin-less checkout as it stands — that is what --demos-repo is for", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const { exec, calls } = stubExec((command) =>
      command.join(" ") === "git remote" ? ok : defaultReply(command));
    const lines: string[] = [];
    const result = await ensureDemosRepo(dir, { exec, write: (line) => lines.push(line) });
    expect(calls.flat()).not.toContain("pull");
    expect(lines.some((line) => line.includes("no origin remote"))).toBe(true);
    expect(result).toEqual({ dir, cloned: false, head });
  });

  it("fails loudly and names the fix when the pull cannot fast-forward", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const { exec } = stubExec((command) =>
      command.includes("pull")
        ? { code: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" }
        : defaultReply(command));
    await expect(ensureDemosRepo(dir, { exec, write: () => {} })).rejects.toThrow(/fast-forward/);
    await expect(ensureDemosRepo(dir, { exec, write: () => {} })).rejects.toThrow(dir);
  });

  /** A push token lives in the remote URL in .git/config, NOT in the
   * environment, so env-name scrubbing cannot see it — git quoting its own
   * remote back in a failure is how a PAT reaches a log or a Slack thread. */
  it("never leaks a PAT embedded in the remote URL into the thrown pull error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const token = "ghp_realpushtokenvalue";
    const { exec } = stubExec((command) =>
      command.includes("pull")
        ? { code: 1, stdout: "", stderr: `fatal: unable to access 'https://x-access-token:${token}@github.com/runvendo/vendo-demos.git/': 403\n` }
        : defaultReply(command));
    const error = await ensureDemosRepo(dir, { exec, write: () => {} }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("://<redacted>@github.com");
  });

  it("scrubs env secrets out of any git failure it relays", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-demos-repo-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const token = "ghp_environmenttokenvalue";
    const { exec } = stubExec((command) =>
      command.includes("rev-parse")
        ? { code: 1, stdout: "", stderr: `fatal: bad object (GITHUB_TOKEN=${token})\n` }
        : defaultReply(command));
    const error = await ensureDemosRepo(dir, { exec, write: () => {}, env: { GITHUB_TOKEN: token } })
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("<redacted>");
  });
});
