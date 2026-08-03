/**
 * The skills store: pack and host skills as files on the workspace's read-only
 * `/host/` mount, and the cheap two-call surface a harness reads them through.
 *
 * The on-disk format is agentskills.io's SKILL.md — the format Claude Code and
 * Pi already read natively — so projecting a skill for a harness is a COPY, not
 * a translation. A translation would rewrite tool names, and tool names are
 * global as authored (build contract §5): a rewritten body would point the
 * model at a tool that does not exist.
 *
 * `/host/**` is a PER-TURN PROJECTION, not stored rows: a pack skill is a code
 * value that `definePack` declared, so the host's own deploy IS its update path
 * and there is nothing to migrate, invalidate, or erase. {@link hostSkillFiles}
 * turns the merged pack skills into the path→content map the workspace is opened
 * with; the mount is read-only through the façade, and this module never writes.
 *
 * Whatever ends up on the mount is the one source of truth for what exists,
 * which is why a host's own hand-authored SKILL.md lists beside a pack's without
 * registering anywhere.
 */
import type { PackSkill } from "./pack.js";

export type { PackSkill };

/** Build contract §3.1 — host + pack skills, read-only for everyone. */
export const HOST_SKILLS_MOUNT = "/host/skills";

/**
 * A skill name is a PATH SEGMENT, so it may only be one. No dots, slashes or
 * whitespace — nothing that could be spelled as a traversal. Same shape as the
 * frozen tool-name pattern, deliberately.
 */
export const SAFE_SKILL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The file one skill lives in. The directory name is the skill's name.
 *
 * Validated HERE, not only at the pack merge: this and {@link hostSkillFiles} are
 * public exports, and the runtime builds the `/host` projection through them — so
 * the guard belongs where the path is built, not only where packs are configured.
 */
export const skillPath = (name: string): string => {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a usable skill name: a skill name is a directory under ${HOST_SKILLS_MOUNT} and a model asks for it by name, so it may only use letters, digits, "_" and "-", up to 64 characters.`,
    );
  }
  return `${HOST_SKILLS_MOUNT}/${name}/SKILL.md`;
};

/**
 * The slice of the workspace filesystem the skills store touches — READS only,
 * because `/host/` is read-only and a write through the façade is an EROFS.
 *
 * The signatures are just-bash's `IFileSystem` (build contract §3.2) for exactly
 * these three methods, so the real `WorkspaceFs` — and just-bash's own
 * `InMemoryFs` — satisfy it structurally, with nothing to adapt.
 */
export interface SkillsFs {
  readFile(path: string): Promise<string>;
  getAllPaths(): string[];
}

/** Build contract §1.2 — what a harness sees. `list()` is always cheap enough
 *  to carry every turn; `load()` is the only thing that costs a body. */
export interface TurnSkills {
  list(): Promise<SkillListing[]>;
  load(name: string): Promise<string>;
}

export interface SkillListing {
  name: string;
  description: string;
}

/**
 * A double-quoted YAML scalar, so a description carrying colons, quotes,
 * backslashes — or a NEWLINE — survives the roundtrip `list()` reads it back
 * through.
 *
 * Newlines are escaped rather than rejected: the whole value of SKILL.md is that
 * Claude Code and Pi parse it natively, and a raw newline inside a quoted scalar
 * would end the frontmatter early and take the parse down with it.
 */
const ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const UNESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

const quoted = (value: string): string =>
  `"${value.replace(/[\\"\n\r\t]/g, (char) => ESCAPES[char] as string)}"`;

const unquoted = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  // One pass, so an escaped backslash is never re-read as an escape character:
  // `\\n` is a backslash then an "n", not a newline.
  return trimmed.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => UNESCAPES[char] ?? char);
};

/** One skill as its SKILL.md text: agentskills.io frontmatter, then the body
 *  exactly as authored. */
export const renderSkillMd = ({ name, description, body }: PackSkill): string =>
  `---\nname: ${quoted(name)}\ndescription: ${quoted(description)}\n---\n\n${body}`;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n?/;

/** The description a listing shows, read from the frontmatter. A SKILL.md
 *  without frontmatter is still a skill — it just describes itself in its body,
 *  which `list()` never pays for. */
const describe = (text: string): string => {
  const front = FRONTMATTER.exec(text);
  if (front === null) return "";
  for (const line of front[1]?.split("\n") ?? []) {
    const colon = line.indexOf(":");
    if (colon !== -1 && line.slice(0, colon).trim() === "description") {
      return unquoted(line.slice(colon + 1));
    }
  }
  return "";
};

/** The body a harness loads: everything after the frontmatter, verbatim. */
const bodyOf = (text: string): string => text.replace(FRONTMATTER, "");

/**
 * The merged pack skills as the `/host/skills` half of the workspace's host
 * projection: path → SKILL.md text, ready to hand to the workspace open call.
 *
 * It is a plain value because the projection is per turn. Nothing is persisted,
 * so a skill renamed or reworded between deploys cannot leave a stale copy
 * behind — the configured packs are simply what exists, every turn.
 */
export const hostSkillFiles = (skills: readonly PackSkill[]): Record<string, string> =>
  Object.fromEntries(skills.map((skill) => [skillPath(skill.name), renderSkillMd(skill)]));

/** Every skill directory on the mount, sorted, so a listing never depends on
 *  how the filesystem happens to enumerate. */
const mountedNames = (fs: SkillsFs): string[] => {
  const names = new Set<string>();
  for (const path of fs.getAllPaths()) {
    const match = new RegExp(`^${HOST_SKILLS_MOUNT}/([^/]+)/SKILL\\.md$`).exec(path);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
};

/**
 * The skills surface for one turn.
 *
 * The name is the directory's, never the frontmatter's: a hand-edited SKILL.md
 * whose `name:` disagreed with its folder would otherwise list a name `load()`
 * cannot resolve.
 */
export const createTurnSkills = (fs: SkillsFs): TurnSkills => ({
  async list(): Promise<SkillListing[]> {
    return Promise.all(mountedNames(fs).map(async (name) => ({
      name,
      description: describe(await fs.readFile(skillPath(name))),
    })));
  },
  /**
   * `name` arrives from a MODEL, and it becomes a path. The guard is the mount
   * itself rather than a pattern: only a name that really is one of the mounted
   * skill directories can be loaded, so `../../user/apps/…`, `/etc/passwd`, and
   * `./building-apps` all fail on the way in — whatever the filesystem
   * underneath would have done with the dots.
   */
  async load(name: string): Promise<string> {
    if (!mountedNames(fs).includes(name)) {
      throw new Error(`no skill named "${name}" is mounted at ${HOST_SKILLS_MOUNT}`);
    }
    return bodyOf(await fs.readFile(skillPath(name)));
  },
});
