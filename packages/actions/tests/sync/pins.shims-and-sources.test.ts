import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePins } from "../../src/sync/seeds.js";

/** The proven wrapper-import specifier fixtures write to disk. Assembled at
 *  runtime because the dependency guard's static text scan reads
 *  import-shaped strings even inside fixtures, and actions may not import
 *  @vendoai/ui. */
const UI_CHROME = ["@vendoai", "ui", "chrome"].join("/");

const temporaryDirectories: string[] = [];

/** A repo with the shape that broke sync: a Next app in `host/`, demo screens
 *  in a SIBLING `demos/`, and a kit module the demos import Vendo through. */
async function temporaryRepo(): Promise<{ repo: string; host: string; out: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-pin-shim-"));
  temporaryDirectories.push(repo);
  const host = path.join(repo, "host");
  await fs.mkdir(path.join(host, "src"), { recursive: true });
  await write(host, "tsconfig.json", JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@host/*": ["./src/kit/*"] } },
  }));
  return { repo, host, out: path.join(host, ".vendo") };
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** The demo screen every case below wraps, and the component it wraps. */
async function writeDemoScreen(repo: string, kitSpecifier: string): Promise<void> {
  await write(repo, "demos/maple/Overview.tsx", `
    import { Remixable } from "${kitSpecifier}";
    import { NetWorth } from "./NetWorth";
    export function Overview() { return <Remixable><NetWorth total={7} /></Remixable>; }
  `);
  await write(repo, "demos/maple/NetWorth.tsx",
    "export function NetWorth(props: { total: number }) { return <div>{props.total}</div>; }");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("wrappers behind a host re-export shim", () => {
  it.each([
    ["export { Remixable } from", `export { Remixable } from "${UI_CHROME}";`],
    ["export { X as Remixable } from", `export { Remixable as Remixable } from "${UI_CHROME}";`],
    ["export * from", `export * from "${UI_CHROME}";`],
    ["import then export", `import { Remixable } from "${UI_CHROME}";\nexport { Remixable };`],
  ])("captures through a kit that re-exports Vendo's Remixable (%s)", async (_name, kitSource) => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", kitSource);
    await writeDemoScreen(repo, "@host/vendo-kit");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.errors).toEqual([]);
    expect(result.unattributed).toEqual([]);
    expect(result.captured).toEqual(["NetWorth"]);
  }, 60_000);

  it("captures through a RELATIVE shim, with no path alias in play", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(repo, "demos/maple/kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "./kit");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.unattributed).toEqual([]);
    expect(result.captured).toEqual(["NetWorth"]);
  }, 60_000);

  it("keeps a same-named component from somewhere else OUT of the capture", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts",
      "export function Remixable({ children }: { children: unknown }) { return children; }");
    await writeDemoScreen(repo, "@host/vendo-kit");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.captured).toEqual([]);
  }, 60_000);
});

