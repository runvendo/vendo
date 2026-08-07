import { catalogEntrySchema } from "@vendoai/actions";
import { parseModule, zodFromExpression, type StaticExtraction } from "@vendoai/actions/sync";
import { SAFE_COMPONENT_NAME, VendoError } from "@vendoai/core";
import type { ComponentCatalog, ComponentRegistry, NormalizedCatalog } from "@vendoai/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mergeRuntimeCatalog, normalizeCatalogConfig, runtimeCatalogFromFile, runtimeCatalogFromJson } from "./catalog.js";

const validateResult = async (
  entry: NormalizedCatalog[number] | undefined,
  props: unknown,
): Promise<unknown> => Promise.resolve(entry?.propsSchema?.["~standard"].validate(props));

describe("catalog@1 runtime mapping", () => {
  it("maps disk JSON schemas for prompting AND enforces them at validation (04 §1 gap closure)", async () => {
    const catalog = runtimeCatalogFromJson(JSON.stringify({
      format: "vendo/catalog@1",
      entries: [
        {
          name: "MetricCard",
          exportPath: "./src/metric.tsx#MetricCard",
          propsSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
          description: "Use for one headline metric.",
          examples: ["<MetricCard value={42} />"],
          source: "scanned",
        },
        {
          name: "HiddenCard",
          exportPath: "./src/hidden.tsx#HiddenCard",
          propsSchema: {},
          description: "Hidden",
          source: "scanned",
          disabled: true,
        },
      ],
    }));

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      name: "MetricCard",
      description: "Use for one headline metric.",
      propsJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      examples: ["<MetricCard value={42} />"],
    });
    // Valid props pass.
    expect(await validateResult(catalog[0], { value: 42 })).toMatchObject({ value: { value: 42 } });
    // The disk JSON Schema is executable: invalid props produce issues, not a pass-through.
    const invalid = await validateResult(catalog[0], { value: "not a number" }) as { issues?: unknown[] };
    expect(invalid.issues).toBeDefined();
    expect(invalid.issues!.length).toBeGreaterThan(0);
    const missing = await validateResult(catalog[0], {}) as { issues?: unknown[] };
    expect(missing.issues).toBeDefined();
    // Permissive-placeholder entries stay permissive by design.
    expect(await validateResult(catalog[1], { anything: true })).toMatchObject({ value: { anything: true } });
    expect(catalog[1]?.name).toBe("HiddenCard");
  });

  it("lets explicit registrations win and rejects unknown catalog fields", () => {
    const disk = runtimeCatalogFromJson(JSON.stringify({
      format: "vendo/catalog@1",
      entries: [{ name: "MetricCard", exportPath: "./metric#MetricCard", propsSchema: {}, description: "disk", source: "scanned" }],
    }));
    const explicit = normalizeCatalogConfig([{
      name: "MetricCard",
      description: "explicit",
      propsSchema: { "~standard": { validate: (value: unknown) => ({ value }) } },
    }]);
    expect(mergeRuntimeCatalog(disk, explicit)).toEqual(explicit);
  });

  it("drops only the entry whose name the /host projection cannot carry, and keeps the rest", () => {
    // `catalogFileSchema` already rejects a hyphen, but its pattern is
    // `[A-Z][A-Za-z0-9_$]*` — LOOSER than core's in two ways: `$` is legal in it,
    // and there is no length cap. Such a name parses, so a THROW here lands inside
    // `runtimeCatalogFromJson`'s catch, which logs and returns `[]` — one bad
    // component erasing every good one and booting the host with nothing, while
    // advising a `vendo sync` that regenerates the very same file. The document is
    // machine-written; the entry is what is wrong with it, so the entry is what is
    // dropped.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const entry = (name: string) =>
      ({ name, exportPath: `./x#${name}`, propsSchema: {}, description: "D.", source: "scanned" });

    const catalog = runtimeCatalogFromJson(
      JSON.stringify({ format: "vendo/catalog@1", entries: [entry("MetricCard"), entry("Card$Legacy")] }),
      ".vendo/catalog.json",
    );
    expect(catalog.map((loaded) => loaded.name)).toEqual(["MetricCard"]);
    // A dropped entry is a WARNING, never the whole-document error: the host booted.
    expect(error).not.toHaveBeenCalled();

    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(".vendo/catalog.json");
    expect(line).toContain("Card$Legacy");
    expect(line).toContain("letters, digits and \"_\"");
    // Actionable, and it says what happened to everything else.
    expect(line).toContain("the rest of the catalog loads");
    warn.mockRestore();
    error.mockRestore();
  });

  it("degrades the in-memory profile leg the same way, and names the source it was given", () => {
    // `config.profile.catalog` is handed to `runtimeCatalogFromFile` directly, with
    // no swallow in front of it — so this leg used to be the one that took the host
    // down at boot, and (before V13b) blamed a file it had never read. Both legs
    // carry machine-written entries, so both degrade per entry; the difference is
    // only which origin the warning names.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = (...names: string[]) => ({
      format: "vendo/catalog@1",
      entries: names.map((name) => ({ name, exportPath: `./x#${name}`, propsSchema: {}, description: "D.", source: "scanned" })),
    } as never);

    // 65 characters: one past core's cap, which the file schema does not have.
    const catalog = runtimeCatalogFromFile(
      file("Card$Legacy", "MetricCard", `C${"a".repeat(64)}`),
      "createVendo({ profile: { catalog } })",
    );
    expect(catalog.map((loaded) => loaded.name)).toEqual(["MetricCard"]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).toContain("createVendo({ profile: { catalog } })");
      expect(String(call[0])).not.toContain(".vendo/catalog.json");
    }

    warn.mockClear();
    expect(runtimeCatalogFromFile(file("MetricCard"))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("nothing `vendo sync` is able to write can erase the catalog", () => {
    // The two grammars disagree, and this is the disagreement DERIVED rather than
    // restated: names the catalog@1 schema accepts (so sync can emit them, and a
    // host may already have one on disk) that core's projection refuses. If
    // `catalogEntrySchema` is ever tightened to core's grammar the set empties and
    // this passes vacuously — by then the concrete case above is the live guard.
    const entry = (name: string) =>
      ({ name, exportPath: `./x#${name}`, propsSchema: {}, description: "D.", source: "scanned" });
    const writableButUnprojectable = ["Card$Legacy", `C${"a".repeat(64)}`, "$", "A$"]
      .filter((name) => catalogEntrySchema.safeParse(entry(name)).success && !SAFE_COMPONENT_NAME.test(name));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const name of writableButUnprojectable) {
      const catalog = runtimeCatalogFromFile(
        { format: "vendo/catalog@1", entries: [entry(name), entry("MetricCard")] } as never,
      );
      expect(catalog.map((loaded) => loaded.name), `${name} must not take MetricCard with it`).toEqual(["MetricCard"]);
    }
    warn.mockRestore();
  });

  it("warns loudly and actionably when strict catalog parsing fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runtimeCatalogFromJson(
      JSON.stringify({ format: "vendo/catalog@1", entries: [], typo: true }),
      ".vendo/catalog.json",
    )).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(".vendo/catalog.json");
    expect(error.mock.calls[0]?.[0]).toContain("Unrecognized key");
    expect(error.mock.calls[0]?.[0]).toContain("vendo sync");
  });
});

