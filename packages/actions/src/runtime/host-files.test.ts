import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
