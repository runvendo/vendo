import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAssemble, type AssembleIo } from "./assemble.js";
import type { ExecFn, ExecResult } from "./exec.js";
import type { RunningHost, SmokeTurnFn } from "./host-boot.js";

const manifestPath = (demosRepo: string): string =>
  path.join(demosRepo, "host", "src", "generated", "manifest.ts");

/** A vendo-demos checkout whose manifest imports `slugs`; `installed` seeds
 * host/node_modules so the install step can be observed being skipped. */
async function fakeDemosRepo(options: { slugs: string[]; installed?: boolean }): Promise<string> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-assemble-"));
  await mkdir(path.dirname(manifestPath(demosRepo)), { recursive: true });
  await writeFile(
    manifestPath(demosRepo),
    options.slugs.map((slug) => `import s from "../../../demos/${slug}/screens/index.js";`).join("\n"),
  );
  if (options.installed === true) await mkdir(path.join(demosRepo, "host", "node_modules"), { recursive: true });
  return demosRepo;
}

function fakeExec(byCommand: Record<string, Partial<ExecResult>> = {}): { exec: ExecFn; ran: string[] } {
  const ran: string[] = [];
  const exec: ExecFn = async (command) => {
    const key = command.join(" ");
    ran.push(key);
    const result = byCommand[key] ?? {};
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { exec, ran };
}

function fakeHost(): { host: RunningHost; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => undefined);
  return { host: { baseUrl: "http://127.0.0.1:4311", stop }, stop };
}

/** Everything a stage-4 run needs, with the process-touching seams faked. */
function io(demosRepo: string, overrides: Partial<AssembleIo> = {}): AssembleIo {
  return {
    demosRepo,
    write: () => undefined,
    exec: fakeExec().exec,
    boot: async () => fakeHost().host,
    smokeTurn: async () => undefined,
    ...overrides,
  };
}

const args = { slug: "acme", port: 4311, smokePrompt: "Show me overdue invoices" };

describe("runAssemble", () => {
  it("skips install when the host already has node_modules", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec, ran } = fakeExec();
    await runAssemble(args, io(demosRepo, { exec }));
    expect(ran).toEqual(["node scripts/gen-manifest.mjs", "pnpm build"]);
  });

  it("installs the host once when node_modules is absent", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"] });
    const { exec, ran } = fakeExec();
    await runAssemble(args, io(demosRepo, { exec }));
    expect(ran[0]).toBe("pnpm install");
  });

  it("propagates a gen-manifest failure without building or booting", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec, ran } = fakeExec({ "node scripts/gen-manifest.mjs": { code: 1, stderr: "cannot read demos/" } });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { exec, boot }))).rejects.toThrow(/gen-manifest failed/);
    expect(ran).toEqual(["node scripts/gen-manifest.mjs"]);
    expect(boot).not.toHaveBeenCalled();
  });

  // Silently shipping a demo the host never compiled in is the failure this
  // check exists for: the page would 404 in front of the prospect.
  it("throws naming the slug when the manifest did not discover it", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["globex"], installed: true });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { boot }))).rejects.toThrow(/acme/);
    expect(boot).not.toHaveBeenCalled();
  });

  it("never boots a demo whose build failed, and reports the build tail", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec } = fakeExec({ "pnpm build": { code: 1, stdout: "Type error: Property 'total' does not exist" } });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { exec, boot })))
      .rejects.toThrow(/host build failed[\s\S]*Property 'total' does not exist/);
    expect(boot).not.toHaveBeenCalled();
  });

  it("stops the host and rethrows when the smoke turn errors", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    const smokeTurn: SmokeTurnFn = async () => {
      throw new Error("Vendo capture surfaced an error: model overloaded");
    };
    await expect(runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn })))
      .rejects.toThrow(/model overloaded/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // The frozen contract: "ONE smoke agent turn, result discarded, gates on hard
  // error only (turn errored / no settle), NOT on content." Nothing pinned the
  // content half — a gate that started refusing turns for generating no view, or
  // prose, or a refusal card, would pass every existing test.
  it("passes a turn that settled without generating anything", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    // A turn that answered in prose: no view, no approval, nothing to inspect.
    const result = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: async () => undefined }));
    expect(result.host).toBe(host);
    expect(stop).not.toHaveBeenCalled();
    await result.host.stop();
  });

  it("cannot gate on content, because content never reaches it", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host } = fakeHost();
    // Whatever the smoke turn "returns" is discarded by the SmokeTurnFn contract
    // (Promise<void>), so no assemble code path can branch on it.
    const smokeTurn = (async () => "a view was generated" as unknown as void) as SmokeTurnFn;
    const result = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn }));
    expect(result.smoke).toEqual({ prompt: args.smokePrompt, ms: expect.any(Number) });
    expect(Object.keys(result)).toEqual(["slugs", "host", "smoke"]);
    await result.host.stop();
  });

  it("returns the still-running host and the smoke prompt it drove", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme", "globex"], installed: true });
    const { host, stop } = fakeHost();
    const smoked: { baseUrl: string; slug: string; prompt: string }[] = [];
    const result = await runAssemble(args, io(demosRepo, {
      boot: async () => host,
      smokeTurn: async (options) => {
        smoked.push({ baseUrl: options.baseUrl, slug: options.slug, prompt: options.prompt });
      },
    }));
    expect(result.slugs).toEqual(["acme", "globex"]);
    expect(result.host).toBe(host);
    expect(result.smoke.prompt).toBe(args.smokePrompt);
    expect(result.smoke.ms).toBeGreaterThanOrEqual(0);
    expect(smoked).toEqual([{ baseUrl: host.baseUrl, slug: "acme", prompt: args.smokePrompt }]);
    // The judge screenshots this same boot, so the caller owns the teardown.
    expect(stop).not.toHaveBeenCalled();
    await result.host.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("boots the host on the requested port", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const booted: { demosRepo: string; port: number; logFile: string }[] = [];
    const boot: NonNullable<AssembleIo["boot"]> = async (options) => {
      booted.push(options);
      return fakeHost().host;
    };
    await runAssemble(args, io(demosRepo, { boot }));
    expect(booted[0]).toMatchObject({ demosRepo, port: 4311 });
    expect(booted[0]?.logFile).toMatch(/\.log$/);
  });
});
