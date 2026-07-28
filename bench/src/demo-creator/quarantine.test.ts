import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { demoPaths } from "./demo-folder.js";
import { defaultExec } from "./exec.js";
import { runDemoFix } from "./fix.js";
import { quarantineFailedDemo, runDemoPipeline, type PipelineStages } from "./pipeline.js";

/**
 * The defect: `gen-manifest` validates EVERY demo folder and writes nothing
 * unless all of them pass, so one non-conformant leftover from a dead run breaks
 * every SUBSEQUENT run in that checkout. The mini's `~/.vendo/vendo-demos` lives
 * forever, so one bad run bricked it until a human moved the folder aside by
 * hand — which is exactly what happened to `built-contoso-bills-smoke-timeout`.
 *
 * Real git, because what is being proven is which files survive a checkout and a
 * clean, and only git can answer that.
 */
async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "lane-quarantine-"));
  await mkdir(path.join(repo, "host", "src"), { recursive: true });
  await writeFile(path.join(repo, "host", "src", "app.ts"), "export const host = 1;\n");
  await defaultExec(["git", "init", "-q", "."], { cwd: repo });
  await defaultExec(["git", "add", "-A"], { cwd: repo });
  await defaultExec(["git", "-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-qm", "base"], { cwd: repo });
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await defaultExec(["git", "add", "-A"], { cwd: repo });
  await defaultExec(["git", "-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-qm", message], { cwd: repo });
}

/** A half-generated demo folder: the shape a dead run leaves behind. */
async function halfBuiltDemo(repo: string, slug: string): Promise<void> {
  await mkdir(path.join(repo, "demos", slug, "screens"), { recursive: true });
  await writeFile(path.join(repo, "demos", slug, "screens", "index.tsx"), "export default () => null;\n");
  // No tools.json, no theme.json — this is what gen-manifest refuses.
  await writeFile(path.join(repo, "demos", slug, "BRIEF.md"), "# half a brief\n");
}

const io = (write: (line: string) => void = () => undefined) => ({ exec: defaultExec, write });

