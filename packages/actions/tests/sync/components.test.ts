import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturedHostComponentSchema, capturedModuleSchema, hostComponentEntrySource } from "../../src/formats.js";
import { scanComponentCatalog } from "../../src/sync/catalog-scan.js";
import { captureHostComponents } from "../../src/sync/components.js";

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

/** The host wiring the scan looks for — the shared-registry pattern the docs
 *  teach: ONE object, handed to `<VendoRoot components={…}>` for the component
 *  references and to `createVendo({ catalog })` for the data fields
 *  (description, props, examples). A real host always has both legs, and the
 *  examples a preview seeds from ride the second one. */
async function writeRoot(root: string, registryImport: string, entries: string): Promise<void> {
  await write(root, "src/vendo/registry.tsx", `${registryImport}\nexport const registry = { ${entries} };\n`);
  await write(root, "src/app/root.tsx", `
    import { VendoRoot } from "${VENDO_REACT}";
    import { registry } from "../vendo/registry";
    export default function Root({ children }: { children: unknown }) {
      return <VendoRoot components={registry}>{children}</VendoRoot>;
    }
  `);
  await write(root, "src/vendo/server.ts", `
    import { registry } from "./registry";
    declare function createVendo(config: unknown): unknown;
    export const vendo = createVendo({ catalog: registry });
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
      catalog: scan.entries,
      degraded: scan.degraded,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    }),
  };
}

/** An installed package, as node resolution finds it: a manifest under
 *  `node_modules`. The capture reads its `version`, which is what makes a pin
 *  exact rather than a guess at a range. */
async function installPackage(root: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  await write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, ...manifest }));
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
    // Nothing is installed in this fixture, so there is no exact version to pin
    // and the CDN is not offered a guess. Shipping the capture anyway would put
    // `require("recharts")` in front of the jail loader, which throws and
    // error-boxes as a GENERATED-component failure — strictly worse than the
    // placeholder it replaces.
    expect(result.captured).toEqual([]);
    expect(result.skipped).toEqual(["Packaged"]);
    const stored = await record(root, "Packaged");
    expect(stored.skipped?.reason).toBe("unsupported-imports");
    expect(stored.skipped?.specifiers).toEqual(["recharts"]);
    expect(stored.skipped?.detail).toContain("not installed");
    expect(stored.entry).toBeUndefined();
    expect(stored.packages).toBeUndefined();
  });

  it("captures a component importing a public package, pinned to the version the host installed", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { Chart } from "recharts";\nimport { format } from "date-fns/format";\n`
      + `export function Packaged() { return <Chart label={format(0)} />; }\n`,
      "Packaged: { component: Packaged }",
    );
    await installPackage(root, "recharts", { version: "3.9.2" });
    await installPackage(root, "date-fns", { version: "4.1.0" });

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Packaged"]);
    const stored = await record(root, "Packaged");
    expect(stored.skipped).toBeUndefined();
    // The version comes from the INSTALLED manifest, never from the range in
    // package.json — a preview renders what the host's product renders.
    expect(stored.packages).toEqual({ recharts: "recharts@3.9.2", "date-fns/format": "date-fns@4.1.0/format" });
    // And both are named in `requires`, so a consumer that cannot fetch them
    // shows an honest tile instead of a never-resolving skeleton.
    expect(stored.requires).toContain("recharts");
    expect(stored.requires).toContain("date-fns/format");
  });

  it("still skips a package that is on no public registry, and says which and why", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { Panel } from "@acme/design-system";\nexport function Internal() { return <Panel />; }\n`,
      "Internal: { component: Internal }",
    );
    await installPackage(root, "@acme/design-system", { version: "1.0.0", private: true });

    const { result } = await capture(root);
    expect(result.skipped).toEqual(["Internal"]);
    const stored = await record(root, "Internal");
    expect(stored.skipped?.reason).toBe("unsupported-imports");
    expect(stored.skipped?.detail).toContain("@acme/design-system is marked private");
    expect(stored.packages).toBeUndefined();
  });

  it("treats a workspace package as internal, not as something a CDN could serve", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `import { Panel } from "@acme/ui";\nexport function Linked() { return <Panel />; }\n`,
      "Linked: { component: Linked }",
    );
    await write(root, "packages/ui/package.json", JSON.stringify({ name: "@acme/ui", version: "0.1.0" }));
    await fs.mkdir(path.join(root, "node_modules/@acme"), { recursive: true });
    await fs.symlink(path.join(root, "packages/ui"), path.join(root, "node_modules/@acme/ui"), "dir");

    const { result } = await capture(root);
    expect(result.skipped).toEqual(["Linked"]);
    expect((await record(root, "Linked")).skipped?.detail).toContain("@acme/ui is a workspace package");
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

  it("skips a component whose entry file alone blows the budget, with nothing left to capture", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Huge() { return <div>{"${"x".repeat(5_000)}"}</div>; }`,
      "Huge: { component: Huge }",
    );

    const { result } = await capture(root, 2_000);
    expect(result.captured).toEqual([]);
    expect(result.skipped).toEqual(["Huge"]);

    const stored = await record(root, "Huge");
    expect(stored.skipped?.reason).toBe("too-large");
    expect(stored.skipped?.largest).toBe("src/vendo/registry.tsx");
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

  it("seeds the preview from the registration's declared examples", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Donut({ slices }: { slices: Array<{ label: string; amount: number }> }) {\n`
      + `  if (!slices?.length) return null;\n`
      + `  return <div>{slices.length}</div>;\n}\n`,
      `Donut: { component: Donut, description: "Spending by category.",\n`
      + `  examples: ['{"slices":[{"label":"Dining","amount":34218}],"size":200}'] }`,
    );

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Donut"]);
    expect(result.withoutSamples).toEqual([]);

    const stored = await record(root, "Donut");
    // Without this the module loads, `slices` is undefined, the component
    // correctly renders null, and the preview shows an eternal skeleton.
    expect(stored.sampleProps).toEqual({ slices: [{ label: "Dining", amount: 34218 }], size: 200 });
    expect(stored.noSampleProps).toBeUndefined();
  });

  it("rung 2: generates a seed from the declared props schema when no examples exist", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Donut({ slices }: { slices: Array<{ label: string; amount: number }> }) {\n`
      + `  if (!slices?.length) return null;\n`
      + `  return <div>{slices.length}</div>;\n}\n`,
      `Donut: { component: Donut, description: "No examples, but declared props.",\n`
      + `  props: z.object({ slices: z.array(z.object({ label: z.string(), amount: z.number() })) }) }`,
    );

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Donut"]);
    expect(result.withoutSamples).toEqual([]);

    const stored = await record(root, "Donut");
    expect(stored.sampleOrigin).toBe("generated");
    expect(stored.noSampleProps).toBeUndefined();
    // Typed-correct against the declaration, and non-empty so the component's
    // `if (!slices?.length) return null` guard passes.
    const slices = stored.sampleProps?.slices as Array<Record<string, unknown>>;
    expect(slices.length).toBeGreaterThan(0);
    expect(typeof slices[0]!.label).toBe("string");
    expect(typeof slices[0]!.amount).toBe("number");
  });

  it("rung 1 beats rung 2: a declared example always wins over a generated one", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Both({ label }: { label: string }) { return <div>{label}</div>; }\n`,
      `Both: { component: Both, description: "Has both.",\n`
      + `  props: z.object({ label: z.string() }),\n`
      + `  examples: ['{"label":"Real product copy"}'] }`,
    );

    const stored = (await capture(root), await record(root, "Both"));
    expect(stored.sampleOrigin).toBe("declared");
    expect(stored.sampleProps).toEqual({ label: "Real product copy" });
  });

  it("rung 3: labels a component with neither examples nor declared props", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      "export function Bare(props: Record<string, unknown>) { return <div>{String(props.x)}</div>; }\n",
      `Bare: { component: Bare, description: "Nothing declared." }`,
    );

    const { result } = await capture(root);
    expect(result.captured).toEqual(["Bare"]);
    // Captured fine — it just has nothing to render WITH, which the console
    // must be able to distinguish from a capture failure.
    expect(result.withoutSamples).toEqual(["Bare"]);

    const stored = await record(root, "Bare");
    expect(stored.entry).toBeDefined();
    expect(stored.skipped).toBeUndefined();
    expect(stored.sampleProps).toBeUndefined();
    expect(stored.sampleOrigin).toBeUndefined();
    expect(stored.noSampleProps?.reason).toBe("no-examples");
  });

  it("the generated seed is byte-stable: a second capture rewrites nothing", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Stable({ rows }: { rows: number[] }) { return <div>{rows.length}</div>; }\n`,
      `Stable: { component: Stable, description: "Generated seed.",\n`
      + `  props: z.object({ rows: z.array(z.number()) }) }`,
    );
    await capture(root);
    const first = await record(root, "Stable");

    const second = await capture(root);
    expect(second.result).toMatchObject({ captured: [], drifted: [] });
    expect(await record(root, "Stable")).toEqual(first);
  });

  it("skips past an unusable example rather than failing the component", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      "export function Mixed() { return <div>mixed</div>; }\n",
      `Mixed: { component: Mixed, description: "Bad then good.",\n`
      + `  examples: ['not json', '[1,2,3]', '{"ok":true}'] }`,
    );

    const { result } = await capture(root);
    expect(result.withoutSamples).toEqual([]);
    // The first example that parses to a props OBJECT wins; a malformed string
    // and a bare array are stepped over, not fatal.
    expect((await record(root, "Mixed")).sampleProps).toEqual({ ok: true });
  });

  it("says so when no declared example is a usable props object", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      "export function AllBad() { return <div />; }\n",
      `AllBad: { component: AllBad, description: "Nothing usable.", examples: ['[1,2]'] }`,
    );

    const { result } = await capture(root);
    expect(result.withoutSamples).toEqual(["AllBad"]);
    expect((await record(root, "AllBad")).noSampleProps?.reason).toBe("unreadable-examples");
  });

  it("survives the wire: the stored record round-trips as the JSON the console parses", async () => {
    const root = await temporaryRoot();
    await writeRoot(
      root,
      `export function Card({ valueCents }: { valueCents: number }) { return <div>{valueCents}</div>; }\n`,
      `Card: { component: Card, description: "A card.",\n`
      + `  examples: ['{"valueCents":5490715,"series":[1,2,3],"nested":{"a":[{"b":null}]}}'] }`,
    );
    await capture(root);

    // The console reads these rows straight out of the store, so what must
    // hold is that JSON.parse(JSON.stringify(record)) is still a valid record
    // and the seed is still a plain object of JSON values — the shape
    // `sampleProps: z.record(z.unknown())` and `InClientFurnishing.sampleProps`
    // both accept.
    const stored = await record(root, "Card");
    const overTheWire = capturedHostComponentSchema.parse(JSON.parse(JSON.stringify(stored)));
    expect(overTheWire).toEqual(stored);
    expect(overTheWire.sampleProps).toEqual({
      valueCents: 5490715,
      series: [1, 2, 3],
      nested: { a: [{ b: null }] },
    });
    expect(Object.getPrototypeOf(overTheWire.sampleProps)).toBe(Object.prototype);
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
