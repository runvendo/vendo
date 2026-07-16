import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturedPinBaselineSchema } from "../formats.js";
import { capturePins, scanRemixRegistrations } from "./pins.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-furnished-pin-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "src/app"), { recursive: true });
  await fs.mkdir(path.join(root, "src/components"), { recursive: true });
  await fs.mkdir(path.join(root, "src/vendo"), { recursive: true });
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("furnished pin capture", () => {
  it("captures two local-import levels, static sample props, and direct app-root CSS", async () => {
    const root = await temporaryRoot();
    const out = path.join(root, ".vendo");
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      export const components = [{
        name: "Card",
        component: Card,
        remixable: true,
        sampleProps: { title: "Captured", count: 2, flags: [true, null], href: "a\\/b" },
      }];
    `);
    await write(root, "src/components/Card.tsx", `
      import { Direct } from "./Direct";
      export function Card(props: { title: string }) { return <Direct {...props} />; }
    `);
    await write(root, "src/components/Direct.tsx", `
      import { Deep } from "./Deep";
      import { Missing } from "./Missing";
      export function Direct(props: { title: string }) { return <Deep {...props} missing={Missing} />; }
    `);
    await write(root, "src/components/Deep.tsx", `
      import { TooDeep } from "./TooDeep";
      export function Deep(props: { title: string }) { return <div>{props.title}<TooDeep /></div>; }
    `);
    await write(root, "src/components/TooDeep.tsx", "export function TooDeep() { return <span>too deep</span>; }");
    await write(root, "src/app/layout.tsx", `
      import "./globals.css";
      export default function Layout({ children }: { children: unknown }) { return children; }
    `);
    await write(root, "src/app/globals.css", ".captured { color: rgb(12, 34, 56); }\n");

    const result = await capturePins(root, out);
    const baseline = capturedPinBaselineSchema.parse(JSON.parse(
      await fs.readFile(path.join(out, "remixable/Card.json"), "utf8"),
    ));

    expect(result.captured).toEqual(["Card"]);
    expect(baseline.sourceImports).toEqual({ "./Direct": "src/components/Direct.tsx" });
    expect(Object.keys(baseline.subSources ?? {})).toEqual([
      "src/components/Deep.tsx",
      "src/components/Direct.tsx",
    ]);
    expect(baseline.subSources?.["src/components/Direct.tsx"]?.imports).toEqual({
      "./Deep": "src/components/Deep.tsx",
    });
    expect(baseline.subSources?.["src/components/Deep.tsx"]?.imports).toEqual({});
    expect(baseline.sampleProps).toEqual({ title: "Captured", count: 2, flags: [true, null], href: "a/b" });
    expect(baseline.styles).toEqual([{
      path: "src/app/globals.css",
      css: ".captured { color: rgb(12, 34, 56); }\n",
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("./Missing"),
      expect.stringContaining("./TooDeep"),
      expect.stringContaining("beyond capture depth 2"),
    ]));
  });

  it("reports a broken named re-export chain as unresolved instead of capturing the barrel", async () => {
    const root = await temporaryRoot();
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/barrel";
      export const components = [{ name: "Card", component: Card, remixable: true }];
    `);
    await write(root, "src/components/barrel/index.ts", `export { Card } from "./missing";\n`);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ slot: "Card", reason: "import-not-found" })]);
    await expect(fs.access(path.join(root, ".vendo/remixable/Card.json"))).rejects.toThrow();
  });

  it("refuses a sub-import whose realpath escapes the host root", async () => {
    const root = await temporaryRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-furnished-outside-"));
    temporaryDirectories.push(outside);
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      export const components = [{ name: "Card", component: Card, remixable: true }];
    `);
    await write(root, "src/components/Card.tsx", `
      import { Escape } from "./Escape";
      export function Card() { return <Escape />; }
    `);
    await fs.writeFile(path.join(outside, "Escape.tsx"), "export function Escape() { return null; }", "utf8");
    await fs.symlink(path.join(outside, "Escape.tsx"), path.join(root, "src/components/Escape.tsx"));

    const result = await capturePins(root, path.join(root, ".vendo"));
    const baseline = capturedPinBaselineSchema.parse(JSON.parse(
      await fs.readFile(path.join(root, ".vendo/remixable/Card.json"), "utf8"),
    ));

    expect(baseline.sourceImports).toBeUndefined();
    expect(baseline.subSources).toBeUndefined();
    // Root confinement happens inside resolveImportSource (it realpaths every
    // candidate before reading it), so the escaping symlink is reported as an
    // unresolvable import rather than being read and then rejected.
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.\/Escape.*could not be resolved/u),
    ]));
  });
});

describe("furnished pin capture on semicolon-free hosts", () => {
  it("captures a component declared after an exported interface in a semicolon-free module", async () => {
    const root = await temporaryRoot();
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      export const components = [{ name: "Card", component: Card, remixable: true }];
    `);
    // Prettier semi:false style — no statement semicolons anywhere. The
    // exported interface above the component must not swallow its export.
    await write(root, "src/components/Card.tsx",
      "\"use client\"\n" +
      "export interface CardProps {\n" +
      "  title: string\n" +
      "}\n" +
      "\n" +
      "export function Card({ title }: CardProps) {\n" +
      "  return <div>{title}</div>\n" +
      "}\n");

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.unresolved).toEqual([]);
    expect(result.captured).toEqual(["Card"]);
  });

  it("still captures root CSS declared after a type-only import in a semicolon-free layout", async () => {
    const root = await temporaryRoot();
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      export const components = [{ name: "Card", component: Card, remixable: true }];
    `);
    await write(root, "src/components/Card.tsx", "export function Card() {\n  return <div>card</div>\n}\n");
    await write(root, "src/app/layout.tsx",
      "import type { Metadata } from \"next\"\n" +
      "import \"./globals.css\"\n" +
      "\n" +
      "export default function Layout({ children }: { children: React.ReactNode }) {\n" +
      "  return <html><body>{children}</body></html>\n" +
      "}\n");
    await write(root, "src/app/globals.css", ".semifree { color: rgb(1, 2, 3); }\n");

    await capturePins(root, path.join(root, ".vendo"));
    const baseline = capturedPinBaselineSchema.parse(JSON.parse(
      await fs.readFile(path.join(root, ".vendo/remixable/Card.json"), "utf8"),
    ));

    expect(baseline.styles).toEqual([{ path: "src/app/globals.css", css: ".semifree { color: rgb(1, 2, 3); }\n" }]);
  });
});

describe("remix registration scan (the init offer surface)", () => {
  it("reports wrapped and unwrapped registrations with the literal offset", async () => {
    const root = await temporaryRoot();
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      import { Badge } from "../components/Badge";
      export const components = [
        { name: "Card", component: Card, remixable: true, exportable: true },
        { name: "Badge", component: Badge },
      ];
    `);
    await write(root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }");
    await write(root, "src/components/Badge.tsx", "export function Badge() { return <span>badge</span>; }");

    const sites = await scanRemixRegistrations(root);

    expect(sites).toEqual([
      expect.objectContaining({
        path: "src/vendo/components.ts",
        slot: "Card",
        component: "Card",
        remixable: true,
        exportable: true,
      }),
      expect.objectContaining({
        path: "src/vendo/components.ts",
        slot: "Badge",
        component: "Badge",
        remixable: false,
        exportable: false,
      }),
    ]);
    const source = await fs.readFile(path.join(root, "src/vendo/components.ts"), "utf8");
    for (const site of sites) expect(source[site.offset]).toBe("{");
    expect(source.slice(sites[1]!.offset)).toMatch(/^\{ name: "Badge"/u);
  });

  it("skips inline components, unresolvable imports, and router-style path entries", async () => {
    const root = await temporaryRoot();
    await write(root, "src/vendo/components.ts", `
      import { Card } from "../components/Card";
      import { Missing } from "../components/Missing";
      export const components = [
        { name: "InlineCard", component: () => null },
        { name: "MissingCard", component: Missing },
        { name: "UnimportedCard", component: SomethingUndeclared },
      ];
      export const routes = [
        { path: "/cards", name: "cards", component: Card },
      ];
    `);
    await write(root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }");

    expect(await scanRemixRegistrations(root)).toEqual([]);
  });
});
