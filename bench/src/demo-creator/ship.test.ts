import { describe, expect, it, vi } from "vitest";
import type { ExecFn, ExecResult } from "./exec.js";
import { isTransientRailwayFailure, railwayAttempts, runShip, type ShipIo } from "./ship.js";

const commit = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const railwayDomain = "host-production-1234.up.railway.app";

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

function defaultReply(command: string[]): ExecResult {
  if (command.includes("rev-parse")) return { code: 0, stdout: `${commit}\n`, stderr: "" };
  if (command.includes("domain")) return { code: 0, stdout: JSON.stringify({ domain: railwayDomain }), stderr: "" };
  return ok;
}

function stubExec(reply: (command: string[]) => ExecResult = defaultReply): {
  exec: ExecFn;
  calls: { command: string[]; cwd: string }[];
} {
  const calls: { command: string[]; cwd: string }[] = [];
  const exec = vi.fn<ExecFn>(async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    return reply(command);
  });
  return { exec, calls };
}

/** Answers 200 for the listed URLs and 404 for everything else. */
function stubFetch(ready: string[]): typeof fetch {
  return vi.fn(async (input: unknown) =>
    new Response("", { status: ready.includes(String(input)) ? 200 : 404 })) as unknown as typeof fetch;
}

const args = { slug: "acme", prospect: "Acme Corp" };

function shipIo(overrides: Partial<ShipIo> & Pick<ShipIo, "exec">): ShipIo {
  return {
    demosRepo: "/tmp/vendo-demos",
    fetchImpl: stubFetch(["https://demos.vendo.run/acme"]),
    write: () => {},
    env: {},
    retryWaitMs: 0,
    pollTimeoutMs: 0,
    ...overrides,
  };
}

describe("isTransientRailwayFailure", () => {
  it("matches the observed TLS/network flakes", () => {
    expect(isTransientRailwayFailure("error sending request: BadRecordMac")).toBe(true);
    expect(isTransientRailwayFailure("tcp connect error: Connection reset by peer")).toBe(true);
    expect(isTransientRailwayFailure("upstream returned 502 Bad Gateway")).toBe(true);
  });

  it("does not match a real build failure", () => {
    expect(isTransientRailwayFailure("Dockerfile:14\nERROR: process did not complete successfully: exit code 1")).toBe(false);
    expect(isTransientRailwayFailure("Error: service host not found in project")).toBe(false);
  });
});

