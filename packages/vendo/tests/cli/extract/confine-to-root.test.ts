import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confineToolToRoot, resolveThroughSymlinks, rootScopedToolRules } from "../../../src/cli/extract/confine-to-root.js";

describe("confineToolToRoot (read confinement for the canUseTool callback)", () => {
  // Real directories so the symlink case is a real symlink, not a mock.
  // realpathSync because tmpdir() itself sits behind a symlink on macOS
  // (/var -> /private/var) — same normalization claudeHarness applies.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-outside-")));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-root-")));
  writeFileSync(join(root, "in-root.txt"), "in-root", "utf8");
  writeFileSync(join(outside, "secret.txt"), "credentials", "utf8");
  mkdirSync(join(root, "sub"));
  symlinkSync(outside, join(root, "escape-link"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const allow = (input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input });

  it("allows a Read of a relative path inside the root", () => {
    const input = { file_path: "in-root.txt" };
    expect(confineToolToRoot("Read", input, root)).toEqual(allow(input));
  });

  it("allows a Read of an absolute path inside the root", () => {
    const input = { file_path: join(root, "sub", "not-yet-created.txt") };
    expect(confineToolToRoot("Read", input, root)).toEqual(allow(input));
  });

  it("denies a Read of an absolute path outside the root", () => {
    const verdict = confineToolToRoot("Read", { file_path: join(outside, "secret.txt") }, root);
    expect(verdict.behavior).toBe("deny");
    expect(verdict).toMatchObject({ message: expect.stringContaining("outside the extraction root") });
  });

  it("denies a ../ escape even when the traversal is buried mid-path", () => {
    const verdict = confineToolToRoot("Read", { file_path: `sub/../../${"secret.txt"}` }, root);
    expect(verdict.behavior).toBe("deny");
  });

  it("denies a Read through a symlink inside the root that points outside it", () => {
    const verdict = confineToolToRoot("Read", { file_path: "escape-link/secret.txt" }, root);
    expect(verdict.behavior).toBe("deny");
  });

  it("denies a prefix-sibling of the root (root + suffix without a separator)", () => {
    const verdict = confineToolToRoot("Read", { file_path: `${root}-sibling/file.txt` }, root);
    expect(verdict.behavior).toBe("deny");
  });

  it("confines Grep's path search root, and allows Grep with no path (defaults to cwd)", () => {
    expect(confineToolToRoot("Grep", { pattern: "secret", path: outside }, root).behavior).toBe("deny");
    const input = { pattern: "/etc/passwd" }; // regex, not a path — must not be confined
    expect(confineToolToRoot("Grep", input, root)).toEqual(allow(input));
  });

  it("confines Glob's path field and an absolute pattern's static base", () => {
    expect(confineToolToRoot("Glob", { pattern: "**/*.ts", path: outside }, root).behavior).toBe("deny");
    expect(confineToolToRoot("Glob", { pattern: `${outside}/**/*.txt` }, root).behavior).toBe("deny");
    expect(confineToolToRoot("Glob", { pattern: "../**/*.txt" }, root).behavior).toBe("deny");
    expect(confineToolToRoot("Glob", { pattern: "/*" }, root).behavior).toBe("deny");
    const relative = { pattern: "**/*.ts" };
    expect(confineToolToRoot("Glob", relative, root)).toEqual(allow(relative));
  });

  it("allows the root itself as a target", () => {
    const input = { path: root, pattern: "**/*" };
    expect(confineToolToRoot("Glob", input, root)).toEqual(allow(input));
  });

  it("allows tools without path-shaped inputs (the tools option already bounds the set)", () => {
    const input = { anything: "goes" };
    expect(confineToolToRoot("SomeOtherTool", input, root)).toEqual(allow(input));
  });
});

describe("rootScopedToolRules (read confinement for the CLI rungs' flags)", () => {
  it("scopes every read-only tool to the root instead of naming it bare", () => {
    expect(rootScopedToolRules("/host/root")).toEqual([
      "Read(//host/root/**)",
      "Glob(//host/root/**)",
      "Grep(//host/root/**)",
    ]);
  });

  it("never emits a bare tool name — a bare name is the blanket any-path auto-allow this replaces", () => {
    for (const rule of rootScopedToolRules("/host/root")) {
      expect(rule).toMatch(/^(Read|Glob|Grep)\(\/\/.+\/\*\*\)$/);
    }
  });

  it("normalizes an untidy root so the rule names one canonical directory", () => {
    expect(rootScopedToolRules("/host/nested/../root/")).toEqual(rootScopedToolRules("/host/root"));
  });

  it("scopes BOTH the symlinked root and its realpath, so a symlinked root still reads itself", () => {
    // macOS points /tmp at /private/tmp: the CLI matches an allow rule against
    // the path the model supplied (the symlinked form) AND its target (the
    // realpath), so a rule for only one of the two denies every in-root read.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-rule-real-")));
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-rule-link-")));
    const link = join(parent, "root");
    symlinkSync(real, link);
    try {
      expect(rootScopedToolRules(link)).toEqual([
        `Read(/${link}/**)`,
        `Glob(/${link}/**)`,
        `Grep(/${link}/**)`,
        `Read(/${real}/**)`,
        `Glob(/${real}/**)`,
        `Grep(/${real}/**)`,
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("resolveThroughSymlinks", () => {
  it("resolves a symlinked ancestor to its real target", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-link-target-")));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vendo-extract-link-root-")));
    symlinkSync(outside, join(root, "link"));
    try {
      expect(resolveThroughSymlinks(join(root, "link", "file.txt"))).toBe(join(outside, "file.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns a wholly non-existent path unchanged instead of throwing", () => {
    expect(resolveThroughSymlinks("/vendo-no-such-root-9f3a/sub")).toBe("/vendo-no-such-root-9f3a/sub");
  });
});
