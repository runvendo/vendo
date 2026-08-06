/**
 * Schema-derived TypeScript declarations for one screen — the static half of
 * the checks floor.
 *
 * The floor already knows every type a screen file can name: the Kit's props
 * are zod (`core` `kit/specs.ts`), a host component's props are the JSON Schema
 * derived once at composition (`NormalizedCatalogEntry.propsJsonSchema`), and a
 * query's result is either the tool's declared `outputSchema` or the shape
 * sampled from a live call (`ShapeType`). This module turns all of that into
 * ambient declaration text so `tsc` — the real compiler, not a bespoke walker —
 * decides whether a screen names components that exist, sets props that exist
 * with types that fit, reaches fields the data really carries, and aggregates
 * over field names the rows really have.
 *
 * Everything here is DERIVED. No hand-written component list, no hand-written
 * prop list: the component vocabulary comes from `WIRE_COMPONENT_NAMES` +
 * the catalog, and the call vocabulary from `EXPR_CALLS` / `EXPR_BUCKETS` /
 * `RESHAPE_OPS`. A vocabulary that grows in core grows here with it (and
 * {@link AGGREGATE_FIELD_ARITY} carries a drift gate so a new call cannot slip
 * through untyped).
 *
 * Pure and deterministic: same input, byte-identical output. No compiler, no
 * I/O — {@link screenTscFindings} in screen-tsc.ts is the half that runs one.
 */
import {
  EXPR_BUCKETS,
  EXPR_CALLS,
  KIT_WIRE_COMPONENT_NAMES,
  RESHAPE_OPS,
  kitSpec,
  type ExprCall,
  type JsonSchema,
  type NormalizedCatalog,
  type PropSpec,
  type ShapeType,
} from "@vendoai/core";
import { z, type ZodTypeAny } from "zod";

/** One query a screen declares: `<Query id="invoices" tool="maple_invoices_list"/>`.
 *  Structurally the floor's own `tree.queries` entry. */
export interface ScreenQueryDeclaration {
  readonly name: string;
  readonly tool: string;
}

export interface ScreenTypingsInput {
  /** The host catalog. A schema-less entry is LEGAL (01-core §14) and gets a
   *  permissive type — never an error. */
  readonly catalog: NormalizedCatalog;
  /** The screen's declared queries, in source order. */
  readonly queries: readonly ScreenQueryDeclaration[];
  /**
   * tool name → the tool's DECLARED output JSON Schema
   * (`ToolDescriptor.outputSchema`). Preferred over {@link toolShapes}: a
   * declaration is the host's contract, where a sample is one observation.
   */
  readonly toolOutputSchemas?: Readonly<Record<string, JsonSchema | undefined>>;
  /**
   * tool name → the shape derived from a live zero-arg call
   * (`runtime.ts` `sampledShapes`) — what the bespoke binding checks use, and
   * the fallback when a tool declares no output schema.
   */
  readonly toolShapes?: Readonly<Record<string, ShapeType | undefined>>;
}

/** The virtual path the declarations occupy in the check's program. */
export const SCREEN_TYPINGS_FILE = "/vendo-screen-typings.d.ts";

/**
 * How many FIELD-NAME arguments each call in the closed `$expr` vocabulary
 * takes under the explicit-field grammar (blueprint §5.2 D2/D3) — `sum(rows,
 * "amount_cents")` takes one, `count(rows)` none, and `difference` /
 * `days_until` read values rather than rows.
 *
 * The keys are pinned to `EXPR_CALLS` by a drift test: a call added to the
 * vocabulary without a typing here fails the suite instead of silently
 * type-checking as `any`.
 */
export const AGGREGATE_FIELD_ARITY: Readonly<Record<ExprCall, "rows-and-field" | "rows" | "values" | "grouped">> = {
  sum: "rows-and-field",
  average: "rows-and-field",
  min: "rows-and-field",
  max: "rows-and-field",
  count: "rows",
  difference: "values",
  days_until: "values",
  group_by: "grouped",
};

// ---- zod → TS type text ---------------------------------------------------

