import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsonSchemaFromExample, loadCases, loadWorld, riskOf, worldForCase } from "./world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worldDir = join(root, "worlds", "maple");
const casesPath = join(worldDir, "cases.json");

/** A world folder holding maple's authored file and whatever face the caller
 *  puts beside it — the two-file minimum `loadWorld` reads. */
async function worldFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genbench-world-"));
  await writeFile(join(dir, "world.json"), await readFile(join(worldDir, "world.json")));
  return dir;
}

describe("loadWorld", () => {
  it("names the worlds that exist when asked for one that does not", async () => {
    // A typo deserves the list of real names, in the product's own voice — not
    // a raw ENOENT naming a path the person never typed.
    await expect(loadWorld(join(root, "worlds", "nosuch"))).rejects.toThrow(
      'genbench: unknown world "nosuch" (available: maple)',
    );
  });

  it("loads a world that ships no face, because the face is genuinely optional", async () => {
    const world = await loadWorld(await worldFolder());
    expect(world.font).toBeUndefined();
  });

  /**
   * The face is optional only when it is ABSENT.
   *
   * A face that is there and unreadable renders as a fallback, and reporting
   * that as "ships none" hands it the hash of a world that ships none — so two
   * runs painted in different type compare as the same world, which is the one
   * thing the hash exists to prevent.
   */
  it("refuses a face it cannot read, rather than hashing as a world that ships none", async () => {
    const dir = await worldFolder();
    await mkdir(join(dir, "font.woff2"));

    await expect(loadWorld(dir)).rejects.toThrow(/EISDIR/);
  });
});

describe("jsonSchemaFromExample", () => {
  it("describes a row array by its first row, with every field required", () => {
    expect(jsonSchemaFromExample([{ id: "tr_1", amount: 250, ok: true }])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "number" }, ok: { type: "boolean" } },
        required: ["id", "amount", "ok"],
        additionalProperties: false,
      },
    });
  });

  it("describes an empty array without inventing a row shape", () => {
    expect(jsonSchemaFromExample([])).toEqual({ type: "array" });
  });

  it("recurses into nested objects", () => {
    expect(jsonSchemaFromExample({ meta: { page: 1 } })).toEqual({
      type: "object",
      properties: {
        meta: { type: "object", properties: { page: { type: "number" } }, required: ["page"], additionalProperties: false },
      },
      required: ["meta"],
      additionalProperties: false,
    });
  });
});

describe("riskOf", () => {
  it("grades a tool that returns rows as a read", () => {
    expect(riskOf({ does: "x", data: [] })).toBe("read");
  });

  it("grades a tool that only takes arguments as a write", () => {
    expect(riskOf({ does: "x", takes: { id: "string" } })).toBe("write");
  });
});

describe("the authored world", () => {
  it("derives an input schema from the takes map, not from example values", async () => {
    const world = await loadWorld(worldDir);
    const cancel = world.tools.find((tool) => tool.name === "cancel_transfer");
    expect(cancel?.descriptor.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("keeps every write tool off the read grade, so the loadout filter can drop it", async () => {
    const world = await loadWorld(worldDir);
    expect(world.tools.find((tool) => tool.name === "cancel_transfer")?.descriptor.risk).toBe("write");
    expect(world.tools.find((tool) => tool.name === "list_transfers")?.descriptor.risk).toBe("read");
  });
});

describe("worldForCase", () => {
  it("replaces only the named tool's data and re-derives its output schema", async () => {
    const world = await loadWorld(worldDir);
    const cases = await loadCases(casesPath);
    const empty = cases.find((entry) => entry.id === "no-pending-transfers")!;
    const scoped = worldForCase(world, empty);

    const transfers = scoped.tools.find((tool) => tool.name === "list_transfers")!;
    expect(transfers.data).toEqual({ data: [] });
    expect(transfers.descriptor.outputSchema).toEqual({
      type: "object",
      properties: { data: { type: "array" } },
      required: ["data"],
      additionalProperties: false,
    });

    const accounts = scoped.tools.find((tool) => tool.name === "list_accounts")!;
    expect(accounts.data).toEqual(world.tools.find((tool) => tool.name === "list_accounts")!.data);
  });

  it("returns the world untouched when the case overrides nothing", async () => {
    const world = await loadWorld(worldDir);
    const cases = await loadCases(casesPath);
    const plain = cases.find((entry) => entry.id === "spend-overview")!;
    expect(worldForCase(world, plain)).toBe(world);
  });
});

describe("loadCases", () => {
  it("rejects a duplicate case id", async () => {
    await expect(loadCases(join(root, "src", "fixtures", "duplicate-cases.json"))).rejects.toThrow(/duplicate case id/);
  });
});
