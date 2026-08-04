import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillFolders } from "./skills.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const skillFolder = async (
  name: string,
  skillMd: string,
  files: Record<string, string> = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agents-skills-"));
  roots.push(root);
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
};

const MD = `---\nname: "renamed-in-frontmatter"\ndescription: "How the product docs answer billing questions."\n---\n\nSearch the docs first.\n`;

describe("loadSkillFolders", () => {
  it("loads a folder: the DIRECTORY name is the skill name, frontmatter only describes", async () => {
    const dir = await skillFolder("product-docs", MD, { "refunds.md": "Refunds take 5 days." });
    const [skill] = loadSkillFolders([dir]);
    expect(skill?.name).toBe("product-docs");
    expect(skill?.description).toBe("How the product docs answer billing questions.");
    expect(skill?.body).toBe("Search the docs first.");
    expect(skill?.files).toEqual({ "refunds.md": "Refunds take 5 days." });
  });

  it("companions keep their nested relative paths", async () => {
    const dir = await skillFolder("product-docs", MD, { "guides/tax.md": "VAT applies." });
    const [skill] = loadSkillFolders([dir]);
    expect(skill?.files).toEqual({ "guides/tax.md": "VAT applies." });
  });

  it("no folders is no skills", () => {
    expect(loadSkillFolders(undefined)).toEqual([]);
    expect(loadSkillFolders([])).toEqual([]);
  });

  it("a missing SKILL.md is a boot error", async () => {
    const dir = await skillFolder("product-docs", MD);
    await rm(join(dir, "SKILL.md"));
    expect(() => loadSkillFolders([dir])).toThrow(/no readable SKILL.md/);
  });

  it("a missing description is a boot error — listings are how a harness chooses", async () => {
    const dir = await skillFolder("product-docs", "---\nname: x\n---\nbody");
    expect(() => loadSkillFolders([dir])).toThrow(/description/);
  });

  it("an unsafe directory name is a boot error", async () => {
    const dir = await skillFolder("product docs!", MD);
    expect(() => loadSkillFolders([dir])).toThrow(/does not match/);
  });

  it("two folders claiming one name collide at boot", async () => {
    const a = await skillFolder("product-docs", MD);
    const b = await skillFolder("product-docs", MD);
    expect(() => loadSkillFolders([a, b])).toThrow(/claim the name "product-docs"/);
  });
});