describe("the loud miss", () => {
  it("names the file, the line, the specifier, and both fixes", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts",
      "export function Remixable({ children }: { children: unknown }) { return children; }");
    await writeDemoScreen(repo, "@host/vendo-kit");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.unattributed).toHaveLength(1);
    const [miss] = result.unattributed as [string];
    // Where.
    expect(miss).toContain("../demos/maple/Overview.tsx:4");
    // What sync saw, and could not follow.
    expect(miss).toContain('`Remixable` comes from "@host/vendo-kit"');
    expect(miss).toContain("NOT captured");
    // Both exact next steps.
    expect(miss).toContain(`import { Remixable } from "${UI_CHROME}"`);
    expect(miss).toContain(`export { Remixable } from "${UI_CHROME}"`);
  }, 60_000);

  it("says so when the wrapper's Remixable is not imported at all", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(repo, "demos/maple/Overview.tsx", `
      import { NetWorth } from "./NetWorth";
      function Remixable({ children }: { children: unknown }) { return children; }
      export function Overview() { return <Remixable><NetWorth total={7} /></Remixable>; }
    `);
    await write(repo, "demos/maple/NetWorth.tsx",
      "export function NetWorth(props: { total: number }) { return <div>{props.total}</div>; }");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.unattributed).toHaveLength(1);
    expect(result.unattributed[0]).toContain("is not imported in this file");
    expect(result.unattributed[0]).toContain("rename it");
  }, 60_000);

  it("reports a namespace wrapper by the namespace it reads through", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", "export const Remixable = null;");
    await write(repo, "demos/maple/Overview.tsx", `
      import * as Kit from "@host/vendo-kit";
      import { NetWorth } from "./NetWorth";
      export function Overview() { return <Kit.Remixable><NetWorth total={7} /></Kit.Remixable>; }
    `);
    await write(repo, "demos/maple/NetWorth.tsx",
      "export function NetWorth(props: { total: number }) { return <div>{props.total}</div>; }");

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.unattributed).toHaveLength(1);
    expect(result.unattributed[0]).toContain("<Kit.Remixable> was NOT captured");
    expect(result.unattributed[0]).toContain('`Kit` comes from "@host/vendo-kit"');
  }, 60_000);

  it("stays quiet about ordinary JSX", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "@host/vendo-kit");
    await write(repo, "demos/maple/Other.tsx", `
      import { NetWorth } from "./NetWorth";
      export function Other() { return <section><NetWorth total={1} /></section>; }
    `);

    const result = await capturePins(host, out, { sources: ["../demos"] });

    expect(result.unattributed).toEqual([]);
  }, 60_000);

  it("never prunes a baseline on a run it could not attribute", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "@host/vendo-kit");
    const first = await capturePins(host, out, { sources: ["../demos"] });
    expect(first.captured).toEqual(["NetWorth"]);

    // The kit stops re-exporting Vendo's Remixable — the wrapper is still
    // there, so its baseline must survive rather than be read as deleted.
    await write(host, "src/kit/vendo-kit.ts",
      "export function Remixable({ children }: { children: unknown }) { return children; }");
    const second = await capturePins(host, out, { sources: ["../demos"] });

    expect(second.unattributed).toHaveLength(1);
    expect(second.pruned).toEqual([]);
    await expect(fs.stat(path.join(out, "remixable/NetWorth.json"))).resolves.toBeDefined();
  }, 60_000);
});

describe("extra source roots", () => {
  it("finds nothing without them, and everything with them", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "@host/vendo-kit");

    const unconfigured = await capturePins(host, out);
    expect(unconfigured.captured).toEqual([]);
    expect(unconfigured.unattributed).toEqual([]);

    const configured = await capturePins(host, out, { sources: ["../demos"] });
    expect(configured.captured).toEqual(["NetWorth"]);
  }, 60_000);

  it("keeps every captured id relative to the project root, so ids stay unique", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "@host/vendo-kit");
    await write(repo, "demos/maple/NetWorth.tsx", `
      import { Amount } from "./Amount";
      export function NetWorth(props: { total: number }) { return <Amount value={props.total} />; }
    `);
    await write(repo, "demos/maple/Amount.tsx",
      "export function Amount(props: { value: number }) { return <b>{props.value}</b>; }");

    await capturePins(host, out, { sources: ["../demos"] });

    const baseline = JSON.parse(await fs.readFile(path.join(out, "remixable/NetWorth.json"), "utf8")) as {
      sourceImports: Record<string, string>;
    };
    expect(baseline.sourceImports).toEqual({ "./Amount": "../demos/maple/Amount.tsx" });
  }, 60_000);

  it("says so when a configured source does not exist", async () => {
    const { host, out } = await temporaryRepo();

    const result = await capturePins(host, out, { sources: ["../nope"] });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('remix source "../nope" is not a readable directory');
    expect(result.warnings[0]).toContain("remix.sources");
  }, 60_000);

  it("leaves unrelated data in .vendo/ alone", async () => {
    const { repo, host, out } = await temporaryRepo();
    await write(host, "src/kit/vendo-kit.ts", `export { Remixable } from "${UI_CHROME}";`);
    await writeDemoScreen(repo, "@host/vendo-kit");
    // The embedded datastore's default home is `.vendo/data` (store/src/db.ts).
    await write(out, "data/pg.db", "not a baseline");

    await capturePins(host, out, { sources: ["../demos"] });

    await expect(fs.readFile(path.join(out, "data/pg.db"), "utf8")).resolves.toBe("not a baseline");
  }, 60_000);
});
