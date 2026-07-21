import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adapt, confineToolToRoot } from "./sdk-seam.js";

async function* streamOf(...messages: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const m of messages) yield m;
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("adapt (raw SDK message stream -> EngineMessage)", () => {
  it("yields a progress message for assistant text blocks", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "text", text: "thinking about it" }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "thinking about it" }]);
  });

  it("drops empty assistant text blocks", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "text", text: "" }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([]);
  });

  it("yields a progress message naming the tool and its file_path target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Read src/index.ts" }]);
  });

  it("yields a progress message naming the tool and its glob pattern target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Glob **/*.ts" }]);
  });

  it("yields just the tool name when tool_use carries no recognizable target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: {} }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Grep" }]);
  });

  it("handles multiple content blocks in one assistant message", async () => {
    const raw = {
      type: "assistant",
      message: { content: [{ type: "text", text: "checking" }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
    };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([
      { kind: "progress", text: "checking" },
      { kind: "progress", text: "Read a.ts" },
    ]);
  });

  it("yields success from a result message and stops (does not read past it)", async () => {
    let readAfter = false;
    async function* gen() {
      yield { type: "result", subtype: "success", result: "the final answer" };
      readAfter = true;
      yield { type: "assistant", message: { content: [] } };
    }
    await expect(collect(adapt(gen()))).resolves.toEqual([{ kind: "success", text: "the final answer" }]);
    expect(readAfter).toBe(false);
  });

  it("yields failure with the error subtype's errors array", async () => {
    const raw = { type: "result", subtype: "error_max_turns", errors: ["ran out of turns"] };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "failure", errors: ["ran out of turns"] }]);
  });

  it("synthesizes an error message from the subtype when errors is missing or malformed", async () => {
    await expect(collect(adapt(streamOf({ type: "result", subtype: "error_max_budget_usd" })))).resolves.toEqual([
      { kind: "failure", errors: ["engine error_max_budget_usd"] },
    ]);
    await expect(collect(adapt(streamOf({ type: "result", subtype: "error_during_execution", errors: "not an array" })))).resolves.toEqual([
      { kind: "failure", errors: ["engine error_during_execution"] },
    ]);
  });

  it("yields nothing for message types it doesn't recognize", async () => {
    await expect(collect(adapt(streamOf({ type: "system", subtype: "init" })))).resolves.toEqual([]);
  });
});

describe("confineToolToRoot (read confinement for the canUseTool callback)", () => {
  // Real directories so the symlink case is a real symlink, not a mock.
  // realpathSync because tmpdir() itself sits behind a symlink on macOS
  // (/var -> /private/var) — same normalization createSdkQuery applies.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "vendo-engine-outside-")));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vendo-engine-root-")));
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
    expect(verdict).toMatchObject({ message: expect.stringContaining("outside the engine job root") });
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