describe("quarantineFailedDemo", () => {
  it("leaves the checkout with no trace of a failed run's new demo folder", async () => {
    const repo = await gitRepo();
    await halfBuiltDemo(repo, "contoso-bills");
    await quarantineFailedDemo({ demosRepo: repo, slug: "contoso-bills", ...io() });
    // The whole point: the next run's gen-manifest must not see this folder.
    expect(existsSync(path.join(repo, "demos", "contoso-bills"))).toBe(false);
  });

  it("keeps the failed artifacts outside the repo, so a failure is still diagnosable", async () => {
    const repo = await gitRepo();
    await halfBuiltDemo(repo, "contoso-bills");
    const result = await quarantineFailedDemo({ demosRepo: repo, slug: "contoso-bills", ...io() });
    expect(result.quarantined).toBeDefined();
    expect(await readFile(path.join(result.quarantined!, "BRIEF.md"), "utf8")).toBe("# half a brief\n");
    // OUTSIDE the checkout: `railway up` uploads the working directory, so a
    // quarantine kept inside it would deploy every dead run's leftovers.
    expect(path.relative(repo, result.quarantined!).startsWith("..")).toBe(true);
  });

  // demo:fix runs against a demo that is already LIVE and committed. Deleting
  // that folder because the fix failed would erase a shipped demo's source.
  it("restores a committed demo instead of deleting it when a fix run fails", async () => {
    const repo = await gitRepo();
    await mkdir(path.join(repo, "demos", "globex"), { recursive: true });
    await writeFile(path.join(repo, "demos", "globex", "theme.json"), '{"good":true}\n');
    await commitAll(repo, "demo(globex): live");
    // A failed fix run: the committed file mangled, plus a new stray.
    await writeFile(path.join(repo, "demos", "globex", "theme.json"), "{ broken\n");
    await writeFile(path.join(repo, "demos", "globex", "stray.tsx"), "export default 1;\n");

    await quarantineFailedDemo({ demosRepo: repo, slug: "globex", ...io() });

    expect(await readFile(path.join(repo, "demos", "globex", "theme.json"), "utf8")).toBe('{"good":true}\n');
    expect(existsSync(path.join(repo, "demos", "globex", "stray.tsx"))).toBe(false);
  });

  it("touches nothing outside the demo folder it is cleaning", async () => {
    const repo = await gitRepo();
    await halfBuiltDemo(repo, "contoso-bills");
    await mkdir(path.join(repo, "demos", "globex"), { recursive: true });
    await writeFile(path.join(repo, "demos", "globex", "theme.json"), '{"live":true}\n');
    await commitAll(repo, "demo(globex): live");
    // Host artifacts a run legitimately leaves behind (the generated manifest).
    await writeFile(path.join(repo, "host", "src", "generated.ts"), "export const slugs = [];\n");

    await quarantineFailedDemo({ demosRepo: repo, slug: "contoso-bills", ...io() });

    expect(existsSync(path.join(repo, "demos", "globex", "theme.json"))).toBe(true);
    expect(existsSync(path.join(repo, "host", "src", "generated.ts"))).toBe(true);
    expect(await readFile(path.join(repo, "host", "src", "app.ts"), "utf8")).toBe("export const host = 1;\n");
  });

  it("is a no-op when the run died before the demo folder existed", async () => {
    const repo = await gitRepo();
    const result = await quarantineFailedDemo({ demosRepo: repo, slug: "never-started", ...io() });
    expect(result.quarantined).toBeUndefined();
  });

  // This runs on the failure path, where an original error is already on its way
  // to the operator. A throw here would replace the real cause with a cleanup
  // detail — the worst possible trade.
  it("never throws when cleanup itself fails, and says so instead", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "lane-quarantine-bare-"));
    await halfBuiltDemo(notARepo, "acme");
    const lines: string[] = [];
    await expect(quarantineFailedDemo({ demosRepo: notARepo, slug: "acme", ...io((line) => lines.push(line)) }))
      .resolves.toBeDefined();
    expect(lines.some((line) => line.includes("WARNING"))).toBe(true);
  });

  it("refuses a slug that is not a slug, before it builds a path from it", async () => {
    const repo = await gitRepo();
    await expect(quarantineFailedDemo({ demosRepo: repo, slug: "../../host", ...io() })).rejects.toThrow(/slug/);
  });
});

/**
 * The wiring. Cleaning up is only worth anything if a real failed run does it
 * — the whole defect is that a dead run walked away and left the checkout
 * broken for the next one.
 */
