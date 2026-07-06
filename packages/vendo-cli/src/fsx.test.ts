import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { walk, writeGenerated } from "./fsx.js";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "vendo-cli-"));
}

describe("walk", () => {
  it("finds matching files and skips node_modules/.vendo", async () => {
    const dir = await scratch();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/x"), { recursive: true });
    await mkdir(path.join(dir, ".vendo"), { recursive: true });
    await writeFile(path.join(dir, "src/a.css"), "");
    await writeFile(path.join(dir, "node_modules/x/b.css"), "");
    await writeFile(path.join(dir, ".vendo/c.css"), "");
    const hits = await walk(dir, (p) => p.endsWith(".css"));
    expect(hits).toEqual([path.join(dir, "src/a.css")]);
  });
});

describe("writeGenerated", () => {
  it("refuses to overwrite without force", async () => {
    const dir = await scratch();
    await writeGenerated(path.join(dir, "out.json"), "1", { force: false });
    await expect(writeGenerated(path.join(dir, "out.json"), "2", { force: false })).rejects.toThrow(/--force/);
  });

  it("overwrites with force and creates parent dirs", async () => {
    const dir = await scratch();
    await writeGenerated(path.join(dir, "a/b/out.json"), "1", { force: false });
    await writeGenerated(path.join(dir, "a/b/out.json"), "2", { force: true });
  });

  it('leaves existing files untouched when ifExists is "skip" and reports whether it wrote', async () => {
    const dir = await scratch();
    const file = path.join(dir, "out.json");
    expect(await writeGenerated(file, "1", { force: false, ifExists: "skip" })).toBe(true);
    expect(await writeGenerated(file, "2", { force: false, ifExists: "skip" })).toBe(false);
    expect(await readFile(file, "utf8")).toBe("1");
  });

  it('force overrides ifExists: "skip"', async () => {
    const dir = await scratch();
    const file = path.join(dir, "out.json");
    await writeGenerated(file, "1", { force: false });
    expect(await writeGenerated(file, "2", { force: true, ifExists: "skip" })).toBe(true);
    expect(await readFile(file, "utf8")).toBe("2");
  });
});
