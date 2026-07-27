import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "./shared.js";
import { telemetryCapture } from "./telemetry.test-util.js";
import { runTry, type TryOptions } from "./try.js";
import type { DeepeningSummary, RunDeepeningOptions } from "./try/deepen.js";
import type { TryProfile } from "./try/profile.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

/** The extract.test.ts fixture: a minimal Next-ish host with one themed
 *  stylesheet and one app-router API route. */
async function nextFixture(): Promise<string> {
  const root = await tempDir("vendo-try-cmd-fixture-");
  await write(root, "package.json", `${JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.4.0" },
  }, null, 2)}\n`);
  await write(root, "app/layout.tsx", [
    'import "./globals.css";',
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    "",
  ].join("\n"));
  await write(root, "app/globals.css", [
    ":root {",
    "  --background: #fffdf8;",
    "  --foreground: #1c1917;",
    "  --primary: #7c3aed;",
    "  --radius: 10px;",
    "}",
    "",
  ].join("\n"));
  await write(root, "app/api/invoices/route.ts",
    "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** Full recursive inventory of a tree (extract.test.ts's zero-commit unit). */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) } };
}

/** A recording deepen stub — no engine ladder, no model, resolves skipped. */
function deepenStub(): { calls: RunDeepeningOptions[]; deepen: NonNullable<TryOptions["deepen"]> } {
  const calls: RunDeepeningOptions[] = [];
  return {
    calls,
    deepen: async (options): Promise<DeepeningSummary> => {
      calls.push(options);
      return { extraction: "skipped", seeds: "skipped" };
    },
  };
}

describe("runTry", () => {
  it("serves the extracted profile, opens the browser, sweeps the temp profile root, leaves the repo untouched", async () => {
    const repoRoot = await nextFixture();
    const before = await inventory(repoRoot);
    const { logs, sink } = output();
    const opened: string[] = [];
    const { calls, deepen } = deepenStub();
    let seenProfileRoot = "";
    let profile: TryProfile | undefined;

    const code = await runTry({
      repoRoot,
      output: sink,
      env: {},
      openBrowser: (url) => opened.push(url),
      deepen,
      wait: async ({ url, profileRoot }) => {
        seenProfileRoot = profileRoot;
        const response = await fetch(`${url}/profile.json`);
        expect(response.status).toBe(200);
        profile = (await response.json()) as TryProfile;
      },
    });

    expect(code).toBe(0);

    // The profile the server painted carries the fixture's extraction.
    expect(profile?.tools.list.map((tool) => tool.name)).toContain("host_invoices_list");
    // brand.name derives from the host package.json, the deepen.ts way.
    expect(profile?.brand.name).toBe("host");

    // The URL is printed and the browser opened on it.
    const printed = logs.join("\n");
    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(opened).toHaveLength(1);
    expect(printed).toContain(opened[0]);

    // Deepening ran once, against the served profile root.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.repoRoot).toBe(repoRoot);
    expect(calls[0]?.profileRoot).toBe(seenProfileRoot);

    // The temp profile root is swept on shutdown (it's caller-owned).
    expect(seenProfileRoot).not.toBe("");
    expect(await exists(seenProfileRoot)).toBe(false);

    // Zero-commit: the host repo is byte-for-byte untouched.
    expect(await inventory(repoRoot)).toEqual(before);

    // The exit hint points at the keep-it path.
    expect(printed).toContain("vendo init");
  });

  it("never gates serving on deepening (latency law): the surface paints while deepening is still pending", async () => {
    const repoRoot = await nextFixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let servedWhilePending = false;

    const code = await runTry({
      repoRoot,
      output: output().sink,
      env: {},
      open: false,
      deepen: async () => {
        await gate;
        return { extraction: "skipped", seeds: "skipped" };
      },
      wait: async ({ url }) => {
        // Deepening cannot settle yet (the gate is closed), and the server
        // already answers — the first paint never waited on it.
        servedWhilePending = (await fetch(`${url}/profile.json`)).status === 200;
        release();
      },
    });

    expect(code).toBe(0);
    expect(servedWhilePending).toBe(true);
  });

  it("sweeps AFTER deepening settles: a mid-flight deepen cannot write the swept profile root back", async () => {
    const repoRoot = await nextFixture();
    const { logs, sink } = output();
    let seenProfileRoot = "";
    let deepenSettled: Promise<unknown> = Promise.resolve();

    // A deepen still writing at shutdown: wait: false shuts down immediately,
    // while this write lands only after a delay.
    const deepen = (deepenOptions: RunDeepeningOptions): Promise<DeepeningSummary> => {
      seenProfileRoot = deepenOptions.profileRoot;
      const work = (async (): Promise<DeepeningSummary> => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        await mkdir(join(deepenOptions.profileRoot, ".vendo"), { recursive: true });
        await writeFile(join(deepenOptions.profileRoot, ".vendo", "late-artifact.json"), "{}\n", "utf8");
        return { extraction: "ran", seeds: "written" };
      })();
      deepenSettled = work.catch(() => undefined);
      return work;
    };

    const code = await runTry({ repoRoot, output: sink, env: {}, open: false, wait: false, deepen });
    // Under shutdown-then-sweep ordering this is already settled; under the
    // broken ordering (sweep first) this is where the late write lands.
    await deepenSettled;

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Finishing background extraction");
    expect(seenProfileRoot).not.toBe("");
    expect(await exists(seenProfileRoot)).toBe(false);
  });

  it("--no-ai skips deepening entirely", async () => {
    const repoRoot = await nextFixture();
    const { calls, deepen } = deepenStub();
    const code = await runTry({
      repoRoot, output: output().sink, env: {}, open: false, wait: false, ai: false, deepen,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("--no-open skips the browser", async () => {
    const repoRoot = await nextFixture();
    const opened: string[] = [];
    const { deepen } = deepenStub();
    const code = await runTry({
      repoRoot, output: output().sink, env: {}, open: false, wait: false, deepen,
      openBrowser: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual([]);
  });

  it("passes an --engine pin through to deepening", async () => {
    const repoRoot = await nextFixture();
    const { calls, deepen } = deepenStub();
    const code = await runTry({
      repoRoot, output: output().sink, env: {}, open: false, wait: false, engine: "codex", deepen,
    });
    expect(code).toBe(0);
    expect(calls[0]?.engine).toBe("codex");
  });

  it("an empty repo still serves: honest line, paintable profile, exit 0", async () => {
    const repoRoot = await tempDir("vendo-try-cmd-empty-");
    const { logs, sink } = output();
    const { deepen } = deepenStub();
    let status = 0;

    const code = await runTry({
      repoRoot, output: sink, env: {}, open: false, deepen,
      wait: async ({ url }) => {
        status = (await fetch(`${url}/profile.json`)).status;
      },
    });

    expect(code).toBe(0);
    expect(status).toBe(200);
    expect(logs.join("\n")).toContain("generic data");
  });

  it("fails loudly when the requested port is already taken — and still sweeps the temp profile root", async () => {
    const squatter = createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const { port } = squatter.address() as AddressInfo;
    const repoRoot = await nextFixture();
    // Pin the OS temp home (forks pool: our process alone) so the failure
    // path's sweep is observable — the profileRoot seams never fire here.
    const tmpHome = await tempDir("vendo-try-cmd-tmp-home-");
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpHome;
    try {
      const { errors, sink } = output();
      const { deepen } = deepenStub();
      const code = await runTry({
        repoRoot, output: sink, env: {}, open: false, wait: false, port, deepen,
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(String(port));
      expect(errors.join("\n")).toContain("--port");
      // The temp profile root created before the listen failure is gone.
      expect(await readdir(tmpHome)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe("try telemetry", () => {
  it("tracks command_run try ok once the server has served and closed", async () => {
    const tele = await telemetryCapture();
    cleanup.push(tele.home);
    const { deepen } = deepenStub();
    expect(await runTry({
      repoRoot: await nextFixture(),
      output: output().sink,
      env: {},
      open: false,
      wait: false,
      deepen,
      telemetry: tele.telemetry,
    })).toBe(0);
    expect(tele.event("command_run").properties).toMatchObject({ command: "try", ok: true });
  });
});
