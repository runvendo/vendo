import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPublish } from "./publish.js";
import { createUi } from "./ui.js";

function capUi() {
  const lines: string[] = [];
  const ui = createUi({ sink: (c) => lines.push(c), tty: false, colors: false });
  return { lines, ui };
}

describe("runPublish (stub)", () => {
  it("validates the manifest, prints its hash, and explains the stub", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    await mkdir(path.join(dir, ".vendo"));
    await writeFile(path.join(dir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    const { lines, ui } = capUi();
    expect(await runPublish({ targetDir: dir, ui })).toBe(0);
    const out = lines.join("");
    expect(out).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out).toMatch(/ENG-198|registry/i);
    expect(out).toMatch(/stub/i);
  });

  it("fails when .vendo/tools.json is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    const { lines, ui } = capUi();
    expect(await runPublish({ targetDir: dir, ui })).toBe(1);
    expect(lines.join("")).toMatch(/cannot publish/i);
  });
});
