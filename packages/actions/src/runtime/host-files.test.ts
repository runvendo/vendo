import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// A real workerd run reports a "not implemented" Error with NO .code at all
// when a build's "workerd" custom condition didn't resolve to
// host-files-edge.ts and node:fs/promises falls through to unenv's shim
// instead of a real filesystem. Mocked here (module-level, so
// readOptionalVendoJson's own `import { readFile }` resolves to the mock)
// rather than reproduced on a real disk — unenv's exact failure mode isn't
// reproducible on a real filesystem. Defaults to the real implementation so
// every other test in this file still hits a real temp dir; only the one
// test below overrides it.
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

import { readOptionalVendoJson } from "./host-files.js";
import { readOptionalVendoJson as readOnEdge } from "./host-files-edge.js";

describe("host config files, node entry", () => {
  it("reads and parses a .vendo file, resolving the dir from a host root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-host-files-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: "vendo/tools@1", tools: [] }));
    const parsed = await readOptionalVendoJson(root, "tools.json", (value) => value as { tools: unknown[] });
    expect(parsed).toEqual({ format: "vendo/tools@1", tools: [] });
  });

  it("returns undefined for a missing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-host-files-"));
    const parsed = await readOptionalVendoJson(root, "tools.json", (value) => value);
    expect(parsed).toBeUndefined();
  });

  it("degrades to undefined on a CODE-LESS read failure (workerd unenv error class), never throws", async () => {
    // Only ENOENT and a code-less failure degrade — see the module comment
    // in host-files.ts for why code-less specifically means "this is
    // workerd's unenv shim", not a real filesystem. See the module-level
    // mock comment above for why this isn't reproduced on a real disk.
    const notImplemented = Object.assign(new Error("not implemented"), { code: undefined });
    readFileMock.mockRejectedValueOnce(notImplemented);
    const root = await mkdtemp(join(tmpdir(), "vendo-host-files-unenv-"));
    await expect(readOptionalVendoJson(root, "tools.json", (value) => value)).resolves.toBeUndefined();
  });

  it("still THROWS on a real fs error code (EACCES/EISDIR/EMFILE) — a present-but-unreadable file must fail closed, not silently drop it", async () => {
    // overrides.json is the case that matters: absent is MORE permissive
    // (a disabled tool or audience exclusion vanishes, going live), so a
    // present file this host cannot read for a real reason must surface
    // loudly rather than silently compose as if it were never there.
    for (const code of ["EACCES", "EISDIR", "EMFILE"]) {
      const classedFailure = Object.assign(new Error(`simulated ${code}`), { code });
      readFileMock.mockRejectedValueOnce(classedFailure);
      const root = await mkdtemp(join(tmpdir(), `vendo-host-files-${code}-`));
      await expect(readOptionalVendoJson(root, "overrides.json", (value) => value)).rejects.toMatchObject({
        name: "VendoError",
        code: "validation",
        detail: { cause: `simulated ${code}` },
      });
    }
  });

  it("still throws loudly on malformed JSON — only read failures degrade, not content-shape failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-host-files-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), "{ not valid json");
    await expect(readOptionalVendoJson(root, "tools.json", (value) => value)).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
    });
  });
});

describe("host config files, edge entry", () => {
  it("reports every file absent (no filesystem on edge runtimes)", async () => {
    await expect(readOnEdge("/srv/app", "tools.json", (value) => value)).resolves.toBeUndefined();
  });

  it("keeps the edge module free of node builtins", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./host-files-edge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
  });
});
