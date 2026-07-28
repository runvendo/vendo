import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecFn, ExecResult } from "./exec.js";
import { isTransientRailwayFailure, parseRailwayDomain, railwayAttempts, runShip, type ShipIo } from "./ship.js";

const commit = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const railwayDomain = "host-production-1234.up.railway.app";

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

function defaultReply(command: string[]): ExecResult {
  if (command.includes("rev-parse")) return { code: 0, stdout: `${commit}\n`, stderr: "" };
  if (command.includes("domain")) return { code: 0, stdout: JSON.stringify({ domain: railwayDomain }), stderr: "" };
  return ok;
}

/** The deployment ids the shared stub reports: one that predates the run, and the
 * one `railway up` creates. */
const priorDeployment = { id: "dep-old", status: "SUCCESS", createdAt: "2026-07-27T00:00:00.000Z" };
const submittedDeployment = { id: "dep-new", status: "SUCCESS", createdAt: "2026-07-28T00:00:00.000Z" };

function stubExec(reply: (command: string[]) => ExecResult = defaultReply): {
  exec: ExecFn;
  calls: { command: string[]; cwd: string }[];
} {
  const calls: { command: string[]; cwd: string }[] = [];
  let uploaded = false;
  const exec = vi.fn<ExecFn>(async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    // The readiness gate reads the deployment list on every run. Answering it
    // HERE keeps each test's own `reply` about the one thing that test pins,
    // and models the real sequence: our deployment does not exist until `up`.
    if (command.includes("deployment") && command.includes("list")) {
      const rows = uploaded ? [submittedDeployment, priorDeployment] : [priorDeployment];
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    }
    const result = reply(command);
    if (command.includes("up") && result.code === 0) uploaded = true;
    return result;
  });
  return { exec, calls };
}

/** The marker the real host's product page carries: its own slug, in the
 * per-slug wire and chrome. A login page and a Railway placeholder do not. */
const demoBody = '<html><body data-demo="acme">Acme Corp</body></html>';

/** Answers 200 with a real demo page for the listed URLs, 404 for everything
 * else. */
function stubFetch(ready: string[]): typeof fetch {
  return vi.fn(async (input: unknown) =>
    ready.includes(String(input))
      ? new Response(demoBody, { status: 200 })
      : new Response("", { status: 404 })) as unknown as typeof fetch;
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
    deploymentPollMs: 0,
    ...overrides,
  };
}