describe("runShip", () => {
  it("commits only the demo's own path, pushes, deploys the host, and returns the live URL", async () => {
    const { exec, calls } = stubExec();
    const result = await runShip(args, shipIo({ exec }));
    const argvs = calls.map((call) => call.command);
    expect(argvs).toContainEqual(["git", "add", "--", "demos/acme"]);
    expect(argvs.flat()).not.toContain("-A");
    expect(argvs.some((argv) => argv.includes("commit") && argv.includes("demo(acme): Acme Corp"))).toBe(true);
    expect(argvs).toContainEqual(["git", "push", "origin", "HEAD:main"]);
    expect(argvs).toContainEqual(["railway", "link", "--project", "vendo-demos"]);
    expect(argvs).toContainEqual(["railway", "up", "--service", "host", "--detach"]);
    // Host env belongs to the operator: a pipeline that rewrites service
    // variables would reconfigure every other demo on the shared service.
    expect(argvs.flat()).not.toContain("variables");
    expect(calls.every((call) => call.cwd === "/tmp/vendo-demos")).toBe(true);
    expect(result).toEqual({ commit, liveUrl: "https://demos.vendo.run/acme", attempts: 1, railwayDomain });
  });

  it("polls the public URL and the railway domain in ONE deadline, preferring the public one", async () => {
    // Pre-cutover demos.vendo.run never answers, so polling it to exhaustion
    // before trying the domain that works would spend the whole live budget.
    const { exec } = stubExec();
    const fetchImpl = stubFetch(["https://demos.vendo.run/acme", `https://${railwayDomain}/acme`]);
    const result = await runShip(args, shipIo({ exec, fetchImpl }));
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
    // Both candidates were known before the first wait, not after a timeout.
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe("https://demos.vendo.run/acme");
  });

  it("commits with a git identity from the environment", async () => {
    const { exec, calls } = stubExec();
    await runShip(args, shipIo({ exec, env: { GIT_AUTHOR_NAME: "Vendo Bot", GIT_AUTHOR_EMAIL: "bot@vendo.run" } }));
    const commitArgv = calls.map((call) => call.command).find((argv) => argv.includes("commit")) ?? [];
    expect(commitArgv).toContain("user.name=Vendo Bot");
    expect(commitArgv).toContain("user.email=bot@vendo.run");
  });

  it("treats nothing-to-commit as fine and still deploys", async () => {
    const lines: string[] = [];
    const { exec, calls } = stubExec((command) =>
      command.includes("commit")
        ? { code: 1, stdout: "nothing to commit, working tree clean\n", stderr: "" }
        : defaultReply(command));
    const result = await runShip(args, shipIo({ exec, write: (line) => lines.push(line) }));
    expect(calls.map((call) => call.command)).toContainEqual(["railway", "up", "--service", "host", "--detach"]);
    expect(result.commit).toBe(commit);
    expect(lines.join("\n")).toContain("nothing to commit");
  });

  it("retries a transient railway up exactly up to the attempt cap, then throws", async () => {
    const { exec, calls } = stubExec((command) =>
      command.includes("up")
        ? { code: 1, stdout: "", stderr: "error sending request for url: BadRecordMac" }
        : defaultReply(command));
    await expect(runShip(args, shipIo({ exec }))).rejects.toThrow(/6 attempts/);
    expect(calls.filter((call) => call.command.includes("up"))).toHaveLength(railwayAttempts);
  });

  it("does not retry a real build failure", async () => {
    const { exec, calls } = stubExec((command) =>
      command.includes("up")
        ? { code: 1, stdout: "", stderr: "Dockerfile:14\nERROR: process did not complete successfully: exit code 1" }
        : defaultReply(command));
    await expect(runShip(args, shipIo({ exec }))).rejects.toThrow(/railway up/);
    expect(calls.filter((call) => call.command.includes("up"))).toHaveLength(1);
  });

  it("falls back to the service's railway domain when the public URL never answers", async () => {
    const { exec } = stubExec();
    const result = await runShip(args, shipIo({ exec, fetchImpl: stubFetch([`https://${railwayDomain}/acme`]) }));
    expect(result.liveUrl).toBe(`https://${railwayDomain}/acme`);
    expect(result.railwayDomain).toBe(railwayDomain);
  });

  it("throws a one-line cause naming both URLs when neither answers", async () => {
    const { exec } = stubExec();
    const error = await runShip(args, shipIo({ exec, fetchImpl: stubFetch([]) })).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("\n");
    expect((error as Error).message).toContain("https://demos.vendo.run/acme");
    expect((error as Error).message).toContain(railwayDomain);
  });

  it("never leaks a secret from child output into what it writes or throws", async () => {
    const key = "sk-ant-supersecret-value";
    const lines: string[] = [];
    const { exec } = stubExec((command) =>
      command.includes("up")
        ? { code: 1, stdout: "", stderr: `deploy failed with ANTHROPIC_API_KEY=${key} in the environment` }
        : defaultReply(command));
    const promise = runShip(args, shipIo({
      exec,
      write: (line) => lines.push(line),
      env: { ANTHROPIC_API_KEY: key },
    }));
    await expect(promise).rejects.toThrow(/<redacted>/);
    await promise.catch((error: Error) => { expect(error.message).not.toContain(key); });
    expect(lines.join("\n")).not.toContain(key);
  });
});
