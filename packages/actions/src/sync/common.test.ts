import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importReferenceFor, resolveImportSource } from "./common.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-common-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

describe("importReferenceFor", () => {
  it("resolves named, aliased, default, and namespace-member references", async () => {
    const source = [
      `import Widget from "./widget";`,
      `import { Card, Badge as LocalBadge } from "./cards";`,
      `import * as UI from "./ui";`,
      `export const registered = [Widget, Card, LocalBadge, UI.Panel];`,
    ].join("\n");

    expect(await importReferenceFor(source, "Widget")).toEqual({ specifier: "./widget", imported: "default" });
    expect(await importReferenceFor(source, "Card")).toEqual({ specifier: "./cards", imported: "Card" });
    expect(await importReferenceFor(source, "LocalBadge")).toEqual({ specifier: "./cards", imported: "Badge" });
    expect(await importReferenceFor(source, "UI.Panel")).toEqual({ specifier: "./ui", imported: "Panel" });
    expect(await importReferenceFor(source, "Undeclared")).toBeUndefined();
    // A namespace member on a plainly-imported name is not a reference.
    expect(await importReferenceFor(source, "Card.Section")).toBeUndefined();
  });

  it("reads references out of a semicolon-free TSX module", async () => {
    const source = [
      `"use client"`,
      `import { Card } from "./cards"`,
      ``,
      `export interface Props {`,
      `  title: string`,
      `}`,
      ``,
      `export function Wrapper({ title }: Props) {`,
      `  return <Card title={title} />`,
      `}`,
    ].join("\n");

    expect(await importReferenceFor(source, "Card")).toEqual({ specifier: "./cards", imported: "Card" });
  });
});

describe("resolveImportSource", () => {
  it("follows export-star chains to the owning module", async () => {
    const root = await temporaryRoot();
    await write(root, "src/entry.ts", `import { Card } from "./barrel";`);
    await write(root, "src/barrel/index.ts", `export * from "./cards";\n`);
    await write(root, "src/barrel/cards.tsx", `export function Card() { return <div>card</div>; }\n`);

    const resolved = await resolveImportSource(path.join(root, "src/entry.ts"), "./barrel", root, "Card");
    expect(resolved?.file).toBe(await fs.realpath(path.join(root, "src/barrel/cards.tsx")));
  });

  it("follows aliased named re-exports through a barrel", async () => {
    const root = await temporaryRoot();
    await write(root, "src/entry.ts", `import { PublicCard } from "./barrel";`);
    await write(root, "src/barrel/index.ts", `export { InnerCard as PublicCard } from "./cards";\n`);
    await write(root, "src/barrel/cards.tsx", `export const InnerCard = () => <div>card</div>;\n`);

    const resolved = await resolveImportSource(path.join(root, "src/entry.ts"), "./barrel", root, "PublicCard");
    expect(resolved?.file).toBe(await fs.realpath(path.join(root, "src/barrel/cards.tsx")));
  });

  it("returns null when a named re-export chain dead-ends", async () => {
    const root = await temporaryRoot();
    await write(root, "src/entry.ts", `import { Card } from "./barrel";`);
    await write(root, "src/barrel/index.ts", `export { Card } from "./missing";\n`);

    expect(await resolveImportSource(path.join(root, "src/entry.ts"), "./barrel", root, "Card")).toBeNull();
  });

  it("finds a direct export declared after an exported interface in semicolon-free TSX", async () => {
    const root = await temporaryRoot();
    await write(root, "src/entry.ts", `import { Card } from "./Card";`);
    await write(
      root,
      "src/Card.tsx",
      `"use client"\nexport interface CardProps {\n  title: string\n}\n\nexport function Card({ title }: CardProps) {\n  return <div>{title}</div>\n}\n`,
    );

    const resolved = await resolveImportSource(path.join(root, "src/entry.ts"), "./Card", root, "Card");
    expect(resolved?.file).toBe(await fs.realpath(path.join(root, "src/Card.tsx")));
  });
});
