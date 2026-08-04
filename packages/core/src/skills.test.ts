import { describe, expect, it } from "vitest";
import {
  HOST_SKILLS_MOUNT,
  createTurnSkills,
  hostSkillFiles,
  renderSkillMd,
  skillFilePath,
  skillPath,
  type PackSkill,
  type SkillsFs,
} from "./skills.js";

/**
 * An in-memory stand-in for the workspace filesystem, with the exact method
 * signatures just-bash 3.1.0 gives `IFileSystem` (`dist/fs/interface.d.ts`) for
 * the three methods the skills store touches — so anything that satisfies
 * {@link SkillsFs} here satisfies it for the real `WorkspaceFs` too.
 *
 * READ-ONLY, like the real `/host/` mount: the only way content gets in is the
 * host projection the workspace is opened with, which is what `initial` is.
 */
const memoryFs = (initial: Record<string, string> = {}): SkillsFs & { paths(): string[] } => {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>(["/"]);
  return {
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
    getAllPaths(): string[] {
      return [...dirs, ...files.keys()];
    },
    paths: () => [...files.keys()],
  };
};

/** Open a workspace whose `/host` projection carries these skills — the real
 *  path: `hostSkillFiles` in, façade reads out, nothing written. */
const mounted = (...skills: PackSkill[]): SkillsFs & { paths(): string[] } =>
  memoryFs(hostSkillFiles(skills));

const skill = (name: string, description: string, body: string): PackSkill => ({ name, description, body });

describe("skill paths (build contract §3.1)", () => {
  it("puts every skill at /host/skills/<name>/SKILL.md", () => {
    expect(HOST_SKILLS_MOUNT).toBe("/host/skills");
    expect(skillPath("building-apps")).toBe("/host/skills/building-apps/SKILL.md");
  });
});

describe("skillPath refuses to build an unsafe path (F3 at the source)", () => {
  // `skillPath` and `hostSkillFiles` are public @vendoai/core exports, and the
  // runtime wires that projection. The merge validates pack names, but these two
  // are reachable without it — so the guard lives here too, where the path is
  // actually built.
  const hostile = ["../../etc/passwd", "..", ".", "a/b", "with space", "", "dot.dot", "a\nb", "/abs"];

  for (const name of hostile) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      expect(() => skillPath(name)).toThrow(/skill name/i);
    });
  }

  it("refuses to project a skill whose name is unsafe", () => {
    expect(() => hostSkillFiles([skill("../../secrets", "D.", "b")])).toThrow(/skill name/i);
  });

  it("still builds the path for a legitimate name", () => {
    expect(skillPath("building-apps")).toBe("/host/skills/building-apps/SKILL.md");
  });
});

describe("SKILL.md on disk (agentskills.io format)", () => {
  it("renders name and description as frontmatter above the verbatim body", () => {
    const rendered = renderSkillMd(skill("building-apps", "Build an app for someone.", "# Building apps\n\nWrite the plan first.\n"));
    expect(rendered).toBe([
      "---",
      'name: "building-apps"',
      'description: "Build an app for someone."',
      "---",
      "",
      "# Building apps",
      "",
      "Write the plan first.",
      "",
    ].join("\n"));
  });

  it("keeps the body byte-identical — projection is a copy, never a translation", async () => {
    // Every character class that a translator would be tempted to touch:
    // frontmatter delimiters inside the body, quotes, backslashes, unicode.
    const body = '---\nnot: frontmatter\n---\n\n"quoted" \\ backslash — em dash 🎈\n\ttab\n';
    const fs = mounted(skill("edges", "Every awkward character.", body));

    const loaded = await createTurnSkills(fs).load("edges");
    expect(loaded).toBe(body);
  });

  it("roundtrips a description carrying colons and quotes", async () => {
    const description = 'Totals: cite the query, and never say "done".';
    const fs = mounted(skill("tricky", description, "body\n"));

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "tricky", description }]);
  });
});