/** The Kit's zod vocabulary is closed — it is our own schema file — so a
 *  direct walker beats a converter dependency (see the module note in the PR).
 *  Anything outside the vocabulary degrades to `any`: a prop we cannot type
 *  precisely must never become a false positive. */
const zodTypeText = (schema: ZodTypeAny, depth = 0): string => {
  if (depth > 8) return "any";
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber: return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean: return "boolean";
    case z.ZodFirstPartyTypeKind.ZodNull: return "null";
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (def as { values: readonly string[] }).values.map((value) => JSON.stringify(value)).join(" | ");
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return JSON.stringify((def as { value: unknown }).value);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return `Array<${zodTypeText((def as { type: ZodTypeAny }).type, depth + 1)}>`;
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return (def as { options: readonly ZodTypeAny[] }).options.map((option) => zodTypeText(option, depth + 1)).join(" | ");
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return `Record<string, ${zodTypeText((def as { valueType: ZodTypeAny }).valueType, depth + 1)}>`;
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const fields = Object.entries(shape).map(([name, field]) => {
        const inner = (field as unknown as { _def: { typeName?: string; innerType?: ZodTypeAny } })._def;
        const optional = inner.typeName === z.ZodFirstPartyTypeKind.ZodOptional;
        return `${name}${optional ? "?" : ""}: ${zodTypeText(optional ? inner.innerType as ZodTypeAny : field, depth + 1)}`;
      });
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return zodTypeText((def as { innerType: ZodTypeAny }).innerType, depth + 1);
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return `${zodTypeText((def as { innerType: ZodTypeAny }).innerType, depth + 1)} | null`;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return zodTypeText((def as { schema: ZodTypeAny }).schema, depth + 1);
    default:
      return "any";
  }
};

// ---- JSON Schema → TS type text ------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Two readings of the same JSON Schema, because the two consumers differ:
 *
 * - `props` — a component's props. `additionalProperties: false` is the
 *   schema's own statement that no other prop is read, so the object closes;
 *   anything else stays open, and an unmodelled prop is never a false positive.
 * - `result` — a tool's response. Always closed, whatever the schema says: a
 *   response schema that lists its properties IS the field contract, and the
 *   bespoke binding check reads a shape's field set as closed too
 *   (`walkShapePointer` misses on an absent field). Left open, every
 *   field-existence error would silently resolve to `any`.
 */
type SchemaReading = "props" | "result";

/** Host component props and declared tool outputs are JSON Schema (derived
 *  once at composition — `packages/vendo/src/catalog.ts`). Unknown constructs
 *  degrade to `any`, never to an error. */
const jsonSchemaTypeText = (schema: unknown, reading: SchemaReading, depth = 0): string => {
  if (depth > 8 || !isRecord(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.map((branch) => jsonSchemaTypeText(branch, reading, depth + 1)).join(" | ");
    }
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return `Array<${jsonSchemaTypeText(schema.items, reading, depth + 1)}>`;
  if (type === "object" || isRecord(schema.properties)) return objectTypeText(schema, reading, depth);
  return "any";
};

const objectTypeText = (schema: Record<string, unknown>, reading: SchemaReading, depth: number): string => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const fields = Object.entries(properties).map(([name, field]) =>
    `${name}${required.has(name) ? "" : "?"}: ${jsonSchemaTypeText(field, reading, depth + 1)}`);
  const open = reading === "props" && schema.additionalProperties !== false;
  if (open) fields.push("[prop: string]: any");
  return fields.length === 0 ? "{ [prop: string]: any }" : `{ ${fields.join("; ")} }`;
};

// ---- ShapeType → TS type text --------------------------------------------

/** The closed 7-kind union (`core` `shape.ts`). `json` — the spec's unknown
 *  type — becomes `any`, so an unknown region stays silent rather than
 *  refusing every binding through it. */
const shapeTypeText = (shape: ShapeType, depth = 0): string => {
  if (depth > 12) return "any";
  if (shape.kind === "json") return "any";
  if (shape.kind === "null") return "null";
  if (shape.kind === "array") return `Array<${shapeTypeText(shape.items, depth + 1)}>`;
  if (shape.kind === "object") {
    const optional = new Set(shape.optional ?? []);
    const fields = Object.entries(shape.fields).map(([name, field]) =>
      `${name}${optional.has(name) ? "?" : ""}: ${shapeTypeText(field, depth + 1)}`);
    return fields.length === 0 ? "{ [field: string]: any }" : `{ ${fields.join("; ")} }`;
  }
  return shape.kind;
};

