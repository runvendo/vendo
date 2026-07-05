import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPublish } from "./publish.js";

describe("runPublish (stub)", () => {
  it("validates the manifest, prints its hash, and explains the stub", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    await mkdir(path.join(dir, ".vendo"));
    await writeFile(path.join(dir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runPublish({ targetDir: dir })).toBe(0);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out).toMatch(/ENG-198|registry/i);
    log.mockRestore();
  });

  it("fails when .vendo/tools.json is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runPublish({ targetDir: dir })).toBe(1);
    err.mockRestore();
  });
});