describe("hostSkillFiles — the /host projection, not stored rows", () => {
  it("maps each skill to its SKILL.md path under the host mount", () => {
    const files = hostSkillFiles([skill("a", "First.", "a body\n"), skill("b", "Second.", "b body\n")]);

    expect(Object.keys(files).sort()).toEqual([
      "/host/skills/a/SKILL.md",
      "/host/skills/b/SKILL.md",
    ]);
  });

  it("is a pure value of the configured packs, so a reworded skill leaves nothing stale", async () => {
    // Two deploys, two projections. There is no store to carry the old one
    // forward — the second projection simply IS what exists.
    const before = createTurnSkills(memoryFs(hostSkillFiles([skill("a", "Old.", "old\n")])));
    const after = createTurnSkills(memoryFs(hostSkillFiles([skill("a", "New.", "new\n")])));

    expect(await before.load("a")).toBe("old\n");
    expect(await after.list()).toEqual([{ name: "a", description: "New." }]);
    expect(await after.load("a")).toBe("new\n");
  });

  it("projects nothing for no skills", () => {
    expect(hostSkillFiles([])).toEqual({});
  });
});

describe("companion files ride beside a skill's SKILL.md", () => {
  // The skill format is a DIRECTORY, and Claude Code reads it whole. Depth the
  // body should not carry (the full .vendo reference) lands here and the body
  // points at it.
  const withFiles: PackSkill = {
    ...skill("building-apps", "Build an app.", "body\n"),
    files: { "references/format.md": "# The format\n", "checklist.md": "- one\n" },
  };

  it("lands each file at its relative path under the skill's own directory", () => {
    expect(skillFilePath("building-apps", "references/format.md"))
      .toBe("/host/skills/building-apps/references/format.md");

    expect(hostSkillFiles([withFiles])).toEqual({
      "/host/skills/building-apps/SKILL.md": renderSkillMd(withFiles),
      "/host/skills/building-apps/references/format.md": "# The format\n",
      "/host/skills/building-apps/checklist.md": "- one\n",
    });
  });

  it("refuses a companion path that would leave the skill's directory", () => {
    const hostile = ["../format.md", "references/../../../user/apps/x", "/etc/passwd", "a//b", ".", "..", "with space.md", ""];
    for (const file of hostile) {
      expect(() => skillFilePath("building-apps", file)).toThrow(/companion-file path/i);
      expect(() => hostSkillFiles([{ ...withFiles, files: { [file]: "x" } }])).toThrow(/companion-file path/i);
    }
  });

  it("refuses a companion file that would overwrite the skill's own body", () => {
    expect(() => skillFilePath("building-apps", "SKILL.md")).toThrow(/companion-file path/i);
  });

  it("validates the skill name too, so the guard cannot be walked around", () => {
    expect(() => skillFilePath("../../secrets", "a.md")).toThrow(/skill name/i);
  });

  it("leaves the listing alone — a companion is a file, never a skill", async () => {
    const listed = await createTurnSkills(memoryFs(hostSkillFiles([withFiles]))).list();
    expect(listed).toEqual([{ name: "building-apps", description: "Build an app." }]);
  });
});

describe("load() is not an arbitrary-read primitive (F3)", () => {
  // `load(name)` takes a MODEL-SUPPLIED name and turns it into a path. The
  // guard is not a pattern here but the mount itself: only a name that really
  // is a mounted skill directory can be loaded, so no traversal, absolute path,
  // or dotted segment can name a file — whatever the filesystem does with dots.
  const escapes = [
    "../../user/apps/app_1/app.vendo",
    "..",
    "./building-apps",
    "/etc/passwd",
    "a/../../b",
    "building-apps/../../../secrets",
  ];

  for (const name of escapes) {
    it(`refuses to load ${JSON.stringify(name)}`, async () => {
      // A filesystem that happily normalizes dots and serves anything asked for
      // — the hostile case the guard has to hold against.
      const permissive: SkillsFs = {
        async readFile() { return "SECRET"; },
        getAllPaths() { return [skillPath("building-apps")]; },
      };

      await expect(createTurnSkills(permissive).load(name)).rejects.toThrow(/no skill named/);
    });
  }

  it("still loads a legitimately mounted skill", async () => {
    const fs = mounted(skill("building-apps", "Real.", "body\n"));
    expect(await createTurnSkills(fs).load("building-apps")).toBe("body\n");
  });

  it("refuses a name that a permissive fs would resolve but that nothing mounted", async () => {
    const fs = mounted(skill("building-apps", "Real.", "body\n"));
    await expect(createTurnSkills(fs).load("house-style")).rejects.toThrow(/house-style/);
  });
});

