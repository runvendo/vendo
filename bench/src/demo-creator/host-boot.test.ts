import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecFn, ExecResult } from "./exec.js";
import { buildHost, defaultHostCommands, generateManifest, localBootEnv, smokeTurnWaitOptions } from "./host-boot.js";

/** The frozen codegen target: host/src/generated/manifest.ts. */
const manifestPath = (demosRepo: string): string =>
  path.join(demosRepo, "host", "src", "generated", "manifest.ts");

function fakeExec(results: Partial<ExecResult>[]): {
  exec: ExecFn;
  calls: { command: string[]; cwd: string; env?: NodeJS.ProcessEnv }[];
} {
  const calls: { command: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const queue = [...results];
  const exec: ExecFn = async (command, options) => {
    calls.push({ command, cwd: options.cwd, ...(options.env === undefined ? {} : { env: options.env }) });
    const next = queue.shift() ?? {};
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { exec, calls };
}

/** A vendo-demos checkout whose manifest already imports `slugs`. */
async function fakeDemosRepo(slugs: string[]): Promise<string> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-host-boot-"));
  await mkdir(path.dirname(manifestPath(demosRepo)), { recursive: true });
  await writeFile(
    manifestPath(demosRepo),
    slugs.map((slug) => `import screens_${slug.replaceAll("-", "_")} from "../../../demos/${slug}/screens/index.js";`).join("\n"),
  );
  return demosRepo;
}

describe("defaultHostCommands", () => {
  it("are the documented vendo-demos host commands", () => {
    expect(defaultHostCommands.genManifest).toEqual(["node", "scripts/gen-manifest.mjs"]);
    expect(defaultHostCommands.install).toEqual(["pnpm", "install"]);
    expect(defaultHostCommands.build).toEqual(["pnpm", "build"]);
  });

  it("threads the port into the start command", () => {
    expect(defaultHostCommands.start(4310)).toEqual(["pnpm", "start", "--port", "4310"]);
  });
});

describe("generateManifest", () => {
  it("runs the gen-manifest script inside the host package", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec, calls } = fakeExec([{ code: 0 }]);
    await generateManifest({ demosRepo, exec });
    expect(calls).toEqual([{ command: ["node", "scripts/gen-manifest.mjs"], cwd: path.join(demosRepo, "host") }]);
  });

  it("reports the slugs the generated manifest actually imports", async () => {
    const demosRepo = await fakeDemosRepo(["acme", "globex-labs"]);
    const { exec } = fakeExec([{ code: 0 }]);
    await expect(generateManifest({ demosRepo, exec })).resolves.toEqual({
      manifestPath: manifestPath(demosRepo),
      slugs: ["acme", "globex-labs"],
    });
  });

  it("fails with the script's own output when it exits non-zero", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{ code: 1, stderr: "ENOENT demos/\nstack frame" }]);
    await expect(generateManifest({ demosRepo, exec })).rejects.toThrow(/gen-manifest failed[\s\S]*ENOENT demos\//);
  });

  /**
   * The real script prints a HEADER and then the problems, one per line:
   *
   *   [gen-manifest] the demo folder contract is not honored:
   *     demos/ramp-bills: missing tools.json
   *
   * Reporting only the first line therefore reported a failure with no reason at
   * all — every actual cause is on a later line. It cost a diagnosis round on a
   * live run, and in Slack it is a mystery failure.
   */
  it("relays the real cause, which the script prints AFTER its header line", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{
      code: 1,
      stderr: "[gen-manifest] the demo folder contract is not honored:\n  demos/ramp-bills: missing tools.json\n  demos/zelty/theme.json is not legible",
    }]);
    const error = await generateManifest({ demosRepo, exec }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toContain("missing tools.json");
    expect(error.message).toContain("theme.json is not legible");
  });

  // Next-style failures split across the streams: the cause is on stdout while
  // stderr holds only a warning, so picking one stream hides it.
  it("relays both streams, because the cause is not reliably on either one", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{ code: 1, stdout: "  demos/acme: missing openapi.json", stderr: "(node:1) ExperimentalWarning: type stripping" }]);
    const error = await generateManifest({ demosRepo, exec }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toContain("missing openapi.json");
  });

  it("stays bounded — a failing script can print megabytes", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{ code: 1, stderr: `${"noise\n".repeat(4_000)}  demos/acme: missing tools.json` }]);
    const error = await generateManifest({ demosRepo, exec }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toContain("missing tools.json");
    expect(error.message.length).toBeLessThan(3_200);
  });

  it("scrubs env secrets out of the script's failure line", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const token = "ghp_manifestscripttoken";
    const { exec } = fakeExec([{ code: 1, stderr: `Error: GITHUB_TOKEN=${token} is not valid` }]);
    const error = await generateManifest({ demosRepo, exec, env: { GITHUB_TOKEN: token } })
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("<redacted>");
  });

  it("fails loudly when the script wrote no manifest at all", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-host-boot-"));
    const { exec } = fakeExec([{ code: 0 }]);
    await expect(generateManifest({ demosRepo, exec })).rejects.toThrow(/manifest\.ts/);
  });
});

