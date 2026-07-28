import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecFn, ExecResult } from "./exec.js";
import { buildHost, defaultHostCommands, generateManifest } from "./host-boot.js";

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

  it("fails with the script's own first line when it exits non-zero", async () => {
    const demosRepo = await fakeDemosRepo(["acme"]);
    const { exec } = fakeExec([{ code: 1, stderr: "ENOENT demos/\nstack frame" }]);
    await expect(generateManifest({ demosRepo, exec })).rejects.toThrow(/gen-manifest failed[\s\S]*ENOENT demos\//);
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
});