describe("a failed run cleans up after itself", () => {
  /** Stage fakes for a run that gets as far as assemble and then dies there —
   *  the exact shape of the smoke-timeout and contrast-gate runs. */
  function stagesFailingAtAssemble(repo: string, slug: string): PipelineStages {
    return {
      ensureRepo: async (dir) => ({ dir, cloned: false, head: "head" }),
      evidence: async () => {
        await halfBuiltDemo(repo, slug);
        return {} as never;
      },
      brief: async () => ({ theme: {}, brief: { company: "Acme" }, themePath: "t", briefPath: "b" }) as never,
      build: async () => ({ agents: [], toolCount: 4, costUsd: 1, beats: [{ key: "generate-ui", prompt: "Show me a dashboard" }] }) as never,
      assemble: async () => {
        throw new Error("the smoke turn TIMED OUT after 420000ms — …");
      },
      judge: async () => ({}) as never,
      ship: async () => ({}) as never,
    };
  }

  it("leaves demos/<slug>/ out of the checkout when a stage fails", async () => {
    const repo = await gitRepo();
    const lines: string[] = [];
    await expect(runDemoPipeline(
      {
        id: "contoso-bills",
        prospect: "Contoso",
        screenshots: ["/abs/a.png"],
        ctaUrl: "https://cal.com/x",
        expiresAt: "2026-08-31T00:00:00.000Z",
        demosRepo: repo,
        skipShip: false,
      },
      { stages: stagesFailingAtAssemble(repo, "contoso-bills"), write: (line) => lines.push(line), exec: defaultExec },
    )).rejects.toThrow(/TIMED OUT/);

    // Without this the NEXT run's gen-manifest refuses the whole checkout.
    expect(existsSync(path.join(repo, "demos", "contoso-bills"))).toBe(false);
    expect(lines.some((line) => line.includes("moved out of the checkout"))).toBe(true);
  });

  it("keeps the demo folder on a SUCCESSFUL run", async () => {
    const repo = await gitRepo();
    const stages = stagesFailingAtAssemble(repo, "contoso-bills");
    const host = { baseUrl: "http://127.0.0.1:3150", stop: async () => undefined };
    await runDemoPipeline(
      {
        id: "contoso-bills",
        prospect: "Contoso",
        screenshots: ["/abs/a.png"],
        ctaUrl: "https://cal.com/x",
        expiresAt: "2026-08-31T00:00:00.000Z",
        demosRepo: repo,
        skipShip: true,
      },
      {
        stages: {
          ...stages,
          assemble: async () => ({ slugs: ["contoso-bills"], host, smoke: { prompt: "p", ms: 1 } }) as never,
          judge: async () => ({ scoresLine: "logo=PASS palette=8 type=8 layout=8 copyTone=8" }) as never,
        },
        write: () => undefined,
        exec: defaultExec,
      },
    );
    expect(existsSync(path.join(repo, "demos", "contoso-bills"))).toBe(true);
  });

  // demo:fix poisons the checkout the same way, and its demo is COMMITTED — so
  // the requirement here is the opposite one: restore it, never delete it.
  it("restores a live demo's committed folder when a fix run fails", async () => {
    const repo = await gitRepo();
    const paths = demoPaths(repo, "globex");
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.brief, "# BRIEF — Globex\n");
    await writeFile(paths.config, JSON.stringify({
      id: "globex",
      prospect: "Globex",
      ctaUrl: "https://cal.com/x",
      caps: { maxTurns: 20, maxSpendUsd: 5 },
      expiresAt: "2026-08-31T00:00:00.000Z",
      placement: { trigger: "header", slot: "top-right of the header bar" },
      beats: [
        { key: "generate-ui", chip: "Spend", prompt: "Build me a spend view", expectsView: true },
        { key: "take-action", chip: "Pay", prompt: "Pay the oldest bill", expectsApproval: true },
        { key: "automation", chip: "Watch", prompt: "Alert me on new bills" },
        { key: "connect-account", chip: "Connect", prompt: "Connect my inbox" },
        { key: "save-app", chip: "Save", prompt: "Save this as an app" },
      ],
    }));
    await commitAll(repo, "demo(globex): live");

    await expect(runDemoFix(
      { id: "globex", instruction: "make the sidebar dark", demosRepo: repo, skipShip: false },
      {
        write: () => undefined,
        env: {},
        exec: defaultExec,
        runAgent: async (job) => {
          // The failed fix agent's damage: a stray file left in the folder.
          await writeFile(path.join(paths.root, "stray.tsx"), "export default 1;\n");
          return { name: job.name, code: 1, output: "the fix agent gave up", timedOut: false, permissionDenials: [] };
        },
      },
    )).rejects.toThrow(/Fix agent failed/);

    // The live demo's own source is intact…
    expect(existsSync(paths.config)).toBe(true);
    expect(await readFile(paths.brief, "utf8")).toBe("# BRIEF — Globex\n");
    // …and the failed run's leftover is gone, so gen-manifest still passes.
    expect(existsSync(path.join(paths.root, "stray.tsx"))).toBe(false);
  });
});