// ---- the declaration text -------------------------------------------------

/** Every component gets these: `children` because the wire nests nodes, and
 *  `pending` because the plan skeleton writes it on every leaf and a section
 *  whose fill honestly failed keeps it (facts.ts `prewiredPropsIssues`). */
const AMBIENT_PROPS = "children?: any; pending?: any";

const componentDeclaration = (name: string, propsText: string): string =>
  `declare const ${name}: (props: ${propsText}) => JSX.Element;`;

/**
 * A binding `printWire` could not write as a dotted reference, so it printed as a
 * quoted object literal instead: a numeric-index path (`records.0.summary`), a
 * stored aggregate reshape, an `$expr` whose source no longer parses — print.ts's
 * "totality over fidelity" fallback.
 *
 * `facts.ts` already names this the subsumption's edge: tsc cannot walk such a
 * literal, so it carries NO type information, and rejecting it is a false finding
 * — the renderer resolves the real value at render time. Admitting it costs the
 * check nothing it was buying, because a binding the wire CAN write prints as a
 * real member expression and stays fully typed against the query result types.
 *
 * This only became load-bearing when V4 retired the legacy prewired components:
 * their permissive `any` props used to absorb these literals wherever a stored
 * screen carried one, so no typed prop ever met one.
 */
const BINDING_TYPE = "VendoBinding";
const BINDING_DECLARATION =
  `declare type ${BINDING_TYPE} = { $path: string } | { $state: string } | { $expr: string };`;

const propsTextFrom = (props: Record<string, PropSpec>): string => {
  const fields = Object.entries(props).map(([name, spec]) =>
    `${name}${spec.required === true ? "" : "?"}: ${zodTypeText(spec.schema)} | ${BINDING_TYPE}`);
  return `{ ${[...fields, AMBIENT_PROPS].join("; ")} }`;
};

/** The frame elements a screen file is made of. Not components: the compiler
 *  reads them as structure, so they take their own attributes and no props
 *  schema exists for them. */
const FRAME_DECLARATIONS = [
  componentDeclaration("App", `{ name: string; ${AMBIENT_PROPS} }`),
  componentDeclaration("Query", `{ id: string; tool: string; input?: any; ${AMBIENT_PROPS} }`),
];

const aggregateDeclarations = (): string[] => {
  const buckets = EXPR_BUCKETS.map((bucket) => JSON.stringify(bucket)).join(" | ");
  // The bucket union is INLINED rather than aliased: a finding quotes the
  // parameter type the compiler resolved, and an alias name teaches a model
  // nothing where `"day" | "month" | "year"` teaches it the answer.
  const lines = ["interface VendoAggregate<Field extends string> { readonly __aggregatesField: Field }"];
  for (const call of EXPR_CALLS) {
    const kind = AGGREGATE_FIELD_ARITY[call];
    if (kind === "rows-and-field") {
      // `keyof Row & string` is what turns a wrong field name into a type
      // error, generically, for every query shape — no per-query overload.
      lines.push(`declare const ${call}: {`
        + " <Row>(rows: readonly Row[], field: keyof Row & string): number;"
        + " of<Field extends string>(field?: Field): VendoAggregate<Field>;"
        + " };");
    } else if (kind === "rows") {
      lines.push(`declare const ${call}: {`
        + " (rows: readonly unknown[]): number;"
        + " of<Field extends string>(field?: Field): VendoAggregate<Field>;"
        + " };");
    } else if (kind === "values") {
      lines.push(`declare const ${call}: (...values: any[]) => number;`);
    } else {
      lines.push(`declare const ${call}: <Row, Field extends keyof Row & string>(`
        + `rows: readonly Row[], field: keyof Row & string, bucket: ${buckets},`
        + " aggregate: VendoAggregate<Field>"
        + ") => Array<{ bucket: string; value: number }>;");
    }
  }
  return lines;
};

