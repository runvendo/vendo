import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfig } from "../../src/cli/config.js";
import type { Output } from "../../src/cli/shared.js";

// `vendo config status` is LOCAL-ONLY: config resolves in code (a value passed
// to createVendo → `.vendo/<surface>` → unset), so the command reads disk and
// nothing else — no credential, no network call, nothing to say about a
// console.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-config-"));
  dirs.push(dir);
  await mkdir(join(dir, ".vendo"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, ".vendo", name), body, "utf8");
  }
  return dir;
}

function capture(): { output: Output; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m) => lines.push(m), error: (m) => errors.push(m) }, lines, errors };
}

describe("vendo config status", () => {
  it("reports each surface as file / unset and notes a code value is not CLI-visible", async () => {
    const dir = await tempProject({ "brief.md": "on-disk brief" });
    const cap = capture();
    const code = await runConfig(["status"], { targetDir: dir, output: cap.output });
    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    expect(joined).toMatch(/brief\.md\s+file/);
    expect(joined).toMatch(/design-rules\.md\s+unset/);
    expect(joined).toMatch(/theme\.json\s+unset/);
    expect(joined).toMatch(/policy\.json\s+unset/);
    expect(joined).toMatch(/overrides\.json\s+unset/);
    expect(joined).toContain("createVendo");
  });

  it("says nothing about a console, and never reports an owner it cannot see", async () => {
    const dir = await tempProject({ "brief.md": "b" });
    const cap = capture();
    await runConfig(["status"], { targetDir: dir, output: cap.output });
    const joined = cap.lines.join("\n").toLowerCase();
    expect(joined).not.toContain("cloud");
    expect(joined).not.toContain("console");
    expect(joined).not.toContain("unknown");
    expect(joined).not.toContain("publish");
  });

  it("works with no key at all — it makes no service call to need one for", async () => {
    const dir = await tempProject({ "brief.md": "b" });
    const cap = capture();
    const code = await runConfig(["status"], { targetDir: dir, output: cap.output });
    expect(code).toBe(0);
    expect(cap.errors).toEqual([]);
  });

  it("prints the overrides enablement note", async () => {
    const dir = await tempProject();
    const cap = capture();
    await runConfig(["status"], { targetDir: dir, output: cap.output });
    const joined = cap.lines.join("\n");
    expect(joined.toLowerCase()).toContain("enablement");
    expect(joined).toContain("boot-once");
  });

  it("takes its dir from the positional when no targetDir is injected", async () => {
    const dir = await tempProject({ "theme.json": "{}" });
    const cap = capture();
    const code = await runConfig(["status", dir], { output: cap.output });
    expect(code).toBe(0);
    expect(cap.lines.join("\n")).toMatch(/theme\.json\s+file/);
  });
});

describe("vendo config help", () => {
  it("offers status only — push and pull are gone with the console layer", async () => {
    const cap = capture();
    const code = await runConfig(["--help"], { output: cap.output });
    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    expect(joined).toContain("vendo config status");
    expect(joined).not.toContain("config push");
    expect(joined).not.toContain("config pull");
  });

  it("names the unknown command and shows the help", async () => {
    const cap = capture();
    const code = await runConfig(["push", "brief.md"], { output: cap.output });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toContain("Unknown config command: push");
    expect(cap.errors.join("\n")).toContain("vendo config status");
  });
});