describe("buildHost", () => {
  it("builds inside the host package with the caller's env", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec, calls } = fakeExec([{ code: 0 }]);
    await buildHost({ demosRepo, exec, env: { VENDO_API_KEY: "vk_test" } });
    expect(calls).toEqual([{
      command: ["pnpm", "build"],
      cwd: path.join(demosRepo, "host"),
      env: { VENDO_API_KEY: "vk_test" },
    }]);
  });

  // "A failing demo NEVER gets pushed" is this throw; the tail is what an
  // operator needs to see the real type error, so it must survive — bounded,
  // because a Next build's full log is megabytes.
  it("throws with the tail of the build output on a non-zero exit", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{
      code: 1,
      stdout: `${"noise\n".repeat(4_000)}Type error: Property 'x' does not exist`,
    }]);
    const error = await buildHost({ demosRepo, exec }).catch((thrown: unknown) => thrown as Error);
    expect(error.message).toMatch(/host build failed/);
    expect(error.message).toMatch(/Property 'x' does not exist/);
    expect(error.message.length).toBeLessThan(3_200);
  });

  // The host build is handed the pipeline's whole environment, and Next echoes
  // env-shaped text on some failures — so the tail that reaches an operator (or
  // a Slack thread) goes through the scrubber first.
  it("never leaks an env secret into the thrown build error", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const key = "vk_live_supersecretvalue";
    const { exec } = fakeExec([{ code: 1, stderr: `deploy target rejected VENDO_API_KEY=${key}` }]);
    const error = await buildHost({ demosRepo, exec, env: { VENDO_API_KEY: key } })
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain("<redacted>");
  });

  it("leaves short and non-credential values readable — over-redaction makes the error useless", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{ code: 1, stdout: "build ran with NODE_ENV=production API_KEY=short" }]);
    const error = await buildHost({ demosRepo, exec, env: { NODE_ENV: "production", API_KEY: "short" } })
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).toContain("NODE_ENV=production");
    expect(error.message).toContain("API_KEY=short");
  });
});

describe("smokeTurnWaitOptions", () => {
  // The old test restated the function body — it passed for any pass-through,
  // including one that had lost `requireView` entirely. What the contract
  // actually claims is a PROPERTY: whatever the caller asks for, the smoke turn
  // never requires a generated view, because content is stage 5's business.
  it("never requires a generated view, whatever it is asked", () => {
    for (const timeoutMs of [1_000, 90_000, 180_000]) {
      for (const previousAssistantTurns of [0, 1, 7]) {
        const options = smokeTurnWaitOptions({ previousAssistantTurns, timeoutMs });
        expect(options.requireView).toBe(false);
        // …and it must still carry the two values the wait needs to work at all.
        expect(options.previousAssistantTurns).toBe(previousAssistantTurns);
        expect(options.timeoutMs).toBe(timeoutMs);
      }
    }
  });

  // The option object is fed straight to the capture harness's waitForTurn, so
  // the keys have to be exactly the ones it reads — a renamed key would silently
  // become "requireView undefined", which is falsy and therefore looks fine.
  it("names the keys waitForTurn actually reads", () => {
    expect(Object.keys(smokeTurnWaitOptions({ previousAssistantTurns: 1, timeoutMs: 1 })).sort())
      .toEqual(["previousAssistantTurns", "requireView", "timeoutMs"]);
  });
});

describe("localBootEnv", () => {
  // A live run burned its whole 180s smoke budget on /login because the local
  // boot did not carry the deployment's own autologin knob.
  it("turns on autologin bound to the loopback origin it just started", () => {
    expect(localBootEnv({ PATH: "/usr/bin" }, 3150)).toEqual({
      PATH: "/usr/bin",
      DEMO_AUTOLOGIN: "1",
      VENDO_BASE_URL: "http://127.0.0.1:3150",
    });
  });

  it("never overrides what the operator set", () => {
    const env = { DEMO_AUTOLOGIN: "0", VENDO_BASE_URL: "https://demos.vendo.run" };
    expect(localBootEnv(env, 3150)).toEqual(env);
  });
});
