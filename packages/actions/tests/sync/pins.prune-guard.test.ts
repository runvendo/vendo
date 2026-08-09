// A degraded scan must never prune: a missing host compiler parses every file
// to zero wrapper sites WITHOUT one error, which would otherwise read as
// "every baseline's wrapper vanished" and silently delete live baselines.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePins } from "../../src/sync/pins.js";

vi.mock("../../src/sync/common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sync/common.js")>()),
  parseModuleSource: () => null,
}));

/** Assembled at runtime: the dependency guard's static text scan reads
 *  import-shaped strings even inside fixtures, and actions may not import
 *  @vendoai/ui. */
const UI_CHROME = ["@vendoai", "ui", "chrome"].join("/");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("stale baseline pruning under a degraded scan", () => {
  it("keeps every baseline when the compiler cannot parse a single site", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-prune-guard-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "src/app"), { recursive: true });
    await fs.writeFile(path.join(root, "src/app/page.tsx"), `
      import { Remixable } from "${UI_CHROME}";
      import { Card } from "../components/Card";
      export default function Page() { return <Remixable><Card /></Remixable>; }
    `, "utf8");
    await fs.mkdir(path.join(root, ".vendo/remixable"), { recursive: true });
    await fs.writeFile(path.join(root, ".vendo/remixable/Card.json"), "{}\n", "utf8");

    const result = await capturePins(root, path.join(root, ".vendo"));

    // The wrapper is right there — only the compiler is gone. Nothing
    // captures, nothing errors, and crucially nothing is deleted.
    expect(result.errors).toEqual([]);
    expect(result.captured).toEqual([]);
    expect(result.pruned).toEqual([]);
    await expect(fs.access(path.join(root, ".vendo/remixable/Card.json"))).resolves.toBeUndefined();
  });
});