describe("normalizeCatalogConfig (01 §14 registry form + derivation)", () => {
  it("normalizes the name-keyed registry: key → name, props → propsSchema, component dropped", () => {
    const registry: ComponentRegistry = {
      MetricCard: {
        component: () => { throw new Error("the server must never touch component references"); },
        description: "Use for one headline metric.",
        props: z.object({ value: z.number() }),
        examples: ["<MetricCard value={42} />"],
      },
    };
    const catalog = normalizeCatalogConfig(registry);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: "MetricCard",
      description: "Use for one headline metric.",
      examples: ["<MetricCard value={42} />"],
    });
    expect(catalog[0]).not.toHaveProperty("component");
    expect(catalog[0]).not.toHaveProperty("props");
    expect(catalog[0]?.propsSchema).toBeDefined();
  });

  it("derives JSON Schema from a zod props schema once, at normalization time", async () => {
    const catalog = normalizeCatalogConfig({
      SpendingDonut: {
        component: null,
        description: "Spending by category.",
        props: z.object({
          slices: z.array(z.object({
            category: z.enum(["dining", "groceries"]),
            amount: z.number().describe("Amount in dollars"),
          })),
          size: z.number().optional(),
        }),
      },
    });
    const schema = catalog[0]?.propsJsonSchema as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema).toMatchObject({
      type: "object",
      required: ["slices"],
      properties: {
        slices: {
          type: "array",
          items: {
            type: "object",
            required: ["category", "amount"],
            properties: {
              category: { enum: ["dining", "groceries"] },
              amount: { type: "number", description: "Amount in dollars" },
            },
          },
        },
        size: { type: "number" },
      },
    });
    expect(schema).not.toHaveProperty("$schema");
    // The zod schema stays the runtime validator.
    const invalid = await validateResult(catalog[0], { slices: [{ category: "nope", amount: 1 }] }) as { issues?: unknown[] };
    expect(invalid.issues?.length).toBeGreaterThan(0);
  });

  it("derives for the array form too, and keeps the array form valid", () => {
    const explicit: ComponentCatalog = [{
      name: "Sparkline",
      description: "A compact trend.",
      propsSchema: z.object({ data: z.array(z.number()) }),
    }];
    const catalog = normalizeCatalogConfig(explicit);
    expect(catalog[0]?.name).toBe("Sparkline");
    expect(catalog[0]?.propsJsonSchema).toMatchObject({
      type: "object",
      required: ["data"],
      properties: { data: { type: "array", items: { type: "number" } } },
    });
  });

  it("does not derive for non-zod standard schemas: runtime validation only, description-only prompt", () => {
    const validate = (value: unknown): unknown => ({ value });
    const catalog = normalizeCatalogConfig([{
      name: "CustomCard",
      description: "Custom-validated.",
      propsSchema: { "~standard": { validate } },
    }]);
    expect(catalog[0]?.propsJsonSchema).toBeUndefined();
    expect(catalog[0]?.propsSchema?.["~standard"].validate).toBe(validate);
  });

  it("accepts schema-less entries (name + description only) in both forms", () => {
    const fromRegistry = normalizeCatalogConfig({
      PlainCard: { component: null, description: "The model infers props." },
    });
    expect(fromRegistry[0]).toMatchObject({ name: "PlainCard", description: "The model infers props." });
    expect(fromRegistry[0]?.propsSchema).toBeUndefined();
    expect(fromRegistry[0]?.propsJsonSchema).toBeUndefined();

    const fromArray = normalizeCatalogConfig([{ name: "PlainCard", description: "The model infers props." }]);
    expect(fromArray[0]?.propsSchema).toBeUndefined();
    expect(fromArray[0]?.propsJsonSchema).toBeUndefined();
  });

  it("returns an empty catalog for undefined config", () => {
    expect(normalizeCatalogConfig(undefined)).toEqual([]);
  });

  describe("a name the /host projection cannot carry fails at BOOT, not on every turn", () => {
    // `hostComponentFiles` builds `/host/components/<Name>.md` through core's
    // `componentPath`, per TURN. So a name core rejects used to normalize fine,
    // boot green, and throw for the whole life of the deployment — once per turn.
    // Same defect the composition merge closes for a contributed name; this is the HOST
    // half of it, and both ends call the same builder so they cannot drift.
    for (const name of ["Data-Table", "9Lives", "Data Table", "../x", "data.table"]) {
      it(`rejects the registered name ${JSON.stringify(name)}`, () => {
        expect(() => normalizeCatalogConfig([{ name, description: "D." }])).toThrow(VendoError);
        expect(() => normalizeCatalogConfig({ [name]: { component: null, description: "D." } }))
          .toThrow(VendoError);
      });
    }

    it("names the source and the entry, and gives core's own reason", () => {
      const attempt = (): unknown => normalizeCatalogConfig([{ name: "Data-Table", description: "D." }]);
      expect(attempt).toThrow(/createVendo\(\{ catalog \}\)/);
      expect(attempt).toThrow(/Data-Table/);
      expect(attempt).toThrow(/letters, digits and "_"/);
    });

    it("still accepts the names real hosts register", () => {
      expect(() => normalizeCatalogConfig([
        { name: "MetricCard", description: "D." },
        { name: "Chart2", description: "D." },
        { name: "spending_donut", description: "D." },
      ])).not.toThrow();
    });
  });

  it("derives the SAME JSON Schema statically (sync/disk) and at runtime (live registration)", async () => {
    // Behaviorally load-bearing parity: sync's static interpretation of the
    // registration source feeds the ajv-compiled DISK validator, while the
    // runtime derivation from the live zod object feeds prompt + validation
    // for explicit registrations. The two paths already drifted once
    // (.describe() was dropped statically) — pin them together on one
    // representative schema: nested object/array, enum, .optional(),
    // .default(), .describe().
    const schemaSource = `const schema = z.object({
      slices: z.array(z.object({
        category: z.enum(["dining", "groceries"]),
        amount: z.number().describe("Amount in dollars"),
      })),
      size: z.number().optional(),
      mode: z.enum(["compact", "wide"]).default("compact"),
    });`;
    const liveSchema = z.object({
      slices: z.array(z.object({
        category: z.enum(["dining", "groceries"]),
        amount: z.number().describe("Amount in dollars"),
      })),
      size: z.number().optional(),
      mode: z.enum(["compact", "wide"]).default("compact"),
    });

    const extraction: StaticExtraction = { ts, root: "/virtual", modules: new Map() };
    const module = parseModule(extraction, "/virtual/schema.ts", schemaSource);
    const statement = module.sf.statements[0];
    if (statement === undefined || !ts.isVariableStatement(statement)) throw new Error("fixture must be a variable statement");
    const initializer = statement.declarationList.declarations[0]?.initializer;
    if (initializer === undefined) throw new Error("fixture must have an initializer");
    const statically = await zodFromExpression(extraction, module, initializer, 0);
    expect(statically.recognized).toBe(true);
    expect(statically.reason).toBeUndefined();

    const runtime = normalizeCatalogConfig([{
      name: "ParityCard",
      description: "Parity fixture.",
      propsSchema: liveSchema,
    }])[0]?.propsJsonSchema;

    expect(runtime).toEqual(statically.schema);
  });
});