// `railway up --detach` returns as soon as the upload is QUEUED — measured at
// 6.06s on a real run whose build then took minutes. Meanwhile the PREVIOUS
// deployment keeps serving, so a plain "any 200 with the slug in it" check passes
// instantly against the OLD build. For a brand-new slug the old build 404s and
// the marker saves us by accident; for `demo:fix`, or any re-run of a slug that
// is already live, it does not — the pipeline prints LIVE, Yousef sends the
// prospect a link to the old build, and the fix he asked for looks like a no-op.
describe("runShip deployment readiness", () => {
  /** Deployment listings: the pre-`up` state, then what the poll sees in order. */
  function railwayExec(listings: string[]): { exec: ExecFn; calls: string[][]; listCount: () => number } {
    const calls: string[][] = [];
    let listIndex = 0;
    const exec = vi.fn<ExecFn>(async (command, options) => {
      calls.push(command);
      void options;
      if (command.includes("deployment") && command.includes("list")) {
        const body = listings[Math.min(listIndex, listings.length - 1)] ?? "[]";
        listIndex += 1;
        return { code: 0, stdout: body, stderr: "" };
      }
      return defaultReply(command);
    });
    return { exec, calls, listCount: () => listIndex };
  }

  const deployment = (id: string, status: string, createdAt = "2026-07-28T09:35:15.858Z"): Record<string, unknown> =>
    ({ id, status, createdAt });
  const listing = (...entries: Record<string, unknown>[]): string => JSON.stringify(entries);

  it("waits for the deployment it submitted rather than any 200", async () => {
    const { exec, calls } = railwayExec([
      // before `up`: only the old deployment exists
      listing(deployment("old-1", "SUCCESS")),
      // after `up`: ours exists but is still building
      listing(deployment("new-1", "BUILDING"), deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "DEPLOYING"), deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "SUCCESS"), deployment("old-1", "SUCCESS")),
    ]);
    const result = await runShip(args, shipIo({ exec }));
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
    expect(result.deploymentId).toBe("new-1");
    // It asked Railway about the specific service's deployments, in JSON.
    const listed = calls.filter((argv) => argv.includes("deployment") && argv.includes("list"));
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]).toContain("--json");
    expect(listed[0]).toContain("host");
  });

  it("never polls the URL while the submitted deployment is still building", async () => {
    const order: string[] = [];
    const listings = [
      listing(deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "BUILDING"), deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "SUCCESS"), deployment("old-1", "SUCCESS")),
    ];
    let listIndex = 0;
    const exec = vi.fn<ExecFn>(async (command) => {
      if (command.includes("deployment") && command.includes("list")) {
        order.push(`list:${listIndex}`);
        const body = listings[Math.min(listIndex, listings.length - 1)] ?? "[]";
        listIndex += 1;
        return { code: 0, stdout: body, stderr: "" };
      }
      if (command.includes("up")) order.push("up");
      return defaultReply(command);
    });
    // The old deployment WOULD answer 200 with the slug marker — the whole trap.
    const fetchImpl = vi.fn(async () => {
      order.push("fetch");
      return new Response(demoBody, { status: 200 });
    }) as unknown as typeof fetch;

    await runShip(args, shipIo({ exec, fetchImpl }));

    // Every deployment-status read happens before the first HTTP probe.
    expect(order.indexOf("fetch")).toBeGreaterThan(order.lastIndexOf("list:1"));
    expect(order.slice(0, 2)).toEqual(["list:0", "up"]);
  });

  it("fails loudly when the deployment it submitted fails to build", async () => {
    const { exec } = railwayExec([
      listing(deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "BUILDING"), deployment("old-1", "SUCCESS")),
      listing(deployment("new-1", "FAILED"), deployment("old-1", "SUCCESS")),
    ]);
    // The old build is still happily serving the slug — which must NOT rescue it.
    await expect(runShip(args, shipIo({ exec }))).rejects.toThrow(/FAILED/);
  });

  it("refuses to claim LIVE when Railway's deployment list cannot be read", async () => {
    const exec = vi.fn<ExecFn>(async (command) =>
      command.includes("deployment") && command.includes("list")
        ? { code: 1, stdout: "", stderr: "unknown subcommand 'deployment'" }
        : defaultReply(command));
    // Unverifiable must not read as deployed, even though the URL answers 200.
    await expect(runShip(args, shipIo({ exec }))).rejects.toThrow(/deployment/i);
  });
});

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