describe("descriptions stay on one frontmatter line (F8)", () => {
  it("escapes a newline so the YAML frontmatter is still parseable", async () => {
    const description = "First line.\nSecond line.";
    const rendered = renderSkillMd(skill("multi", description, "body\n"));

    // Exactly four frontmatter lines: ---, name, description, ---.
    expect(rendered.split("\n").slice(0, 4)).toEqual([
      "---",
      'name: "multi"',
      'description: "First line.\\nSecond line."',
      "---",
    ]);
  });

  it("reads the description back with its newline intact", async () => {
    const description = "First line.\nSecond line.";
    const fs = mounted(skill("multi", description, "body\n"));

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "multi", description }]);
  });

  it("escapes tabs and carriage returns too", async () => {
    const description = "a\tb\r\nc";
    const fs = mounted(skill("ws", description, "body\n"));

    // The frontmatter is still exactly four lines — no raw whitespace escaped in.
    expect(renderSkillMd(skill("ws", description, "body\n")).split("\n").slice(0, 4)).toEqual([
      "---",
      'name: "ws"',
      'description: "a\\tb\\r\\nc"',
      "---",
    ]);
    expect(await createTurnSkills(fs).list()).toEqual([{ name: "ws", description }]);
  });

  it("roundtrips a description that carries a literal backslash-n", async () => {
    // The escape must be reversible, not lossy: "\\n" as TEXT must not come
    // back as a newline.
    const description = String.raw`the literal \n, not a newline`;
    const fs = mounted(skill("literal", description, "body\n"));

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "literal", description }]);
  });
});

describe("TurnSkills (build contract §1.2)", () => {
  it("lists name and description only — never the body", async () => {
    const body = "a very long body ".repeat(500);
    const fs = mounted(skill("big", "One short line.", body));

    const listing = await createTurnSkills(fs).list();
    expect(listing).toEqual([{ name: "big", description: "One short line." }]);
    expect(JSON.stringify(listing)).not.toContain("very long body");
  });

  it("lists host-authored skills already on the mount, not just projected ones", async () => {
    // /host/ is the host's own skills + pack skills alike (architecture §8):
    // the disk is the one source of truth, so a hand-authored SKILL.md lists.
    const fs = memoryFs({
      "/host/skills/house-style/SKILL.md": '---\nname: house-style\ndescription: How this company writes.\n---\n\nBe brief.\n',
    });

    expect(await createTurnSkills(fs).list()).toEqual([
      { name: "house-style", description: "How this company writes." },
    ]);
  });

  it("ignores files under the mount that are not a SKILL.md", async () => {
    const fs = memoryFs({
      "/host/skills/a/SKILL.md": "---\nname: a\ndescription: Real.\n---\n\nbody\n",
      "/host/skills/a/reference.md": "not a skill",
      "/host/knowledge/notes.md": "not a skill either",
    });

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "a", description: "Real." }]);
  });

  it("lists in a stable order regardless of how the filesystem enumerates", async () => {
    const fs = memoryFs({
      "/host/skills/zeta/SKILL.md": "---\nname: zeta\ndescription: Z.\n---\n\nz\n",
      "/host/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: A.\n---\n\na\n",
    });

    expect((await createTurnSkills(fs).list()).map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("takes the directory name as the skill's name, so load(name) always finds it", async () => {
    // A hand-edited frontmatter name that disagrees with its folder would
    // otherwise list a name load() cannot resolve.
    const fs = memoryFs({
      "/host/skills/on-disk/SKILL.md": "---\nname: something-else\ndescription: Mismatched.\n---\n\nbody\n",
    });

    const skills = createTurnSkills(fs);
    expect(await skills.list()).toEqual([{ name: "on-disk", description: "Mismatched." }]);
    expect(await skills.load("on-disk")).toBe("body\n");
  });

  it("describes a skill whose SKILL.md has no frontmatter with an empty description", async () => {
    const fs = memoryFs({ "/host/skills/bare/SKILL.md": "just a body\n" });

    const skills = createTurnSkills(fs);
    expect(await skills.list()).toEqual([{ name: "bare", description: "" }]);
    expect(await skills.load("bare")).toBe("just a body\n");
  });

  it("throws naming the skill when load() is asked for one that is not mounted", async () => {
    const skills = createTurnSkills(memoryFs());
    await expect(skills.load("absent")).rejects.toThrow(/absent/);
  });

  it("lists nothing when the mount is empty", async () => {
    expect(await createTurnSkills(memoryFs()).list()).toEqual([]);
  });
});
