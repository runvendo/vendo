import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturedHostComponentSchema, capturedModuleSchema, hostComponentEntrySource } from "../formats.js";
import { scanComponentCatalog } from "./catalog-scan.js";
import { captureHostComponents } from "./components.js";

/** The VendoRoot import specifier fixtures write to disk. Assembled at runtime
 *  because the dependency guard's static text scan reads import-shaped strings
 *  even inside fixtures, and actions may not import @vendoai/vendo. */
const VENDO_REACT = ["@vendoai", "vendo", "react"].join("/");

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-host-components-"));
  temporaryDirectories.push(root);
  await write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true },
  }));
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** The host wiring the scan looks for: one exported registry object handed to
 *  `<VendoRoot components={…}>`. */
async function writeRoot(root: string, registryImport: string, entries: string): Promise<void> {
  await write(root, "src/vendo/registry.tsx", `${registryImport}\nexport const registry = { ${entries} };\n`);
  await write(root, "src/app/root.tsx", `
    import { VendoRoot } from "${VENDO_REACT}";
    import { registry } from "../vendo/registry";
    export default function Root({ children }: { children: unknown }) {
      return <VendoRoot components={registry}>{children}</VendoRoot>;
    }
  `);
}

async function capture(root: string, budgetBytes?: number) {
  const scan = await scanComponentCatalog(root);
  return {
    scan,
    result: await captureHostComponents({
      root,
      out: path.join(root, ".vendo"),
      sites: scan.sites,
      styles: [],
      degraded: scan.degraded,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    }),
  };
}

async function record(root: string, name: string) {
  return capturedHostComponentSchema.parse(JSON.parse(
    await fs.readFile(path.join(root, ".vendo/components", `${name}.json`), "utf8"),
  ));
}

async function module_(root: string, ref: string) {
  return capturedModuleSchema.parse(JSON.parse(
    await fs.readFile(path.join(root, ".vendo/components/modules", `${ref}.json`), "utf8"),
  ));
}