describe("parseRailwayDomain", () => {
  // The REAL output of `railway domain --service host --json`, captured from the
  // CLI on 2026-07-27: a `domains` ARRAY, not the `domain` string the primary
  // parse looks for. The regex fallback is what carries this shape — which is
  // exactly why it exists, and why it is pinned here now that the shape is known.
  it("reads the shape the railway CLI actually returns", () => {
    const real = '{\n  "domains": [\n    "https://host-production-b9a5.up.railway.app"\n  ]\n}';
    expect(parseRailwayDomain(real)).toBe("host-production-b9a5.up.railway.app");
  });

  it("still reads a bare `domain` string, and gives up cleanly on neither", () => {
    expect(parseRailwayDomain(JSON.stringify({ domain: "https://host-x.up.railway.app/" })))
      .toBe("host-x.up.railway.app");
    expect(parseRailwayDomain("No linked project found. Run railway link")).toBeUndefined();
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
    // deploymentId is new: the run reports WHICH deployment it proved live, so a
    // LIVE line can no longer be the previous build answering 200.
    expect(result).toEqual({ commit, liveUrl: "https://demos.vendo.run/acme", attempts: 1, railwayDomain, deploymentId: "dep-new" });
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

  // The run's timing evidence lives inside the folder being committed, so it has
  // to be on disk BEFORE `git add` — otherwise the commit under-reports the run
  // and the later write leaves the folder dirty for the next slug.
  it("finalises the run's timings before staging the folder", async () => {
    const timeline: string[] = [];
    const { exec } = stubExec((command) => {
      if (command.includes("add")) timeline.push("git-add");
      return defaultReply(command);
    });
    await runShip(args, shipIo({ exec, finalizeTimings: async () => { timeline.push("finalize-timings"); } }));
    expect(timeline.slice(0, 2)).toEqual(["finalize-timings", "git-add"]);
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

  /** ensureDemosRepo fast-forwarded minutes ago, so another pipeline (or lane 1
   * pushing the host) can land a commit in between. Dying here loses a demo that
   * already built and passed the smoke turn. */
  it("recovers from a concurrent push by rebasing onto main and pushing once more", async () => {
    let pushes = 0;
    const { exec, calls } = stubExec((command) => {
      if (!command.includes("push")) return defaultReply(command);
      pushes += 1;
      return pushes === 1
        ? { code: 1, stdout: "", stderr: "! [rejected] HEAD -> main (fetch first)\nhint: Updates were rejected" }
        : ok;
    });
    const result = await runShip(args, shipIo({ exec }));
    const argvs = calls.map((call) => call.command);
    expect(argvs).toContainEqual(["git", "pull", "--rebase", "origin", "main"]);
    expect(argvs.filter((argv) => argv.includes("push"))).toHaveLength(2);
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
  });

  it("throws naming the fix when the push is still rejected after the rebase", async () => {
    const { exec, calls } = stubExec((command) =>
      command.includes("push")
        ? { code: 1, stdout: "", stderr: "! [rejected] HEAD -> main (non-fast-forward)" }
        : defaultReply(command));
    const error = await runShip(args, shipIo({ exec })).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toMatch(/rejected/);
    expect(error.message).toContain("/tmp/vendo-demos");
    expect(calls.map((call) => call.command).filter((argv) => argv.includes("push"))).toHaveLength(2);
  });

  it("does not rebase when the push fails for a reason a rebase cannot fix", async () => {
    const { exec, calls } = stubExec((command) =>
      command.includes("push")
        ? { code: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/runvendo/vendo-demos.git/'" }
        : defaultReply(command));
    await expect(runShip(args, shipIo({ exec }))).rejects.toThrow(/Authentication failed/);
    expect(calls.map((call) => call.command).filter((argv) => argv.includes("push"))).toHaveLength(1);
    expect(calls.flatMap((call) => call.command)).not.toContain("--rebase");
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

  it("never leaks a credential git echoed back from a remote URL", async () => {
    const token = "ghp_shippushtokenvalue";
    const { exec } = stubExec((command) =>
      command.includes("push")
        ? { code: 128, stdout: "", stderr: `fatal: unable to access 'https://x-access-token:${token}@github.com/runvendo/vendo-demos.git/': 403` }
        : defaultReply(command));
    const error = await runShip(args, shipIo({ exec })).catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("://<redacted>@github.com");
  });

  // The host's auth middleware REDIRECTS an unauthenticated visitor to /login,
  // which answers a clean 200. With `redirect: "follow"` the poll saw that 200
  // and printed LIVE — so a deployment whose DEMO_AUTOLOGIN or VENDO_BASE_URL is
  // wrong reported a working demo that shows every prospect a login wall.
  it("does not call a redirect to the login wall live", async () => {
    const { exec } = stubExec();
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response("", { status: 307, headers: { location: "/login?returnTo=%2Facme" } });
    }) as unknown as typeof fetch;
    const error = await runShip(args, shipIo({ exec, fetchImpl })).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toContain("307");
  });

  // A 200 that is not the demo: the pre-cutover router, a Railway placeholder,
  // or a rewritten card. The demo's own slug is the marker.
  it("does not call a 200 that is not this demo live", async () => {
    const { exec } = stubExec();
    const fetchImpl = vi.fn(async () =>
      new Response("<html><body>Application not found</body></html>", { status: 200 })) as unknown as typeof fetch;
    const error = await runShip(args, shipIo({ exec, fetchImpl })).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toMatch(/marker|not the demo|acme/i);
  });

  // Last gate before the push: a symlink inside the demo folder commits as mode
  // 120000 and the host reads through it.
  it("refuses to commit a demo folder holding a symlink", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "lane2-ship-symlink-"));
    const demo = path.join(repo, "demos", "acme");
    await mkdir(demo, { recursive: true });
    await symlink("/etc/passwd", path.join(demo, "logo.png"));
    const { exec, calls } = stubExec();
    await expect(runShip(args, shipIo({ exec, demosRepo: repo }))).rejects.toThrow(/symlink/i);
    // Nothing was staged, committed or deployed.
    expect(calls).toHaveLength(0);
  });
});
