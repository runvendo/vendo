import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanComponentCatalog } from "./catalog-scan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function host(source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-catalog-scan-"));
  temporaryDirectories.push(root);
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true },
    include: ["src"],
  }), "utf8");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "components.tsx"), source, "utf8");
  return root;
}

describe("deterministic component catalog scan", () => {
  it("extracts typed exported JSX components, optional props, and exported-map registrations", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      export function SimpleCard(props: { title: string; subtitle?: string; count: number; mode: "compact" | "wide" }) {
        return <article>{props.title}</article>;
      }
      function MappedBadge({ active }: { active?: boolean }) { return <span>{active}</span>; }
      export const hostComponents: Record<string, ComponentType> = {
        SimpleCard: SimpleCard as ComponentType,
        MappedBadge: MappedBadge as ComponentType,
      };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      export const UtilityValue = 42;
      export function Formatter(value: string) { return value.toUpperCase(); }
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 2, registered: 0 });
    expect(result.entries.map((entry) => entry.name)).toEqual(["MappedBadge", "SimpleCard"]);
    expect(result.entries[0]).toMatchObject({
      exportPath: "./src/components.tsx#hostComponents.MappedBadge",
      propsSchema: {
        type: "object",
        properties: { active: { type: "boolean" } },
        additionalProperties: false,
      },
      description: "",
      source: "scanned",
    });
    expect(result.entries[1]).toMatchObject({
      exportPath: "./src/components.tsx#hostComponents.SimpleCard",
      propsSchema: {
        type: "object",
        properties: {
          count: { type: "number" },
          mode: { enum: ["compact", "wide"] },
          subtitle: { type: "string" },
          title: { type: "string" },
        },
        required: ["count", "mode", "title"],
        additionalProperties: false,
      },
    });
  });

  it("fails closed to a permissive schema with an explanatory note for exotic props", async () => {
    const root = await host(`
      export function ExoticCard({ render }: { render: (value: string) => string }) {
        return <div>{render("x")}</div>;
      }
      type ComponentType = (props: unknown) => unknown;
      export const hostComponents: Record<string, ComponentType> = { ExoticCard: ExoticCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
    `);

    const [entry] = (await scanComponentCatalog(root)).entries;
    expect(entry).toMatchObject({ name: "ExoticCard", propsSchema: {} });
    expect(entry?.note).toContain("could not be represented deterministically");
    expect(entry?.note).toContain("property render");
  });

  it("lets a statically serializable createVendo catalog registration win", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value, tone }: { value: number; tone?: "up" | "down" }) { return <strong>{value}{tone}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      const toneSchema = z.enum(["up", "down"]);
      const catalog = [{
        name: "MetricCard",
        description: "Use for one headline metric.",
        propsSchema: {},
        propsJsonSchema: { type: "object", properties: { value: { type: "number" }, tone: { enum: toneSchema.options } }, required: ["value"], additionalProperties: false },
        examples: ["<MetricCard value={42} />"],
      }];
      createVendo({ catalog });
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1, registered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "registered",
      description: "Use for one headline metric.",
      examples: ["<MetricCard value={42} />"],
      exportPath: "./src/components.tsx#hostComponents.MetricCard",
      propsSchema: { type: "object", properties: { value: { type: "number" }, tone: { enum: ["up", "down"] } }, required: ["value"], additionalProperties: false },
    })]);
  });
});
