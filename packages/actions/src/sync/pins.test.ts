import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturedPinBaselineSchema } from "../formats.js";
import { capturePins } from "./pins.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-wrapper-pin-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "src/app"), { recursive: true });
  await fs.mkdir(path.join(root, "src/components"), { recursive: true });
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function baselineFor(root: string, slot: string) {
  return capturedPinBaselineSchema.parse(JSON.parse(
    await fs.readFile(path.join(root, ".vendo/remixable", `${slot}.json`), "utf8"),
  ));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("wrapper pin capture", () => {
  it("captures a wrapped component with two local-import levels and direct app-root CSS", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card } from "../components/Card";
      export default function Page() {
        return <Remixable>{/* a comment renders nothing */}<Card title="Live" /></Remixable>;
      }
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

    const result = await capturePins(root, path.join(root, ".vendo"));
    const baseline = await baselineFor(root, "Card");

    expect(result.errors).toEqual([]);
    expect(result.captured).toEqual(["Card"]);
    expect(baseline.review).toBeUndefined();
    expect(baseline.exportable).toBe(false);
    expect(baseline.sampleProps).toBeUndefined();
    expect(baseline.sourceImports).toEqual({ "./Direct": "src/components/Direct.tsx" });
    expect(Object.keys(baseline.subSources ?? {})).toEqual([
      "src/components/Deep.tsx",
      "src/components/Direct.tsx",
    ]);
    expect(baseline.styles).toEqual([{
      path: "src/app/globals.css",
      css: ".captured { color: rgb(12, 34, 56); }\n",
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("./Missing"),
      expect.stringContaining("beyond capture depth 2"),
    ]));
  });

  it("names the slot after the exported identifier and folds many wrappers into one capture", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }");
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card as RenamedCard } from "../components/Card";
      export default function Page() {
        return <Remixable><RenamedCard /></Remixable>;
      }
    `);
    await write(root, "src/app/other/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card } from "../../components/Card";
      export default function Other() {
        return <Remixable><Card /></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    // The aliased call site still captures under the EXPORTED identifier, and
    // two wrappers of the same component are one capture, many mount points.
    expect(result.captured).toEqual(["Card"]);
    expect(await fs.readdir(path.join(root, ".vendo/remixable"))).toEqual(["Card.json"]);
  });

  it("registers an aliased wrapper import and errors when two components share an exported name", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }");
    await write(root, "src/components/other/Card.tsx", "export function Card() { return <div>other card</div>; }");
    await write(root, "src/app/page.tsx", `
      import { Remixable as Remix } from "../vendo/remixable";
      import { Card } from "../components/Card";
      export default function Page() {
        return <Remix><Card /></Remix>;
      }
    `);
    await write(root, "src/app/other/page.tsx", `
      import { Remixable } from "../../vendo/remixable";
      import { Card } from "../../components/other/Card";
      export default function Other() {
        return <Remixable><Card /></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    // The aliased wrapper import still registers its site, and the ambiguous
    // slot fails loudly instead of silently dropping one component's baseline.
    expect(result.captured).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringMatching(/two different components both export "Card".*rename one export/u),
    ]);
    expect(result.errors[0]).toContain("src/components/Card.tsx");
    expect(result.errors[0]).toContain("src/components/other/Card.tsx");
  });

  it("writes review: true into the baseline from <Remixable review>", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/TransferPanel.tsx", "export function TransferPanel() { return <div>transfer</div>; }");
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { TransferPanel } from "../components/TransferPanel";
      export default function Page() {
        return <Remixable review><TransferPanel /></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual(["TransferPanel"]);
    expect((await baselineFor(root, "TransferPanel")).review).toBe(true);
  });

  it("errors loudly on an inline-JSX child, naming the file and line", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      export default function Page() {
        return <Remixable><div>inline markup</div></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining("src/app/page.tsx:4"),
    ]);
    expect(result.errors[0]).toContain("extract it into a component and wrap that");
    await expect(fs.access(path.join(root, ".vendo/remixable"))).rejects.toThrow();
  });

  it("errors when the wrapper holds several children or none", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }");
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card } from "../components/Card";
      export default function Page() {
        return (
          <main>
            <Remixable><Card /><Card /></Remixable>
            <Remixable>{"text"}</Remixable>
            <Remixable />
          </main>
        );
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual([]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("must wrap exactly one component element"),
      expect.stringContaining("wraps nothing"),
    ]));
  });

  it("errors when the child is not statically imported", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      function LocalCard() { return <div>local</div>; }
      export default function Page() {
        return <Remixable><LocalCard /></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringMatching(/src\/app\/page\.tsx:5 — .*<LocalCard>.*not statically imported/u),
    ]);
  });

  it("errors on a broken named re-export chain instead of capturing the barrel", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/barrel/index.ts", `export { Card } from "./missing";\n`);
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card } from "../components/barrel";
      export default function Page() {
        return <Remixable><Card /></Remixable>;
      }
    `);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.captured).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining("does not resolve to source inside the host root"),
    ]);
    await expect(fs.access(path.join(root, ".vendo/remixable/Card.json"))).rejects.toThrow();
  });

  it("suggests <Remixable review> for a plumbing-heavy child and stays quiet once review is set", async () => {
    const root = await temporaryRoot();
    await write(root, "src/components/Plumbed.tsx", `
      import { useRouter } from "next/navigation";
      export function Plumbed({ onSelect }: { onSelect?: () => void }) {
        const router = useRouter();
        return <button onClick={() => { onSelect?.(); router.refresh(); }}>go</button>;
      }
    `);
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Plumbed } from "../components/Plumbed";
      export default function Page() {
        return <Remixable><Plumbed onSelect={() => {}} /></Remixable>;
      }
    `);

    const warned = await capturePins(root, path.join(root, ".vendo"));
    expect(warned.captured).toEqual(["Plumbed"]);
    const warning = warned.warnings.find((entry) => entry.includes("<Remixable review>"));
    expect(warning).toContain("imports next/navigation");
    expect(warning).toContain("calls useRouter()");
    expect(warning).toContain("receives the function-typed prop onSelect");

    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Plumbed } from "../components/Plumbed";
      export default function Page() {
        return <Remixable review><Plumbed onSelect={() => {}} /></Remixable>;
      }
    `);
    const reviewed = await capturePins(root, path.join(root, ".vendo"));
    expect(reviewed.warnings.filter((entry) => entry.includes("<Remixable review>"))).toEqual([]);
    expect((await baselineFor(root, "Plumbed")).review).toBe(true);
  });

  it("refuses a sub-import whose realpath escapes the host root", async () => {
    const root = await temporaryRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-wrapper-outside-"));
    temporaryDirectories.push(outside);
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "../vendo/remixable";
      import { Card } from "../components/Card";
      export default function Page() {
        return <Remixable><Card /></Remixable>;
      }
    `);
    await write(root, "src/components/Card.tsx", `
      import { Escape } from "./Escape";
      export function Card() { return <Escape />; }
    `);
    await fs.writeFile(path.join(outside, "Escape.tsx"), "export function Escape() { return null; }", "utf8");
    await fs.symlink(path.join(outside, "Escape.tsx"), path.join(root, "src/components/Escape.tsx"));

    const result = await capturePins(root, path.join(root, ".vendo"));
    const baseline = await baselineFor(root, "Card");

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

describe("wrapper pin capture on semicolon-free hosts", () => {
  it("captures a component declared after an exported interface in a semicolon-free module", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx",
      "import { Remixable } from \"../vendo/remixable\"\n" +
      "import { Card } from \"../components/Card\"\n" +
      "\n" +
      "export default function Page() {\n" +
      "  return <Remixable><Card title=\"semifree\" /></Remixable>\n" +
      "}\n");
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

    expect(result.errors).toEqual([]);
    expect(result.captured).toEqual(["Card"]);
  });
});