/** The reshape ops that survive the pipe → nested-call collapse: the registry
 *  minus the names the `$expr` vocabulary already owns (blueprint §5.2 — the
 *  two vocabularies become one call grammar, the `$expr` names win) minus
 *  `avg`, which retires with the pipe. Their argument grammar under the new
 *  dialect is the dialect track's to settle, so they are declared by NAME with
 *  permissive arguments: an undeclared op is caught, a mis-shaped call is not. */
const reshapeDeclarations = (): string[] => {
  const owned = new Set<string>([...EXPR_CALLS, "avg"]);
  return RESHAPE_OPS.filter((op) => !owned.has(op))
    .map((op) => `declare const ${op}: (...args: any[]) => any;`);
};

const queryTypeText = (query: ScreenQueryDeclaration, input: ScreenTypingsInput): string => {
  const declared = input.toolOutputSchemas?.[query.tool];
  if (declared !== undefined) return jsonSchemaTypeText(declared, "result");
  const sampled = input.toolShapes?.[query.tool];
  // Neither a declaration nor a successful sample: permissive, so an
  // unsampled tool never turns every binding through it into an error.
  return sampled === undefined ? "any" : shapeTypeText(sampled);
};

/**
 * The ambient declarations for one screen. A global script (no import, no
 * export) so the screen file needs no module envelope — blueprint §5.2 D6
 * keeps the wire envelope-free.
 */
export function screenTypings(input: ScreenTypingsInput): string {
  const declared = new Set<string>();
  const lines: string[] = [
    "// GENERATED by @vendoai/apps screenTypings — do not edit.",
    "declare namespace JSX {",
    "  interface Element {}",
    "  interface ElementChildrenAttribute { children: {} }",
    "  interface IntrinsicElements { [element: string]: any }",
    "}",
    BINDING_DECLARATION,
  ];

  const push = (name: string, propsText: string): void => {
    if (declared.has(name)) return;
    declared.add(name);
    lines.push(componentDeclaration(name, propsText));
  };

  // The Kit first: a built-in shadows a host component of the same name,
  // because the renderer resolves a built-in name before it looks at the
  // catalog (facts.ts `catalogIssues`). V4: the Kit specs are the only source.
  for (const name of KIT_WIRE_COMPONENT_NAMES) {
    const spec = kitSpec(name);
    if (spec !== undefined) push(name, propsTextFrom(spec.props));
  }
  for (const entry of input.catalog) {
    push(entry.name, entry.propsJsonSchema === undefined
      ? `{ [prop: string]: any; ${AMBIENT_PROPS} }`
      : objectTypeText({
        ...entry.propsJsonSchema,
        properties: {
          ...(isRecord(entry.propsJsonSchema.properties) ? entry.propsJsonSchema.properties : {}),
          children: {},
          pending: {},
        },
      }, "props", 0));
  }

  lines.push(...FRAME_DECLARATIONS.filter((line) => {
    const name = /declare const (\w+):/u.exec(line)?.[1] ?? "";
    return declared.has(name) ? false : (declared.add(name), true);
  }));

  for (const query of input.queries) {
    lines.push(`declare const ${query.name}: ${queryTypeText(query, input)};`);
  }

  lines.push(...aggregateDeclarations(), ...reshapeDeclarations());
  // `$state` is a live binding kind (core `isStateBinding`) whose values are
  // written at runtime. The dialect settled (#808) that it is EXACTLY one
  // segment — `state.<key>`, never `state.<key>.<deeper>`, no aggregates on it,
  // none inside `$expr`.
  //
  // `never` is the shim that enforces exactly that, and nothing more: a
  // single-segment read binds into ANY prop (the renderer resolves the real
  // value at render, so the gate must not guess its type), while `state.k.deep`
  // is an error because `never` has no members — the renderer would silently
  // drop the deeper access, so the screen must not name it. This was
  // `Record<string, unknown>` until V4: `unknown` banned the deeper access the
  // same way, but it ALSO refused every typed prop, which only went unnoticed
  // while the legacy prewired components' permissive `any` props existed to
  // absorb state bindings. Retiring them made that hole load-bearing.
  lines.push("declare const state: Record<string, never>;");
  return `${lines.join("\n")}\n`;
}