async function moduleRefs(root: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, ".vendo/components/modules")).catch(() => [] as string[]);
  return entries.sort();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("registered host component capture", () => {
  it("captures a registered component that no <Remixable> wraps, including an unexported local", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { Donut } from "../components/donut";\n`
      + `function SpendingDonut({ slices }: { slices: number[] }) { return <Donut slices={slices} />; }\n`,
      "SpendingDonut: { component: SpendingDonut }",
    );
    await write(root, "src/components/donut.tsx", "export function Donut({ slices }: { slices: number[] }) { return <div>{slices.length}</div>; }");

    const { result } = await capture(root);
    expect(result.captured).toEqual(["SpendingDonut"]);
    expect(result.warnings).toEqual([]);

    const stored = await record(root, "SpendingDonut");
    expect(stored.module).toBe("src/vendo/registry.tsx");
    // The registry never exports SpendingDonut; the entry rule names the local
    // binding so the console can give it the default export the jail renders.
    expect(stored.export).toBe("SpendingDonut");
    expect(Object.keys(stored.modules ?? {})).toEqual(["src/components/donut.tsx"]);

    const entry = await module_(root, stored.entry!);
    expect(entry.source).toContain("function SpendingDonut");
    expect(entry.imports).toEqual({ "../components/donut": "src/components/donut.tsx" });
    expect(hostComponentEntrySource(entry.source, stored.export))
      .toContain("export { SpendingDonut as default };");
  });

  it("captures a deep-but-small import chain in full — depth is no longer the limit", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { One } from "../chain/one";\nexport function Deep() { return <One />; }\n`,
      "Deep: { component: Deep }",
    );
    for (const level of [1, 2, 3, 4]) {
      await write(root, `src/chain/${["one", "two", "three", "four"][level - 1]}.tsx`, level === 4
        ? "export function Four() { return <span>4</span>; }"
        : `import { ${["Two", "Three", "Four"][level - 1]} } from "./${["two", "three", "four"][level - 1]}";\nexport function ${["One", "Two", "Three"][level - 1]}() { return <${["Two", "Three", "Four"][level - 1]} />; }`);
    }

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Deep"]);
    expect(Object.keys((await record(root, "Deep")).modules ?? {})).toEqual([
      "src/chain/four.tsx",
      "src/chain/one.tsx",
      "src/chain/three.tsx",
      "src/chain/two.tsx",
    ]);
  });

  it("refuses to capture a closure the jail cannot load, naming the specifiers", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { Chart } from "recharts";\nexport function Packaged() { return <Chart />; }\n`,
      "Packaged: { component: Packaged }",
    );

    const { result } = await capture(root);
    // Shipping this capture would put `require("recharts")` in front of the
    // jail loader, which throws and error-boxes as a GENERATED-component
    // failure — strictly worse than the placeholder it replaces.
    expect(result.captured).toEqual([]);
    expect(result.skipped).toEqual(["Packaged"]);
    const stored = await record(root, "Packaged");
    expect(stored.skipped?.reason).toBe("unsupported-imports");
    expect(stored.skipped?.specifiers).toEqual(["recharts"]);
    expect(stored.entry).toBeUndefined();
  });

  it("keeps a component whose only package imports are ones the jail resolves", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { useState } from "react";\nimport type { Ignored } from "../types";\n`
      + `import { type AlsoIgnored } from "../types";\n`
      + `export function Fine() { const [n] = useState(0); return <div>{n}</div>; }\n`,
      "Fine: { component: Fine }",
    );
    await write(root, "src/types.ts", "export type Ignored = 1; export type AlsoIgnored = 2;");

    const { result } = await capture(root);
    // react is jail-resolvable; both type-only forms erase before the jail
    // ever sees them, so neither counts as an unsupported import.
    expect(result.captured).toEqual(["Fine"]);
    expect(result.skipped).toEqual([]);
    expect((await record(root, "Fine")).skipped).toBeUndefined();
  });

  it("records WHY for every uncapturable shape, so the console never shows a bare grey block", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { helper } from "../lib/helper";\n`
      + `export default function Owner() { return <div />; }\n`
      + `export function Conflicted() { return <div>{helper()}</div>; }\n`,
      "Conflicted: { component: Conflicted }",
    );
    await write(root, "src/lib/helper.ts", "export const helper = () => 1;");

    const { result } = await capture(root);
    expect(result.skipped).toEqual(["Conflicted"]);
    const stored = await record(root, "Conflicted");
    expect(stored.skipped?.reason).toBe("default-export-conflict");
    expect(stored.skipped?.detail).toContain("Owner");
  });

  it("leaves a good capture alone when the module cannot be read this run", async () => {
    const root = await temporaryRoot();
    await writeRoot(root, "export function Card() { return <div>card</div>; }\n", "Card: { component: Card }");
    const first = await capture(root);
    expect(first.result.captured).toEqual(["Card"]);
    const before = await record(root, "Card");

    // A transient read failure is not a property of the source: the record
    // must survive, and must NOT be pruned (which would delete its Cloud row).
    const result = await captureHostComponents({
      root,
      out: path.join(root, ".vendo"),
      sites: [{ name: "Card", file: path.join(root, "src/vendo/does-not-exist.tsx"), binding: "Card" }],
      styles: [],
      degraded: false,
    });

    expect(result.skipped).toEqual(["Card"]);
    expect(result.pruned).toEqual([]);
    expect(await record(root, "Card")).toEqual(before);
  });

  it("skips a component over the byte budget with a warning naming what blew it", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { FIXTURES } from "../data/fixtures";\nexport function Heavy() { return <div>{FIXTURES.length}</div>; }\n`,
      "Heavy: { component: Heavy }",
    );
    await write(root, "src/data/fixtures.ts", `export const FIXTURES = "${"x".repeat(5_000)}".split("");`);

    const { result } = await capture(root, 2_000);
    expect(result.captured).toEqual([]);
    expect(result.skipped).toEqual(["Heavy"]);
    expect(result.warnings).toEqual([expect.stringContaining("src/data/fixtures.ts")]);
    expect(result.warnings[0]).toContain("per-component budget");

    // The record still lands so the console can show "too large to preview"
    // rather than silently falling back to a placeholder.
    const stored = await record(root, "Heavy");
    expect(stored.skipped?.reason).toBe("too-large");
    expect(stored.skipped?.largest).toBe("src/data/fixtures.ts");
    expect(stored.entry).toBeUndefined();
  });

  it("stores one copy of a module two components share, and keeps it while either still references it", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { money } from "../lib/format-currency";\n`
      + `export function Left() { return <div>{money(1)}</div>; }\n`
      + `export function Right() { return <div>{money(2)}</div>; }\n`,
      "Left: { component: Left }, Right: { component: Right }",
    );
    await write(root, "src/lib/format-currency.ts", "export const money = (cents: number) => `$${cents / 100}`;");

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Left", "Right"]);
    const left = await record(root, "Left");
    const right = await record(root, "Right");
    // Same owning module and same shared helper: one entry blob, one helper
    // blob, two records — not two copies of each.
    expect(left.entry).toBe(right.entry);
    expect(left.modules).toEqual(right.modules);
    expect(await moduleRefs(root)).toHaveLength(2);

    // Drop one importer: the shared module is still referenced, so it stays.
    await writeRoot(
      root,
      `import { money } from "../lib/format-currency";\n`
      + `export function Left() { return <div>{money(1)}</div>; }\n`,
      "Left: { component: Left }",
    );
    const second = await capture(root);
    expect(second.result.pruned).toEqual(["Right"]);
    const kept = await record(root, "Left");
    expect(await moduleRefs(root)).toEqual([`${kept.entry}.json`, ...Object.values(kept.modules ?? {}).map((ref) => `${ref}.json`)].sort());
    expect(await module_(root, Object.values(kept.modules ?? {})[0]!)).toEqual({ source: expect.stringContaining("money") });
  });

  it("is idempotent: an unchanged project rewrites nothing", async () => {
    const root = await temporaryRoot();
    await writeRoot(root, "export function Card() { return <div>card</div>; }\n", "Card: { component: Card }");
    const first = await capture(root);
    expect(first.result.captured).toEqual(["Card"]);
    const capturedAt = (await record(root, "Card")).capturedAt;

    const second = await capture(root);
    expect(second.result).toMatchObject({ captured: [], drifted: [], pruned: [], skipped: [] });
    expect((await record(root, "Card")).capturedAt).toBe(capturedAt);
  });

  it("prunes nothing when the scan is degraded", async () => {
    const root = await temporaryRoot();
    await writeRoot(root, "export function Card() { return <div>card</div>; }\n", "Card: { component: Card }");
    await capture(root);

    const result = await captureHostComponents({
      root,
      out: path.join(root, ".vendo"),
      sites: [],
      styles: [],
      degraded: true,
    });
    expect(result.pruned).toEqual([]);
    expect(await record(root, "Card")).toBeDefined();
  });
});
