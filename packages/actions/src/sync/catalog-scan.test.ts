import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanComponentCatalog } from "./catalog-scan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function hostFiles(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-catalog-scan-"));
  temporaryDirectories.push(root);
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true },
    include: ["src"],
  }), "utf8");
  await fs.mkdir(path.join(root, "src"));
  for (const [name, source] of Object.entries(files)) {
    await fs.writeFile(path.join(root, "src", name), source, "utf8");
  }
  return root;
}

async function host(source: string): Promise<string> {
  return hostFiles({ "components.tsx": source });
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

  it("lets a createVendo catalog registration win, deriving its disk schema from the single zod props schema", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value, tone }: { value: number; tone?: "up" | "down" }) { return <strong>{value}{tone}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      const catalog = [{
        name: "MetricCard",
        description: "Use for one headline metric.",
        propsSchema: z.object({ value: z.number(), tone: z.enum(["up", "down"]).optional() }),
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
      propsSchema: { type: "object", properties: { value: { type: "number" }, tone: { type: "string", enum: ["up", "down"] } }, required: ["value"], additionalProperties: false },
    })]);
  });

  it("accepts the name-keyed registry form: key is the name, props derive the schema, component is ignored", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      createVendo({ catalog: {
        MetricCard: {
          component: hostComponents.MetricCard,
          description: "Use for one headline metric.",
          props: z.object({ value: z.number().describe("Value in dollars") }),
          examples: ["<MetricCard value={42} />"],
        },
      } });
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1, registered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "registered",
      description: "Use for one headline metric.",
      examples: ["<MetricCard value={42} />"],
      exportPath: "./src/components.tsx#hostComponents.MetricCard",
      propsSchema: { type: "object", properties: { value: { type: "number", description: "Value in dollars" } }, required: ["value"], additionalProperties: false },
    })]);
  });

  it("follows a catalog registry imported from another module (the shared-registry main path)", async () => {
    const root = await hostFiles({
      "registry.tsx": `
        function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
        export const registry = {
          MetricCard: {
            component: MetricCard,
            description: "Use for one headline metric.",
            props: z.object({ value: z.number().describe("Value in dollars") }),
            examples: ["<MetricCard value={42} />"],
          },
        };
        export function CatalogRoot() { return <VendoRoot components={registry} />; }
      `,
      "server.ts": `
        import { registry } from "./registry";
        createVendo({ catalog: registry });
      `,
    });

    const result = await scanComponentCatalog(root);
    expect(result.warnings).toEqual([]);
    expect(result).toMatchObject({ registered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "registered",
      description: "Use for one headline metric.",
      examples: ["<MetricCard value={42} />"],
      exportPath: "./src/registry.tsx#registry.MetricCard",
      propsSchema: { type: "object", properties: { value: { type: "number", description: "Value in dollars" } }, required: ["value"], additionalProperties: false },
    })]);
  });

  it("scans component references out of a registry object passed to VendoRoot", async () => {
    const root = await host(`
      function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
      export const registry = {
        MetricCard: { component: MetricCard, description: "Use for one headline metric." },
      };
      export function CatalogRoot() { return <VendoRoot components={registry} />; }
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      exportPath: "./src/components.tsx#registry.MetricCard",
      propsSchema: expect.objectContaining({ properties: { value: { type: "number" } } }),
    })]);
  });

  it("syncs a schema-less registration with the permissive placeholder (01 §14: schema-less entries are legal)", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      const catalog = [{
        name: "MetricCard",
        description: "Use for one headline metric.",
      }];
      createVendo({ catalog });
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1, registered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "registered",
      description: "Use for one headline metric.",
      propsSchema: {},
    })]);
  });

  it("falls back to a permissive schema with a note when a registration's zod schema is not statically interpretable", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      const catalog = [{
        name: "MetricCard",
        description: "Use for one headline metric.",
        propsSchema: makeDynamicSchema(),
      }];
      createVendo({ catalog });
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1, registered: 1 });
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "registered",
      propsSchema: {},
      note: expect.stringContaining("statically"),
    })]);
  });

  it("keeps rejecting registrations whose copy is not statically serializable", async () => {
    const root = await host(`
      type ComponentType = (props: unknown) => unknown;
      function MetricCard({ value }: { value: number }) { return <strong>{value}</strong>; }
      export const hostComponents: Record<string, ComponentType> = { MetricCard: MetricCard as ComponentType };
      export function CatalogRoot() { return <VendoRoot components={hostComponents} />; }
      const catalog = [{
        name: "MetricCard",
        description: buildDescription(),
      }];
      createVendo({ catalog });
    `);

    const result = await scanComponentCatalog(root);
    expect(result).toMatchObject({ discovered: 1, registered: 0 });
    expect(result.warnings).toContainEqual(expect.stringContaining("could not be serialized deterministically"));
    // The scanned entry stays authoritative; its schema must come from the
    // component's props type, never from the registration object literal.
    expect(result.entries).toEqual([expect.objectContaining({
      name: "MetricCard",
      source: "scanned",
      propsSchema: expect.objectContaining({ properties: { value: { type: "number" } } }),
    })]);
  });

  it("does not mistake suffix lookalikes for VendoRoot and warns for unsupported inline maps", async () => {
    const root = await host(`
      function Card({ label }: { label: string }) { return <div>{label}</div>; }
      export function Lookalike() { return <NotVendoRoot components={{ Card }} />; }
      export function InlineRoot() { return <VendoRoot components={{ Card }} />; }
    `);

    const result = await scanComponentCatalog(root);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining("inline components map"));
    expect(result.warnings).not.toContainEqual(expect.stringContaining("NotVendoRoot"));
  });
});
