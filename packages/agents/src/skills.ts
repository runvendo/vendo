/**
 * `agent({ skills: ["./skills/product-docs"] })` — folders on the host's own
 * disk, loaded ONCE at boot (deploy = update the folder). Each folder is one
 * skill: the directory name IS the skill name (core skills law — frontmatter
 * never renames), `SKILL.md` carries description + body, and every other text
 * file rides along as a companion.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { SAFE_SKILL_NAME, VendoError, type PackSkill } from "@vendoai/core";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const frontmatterField = (block: string, field: string): string | undefined => {
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${field}:\\s*(.*)$`));
    if (match?.[1] !== undefined) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
};

const readSkillFolder = (folder: string): PackSkill => {
  const dir = resolve(folder);
  const name = basename(dir);
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new VendoError(
      "validation",
      `skill folder "${folder}": the directory name is the skill name and "${name}" does not match ${String(SAFE_SKILL_NAME)}`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch (cause) {
    throw new VendoError("validation", `skill folder "${folder}" has no readable SKILL.md`, { cause });
  }
  const matter = raw.match(FRONTMATTER);
  const description = matter?.[1] === undefined ? undefined : frontmatterField(matter[1], "description");
  if (description === undefined || description === "") {
    throw new VendoError(
      "validation",
      `skill "${name}": SKILL.md needs a frontmatter description (---\\ndescription: …\\n---)`,
    );
  }
  const body = raw.slice(matter?.[0]?.length ?? 0).trim();

  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(dir, path).split(sep).join("/");
      if (rel === "SKILL.md") continue;
      files[rel] = readFileSync(path, "utf8");
    }
  };
  walk(dir);

  return { name, description, body, ...(Object.keys(files).length === 0 ? {} : { files }) };
};

export function loadSkillFolders(folders: readonly string[] | undefined): PackSkill[] {
  if (folders === undefined || folders.length === 0) return [];
  const skills = folders.map(readSkillFolder);
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new VendoError("conflict", `two skill folders claim the name "${skill.name}" — rename one directory.`);
    }
    names.add(skill.name);
  }
  return skills;
}
