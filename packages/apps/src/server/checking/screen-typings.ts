/**
 * Schema-derived TypeScript declarations for one screen — the static half of
 * the checks floor.
 *
 * The floor already knows every type a screen file can name: the Kit's props
 * are zod (`core` `kit/specs.ts`), a host component's props are the JSON Schema
 * derived once at composition (`NormalizedCatalogEntry.propsJsonSchema`), and a
 * query's result is the tool's declared `outputSchema`. This module turns all
 * of that into ambient declaration text so `tsc` — the real compiler, not a
 * bespoke walker — decides whether a screen names components that exist, sets
 * props that exist with types that fit, reaches fields the data really carries,
 * and aggregates over field names the rows really have.
 *
 * Everything here is DERIVED. No hand-written component list, no hand-written
 * prop list: the component vocabulary comes from `WIRE_COMPONENT_NAMES` + the
 * catalog. There is no CALL vocabulary to declare any more — a `{...}` gap is a
 * JavaScript expression, so `invoices.data.reduce((t, r) => t + r.amount, 0)`
 * type-checks against the query's own declared result type with nothing
 * ambient in the way. The old `sum`/`count`/`group_by`/`pick` declarations
 * existed only to give tsc a shape for a closed dialect that no longer exists;
 * shipping them now would type-check calls the renderer cannot evaluate.
 *
 * Pure and deterministic: same input, byte-identical output. No compiler, no
 * I/O — {@link screenTscFindings} in screen-tsc.ts is the half that runs one.
 */
import {
  type JsonSchema,
} from "@vendoai/core";
import {
  KIT_WIRE_COMPONENT_NAMES,
  kitSpec,
  type NormalizedCatalog,
  type PropSpec,
} from "../../contract/index.js";
// The screen engine, by its own path — the same door component-screen.ts takes.
import { SCREEN_ACTION_COMPONENT } from "../../contract/genui/component/index.js";
import { z, type ZodTypeAny } from "zod";
import { isMutatingTool, type HostToolInfo } from "./deps.js";

/**
 * Where a construct neither printer can model is announced.
 *
 * Both printers degrade an unknown construct to `any` — never to an error,
 * because a prop we cannot type precisely must not become a false finding. The
 * cost is invisible: the gate quietly stops checking that prop. A caller that
 * passes a sink learns which ones went dark; one that passes nothing keeps the
 * old silence.
 */
export type TypeNote = (reason: string) => void;

/** The same sink, with the locus of the thing being printed folded in. */
const at = (note: TypeNote | undefined, where: string): TypeNote | undefined =>
  note === undefined ? undefined : (reason) => note(`${where}: ${reason}`);

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
   * (`ToolDescriptor.outputSchema`). The only source: a declaration is the
   * host's contract, and nothing samples the host anymore.
   */
  readonly toolOutputSchemas?: Readonly<Record<string, JsonSchema | undefined>>;
}

/** The virtual path the declarations occupy in the check's program. */
export const SCREEN_TYPINGS_FILE = "/vendo-screen-typings.d.ts";

// ---- zod → TS type text ---------------------------------------------------

/** The Kit's zod vocabulary is closed — it is our own schema file — so a
 *  direct walker beats a converter dependency (see the module note in the PR).
 *  Anything outside the vocabulary degrades to `any`: a prop we cannot type
 *  precisely must never become a false positive. */
const zodTypeText = (schema: ZodTypeAny, depth = 0, note?: TypeNote): string => {
  if (depth > 8) {
    note?.("the schema nests deeper than 8 levels — typed as any below that");
    return "any";
  }
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber: return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean: return "boolean";
    case z.ZodFirstPartyTypeKind.ZodNull: return "null";
    // `any` is these two's FAITHFUL type, not a degradation — no note.
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny: return "any";
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (def as { values: readonly string[] }).values.map((value) => JSON.stringify(value)).join(" | ");
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return JSON.stringify((def as { value: unknown }).value);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return `Array<${zodTypeText((def as { type: ZodTypeAny }).type, depth + 1, note)}>`;
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return (def as { options: readonly ZodTypeAny[] }).options.map((option) => zodTypeText(option, depth + 1, note)).join(" | ");
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return `Record<string, ${zodTypeText((def as { valueType: ZodTypeAny }).valueType, depth + 1, note)}>`;
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const fields = Object.entries(shape).map(([name, field]) => {
        const inner = (field as unknown as { _def: { typeName?: string; innerType?: ZodTypeAny } })._def;
        const optional = inner.typeName === z.ZodFirstPartyTypeKind.ZodOptional;
        return `${name}${optional ? "?" : ""}: ${zodTypeText(optional ? inner.innerType as ZodTypeAny : field, depth + 1, at(note, name))}`;
      });
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return zodTypeText((def as { innerType: ZodTypeAny }).innerType, depth + 1, note);
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return `${zodTypeText((def as { innerType: ZodTypeAny }).innerType, depth + 1, note)} | null`;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return zodTypeText((def as { schema: ZodTypeAny }).schema, depth + 1, note);
    default:
      note?.(`zod ${def.typeName ?? "construct"} is not in the printer's vocabulary — typed as any`);
      return "any";
  }
};

// ---- JSON Schema → TS type text ------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Does this schema DESCRIBE a value, or does it only constrain one? Mirrors
 *  core `shape.ts`'s `VALUE_KEYWORDS` — the two floors walk schemas separately
 *  by design, but they must agree on which branches of an `allOf` carry shape. */
const describesAValue = (schema: unknown): boolean =>
  isRecord(schema)
  && ["type", "properties", "items", "enum", "const", "allOf", "anyOf", "oneOf", "not", "$ref"].some((key) => key in schema);

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
const jsonSchemaTypeText = (schema: unknown, reading: SchemaReading, depth = 0, note?: TypeNote): string => {
  if (depth > 8 || !isRecord(schema)) {
    note?.(depth > 8
      ? "the schema nests deeper than 8 levels — typed as any below that"
      : "the schema is not an object — typed as any");
    return "any";
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.map((branch) => jsonSchemaTypeText(branch, reading, depth + 1, note)).join(" | ");
    }
  }
  // `allOf` is an intersection — the value carries every branch's fields at
  // once — and TS spells that `A & B`. Left to fall through to `any`, a
  // composed response (demo-bank's transfer result) types every binding
  // through it as valid, including fields no branch declares.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // A branch that only TIGHTENS a sibling (`{ required: [...] }`) types as
    // `any`, and `T & any` is `any` — it would erase the very intersection it
    // was constraining, so it is dropped rather than joined. An unmodelled
    // branch still types as `any` and still collapses it: the safe direction.
    // Sibling `properties` are one more member, exactly as core's
    // `intersectSchemas` treats them: dropping them here would make THIS floor
    // reject a binding the declared contract allows and the other floor admits.
    const own = isRecord(schema.properties) ? [{ ...schema, allOf: [] }] : [];
    const parts = [...schema.allOf, ...own].filter(describesAValue)
      .map((branch) => jsonSchemaTypeText(branch, reading, depth + 1, note));
    if (parts.length > 0) return parts.join(" & ");
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return `Array<${jsonSchemaTypeText(schema.items, reading, depth + 1, note)}>`;
  if (type === "object" || isRecord(schema.properties)) return objectTypeText(schema, reading, depth, note);
  note?.(`JSON Schema type ${JSON.stringify(schema.type) ?? "(absent)"} describes no value the printer models — typed as any`);
  return "any";
};

const objectTypeText = (schema: Record<string, unknown>, reading: SchemaReading, depth: number, note?: TypeNote): string => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const fields = Object.entries(properties).map(([name, field]) =>
    `${name}${required.has(name) ? "" : "?"}: ${jsonSchemaTypeText(field, reading, depth + 1, at(note, name))}`);
  const open = reading === "props" && schema.additionalProperties !== false;
  if (open) fields.push("[prop: string]: any");
  return fields.length === 0 ? "{ [prop: string]: any }" : `{ ${fields.join("; ")} }`;
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

const queryTypeText =(query: ScreenQueryDeclaration, input: ScreenTypingsInput): string => {
  const declared = input.toolOutputSchemas?.[query.tool];
  // No declaration: permissive, so a tool whose contract nobody wrote never
  // turns every binding through it into an error.
  return declared === undefined ? "any" : jsonSchemaTypeText(declared, "result");
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

// ---- the component screen's declarations ----------------------------------

/**
 * The one module a component screen imports its surface from. `react` is the
 * only other import it may name, and NOTHING else exists: no DOM lib is loaded
 * into the check's program, so `document`, `fetch` and `<div>` go red because
 * they genuinely are not there — not because a deny-list remembered them.
 */
export const SCREEN_MODULE = "@vendo/screen";

/**
 * One component a screen may import: the name, and the props schema the
 * composition derived for it (`NormalizedCatalogEntry.propsJsonSchema`).
 *
 * A BARE NAME is the schema-less case, which is legal (contract `catalog.ts`:
 * "Schema-less entries are legal: the model infers props and validation is
 * permissive") — a host that registered no props schema keeps the permissive
 * shape, so its working screens are not suddenly rejected. A Kit name is always
 * bare: it is typed from its own zod spec, which is the stricter source.
 */
export type ScreenCatalogEntry = string | { readonly name: string; readonly propsJsonSchema?: JsonSchema };

/** The NAMES, in order — the vocabulary the renderer boots with and the tree
 *  check measures against. Exactly the list that flowed here before props rode
 *  along, because the declared surface must stay the renderer's surface. */
export const screenCatalogNames = (catalog: readonly ScreenCatalogEntry[]): string[] =>
  catalog.map((entry) => (typeof entry === "string" ? entry : entry.name));

export interface ComponentScreenTypingsInput {
  /** The components this screen may import. A Kit name is typed from its own zod
   *  spec; anything else is a host component, typed from the one props schema it
   *  registered — or permissively, when it registered none. */
  readonly catalog: readonly ScreenCatalogEntry[];
  /** The host tools: read tools become `useQuery` overloads, and every tool
   *  becomes a `tools` member typed from its input schema. */
  readonly tools: readonly HostToolInfo[];
  /** Where the printers announce what they could not model. */
  readonly note?: TypeNote;
}

/** A Kit prop whose zod schema is the shared `action` — `z.string().describe(…)`
 *  in kit/specs.ts (`kit/specs.ts:27`). The WIRE dialect passes a tool NAME
 *  through it, which is why the zod says `string` and must keep saying so: it
 *  still validates stored documents in the old format. A component screen passes
 *  a real handler that calls `tools.tool_name(args)` itself, so THIS generator
 *  types it as a function — derived from the schema's own description, so the two
 *  readings stay one definition rather than a hand-kept prop-name list.
 *
 *  Without this, every `onClick={() => tools.x(…)}` — which is every screen in
 *  the new format — would fail the type check against a `string` slot. */
const ACTION_PROP_DESCRIPTION = "names a host tool";

/** A handler slot. The event is the small React-shaped object a screen actually
 *  reads off one (`event.target.value` from an Input, `event.target.checked` from
 *  a Checkbox) — this program has no DOM lib to describe the real thing, and
 *  anything wider would reject working code. It is OPTIONAL because most handlers
 *  ignore it, and the return covers both `() => setOpen(true)` and an `async`
 *  handler that awaits a tool. */
const HANDLER_TYPE = "(event?: { target: { value?: string; checked?: boolean } }) => void | Promise<void>";

/** An identifier a declaration can be written under. A catalog name that is not
 *  one cannot be imported by a screen either. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** Everything the frame needs and nothing more. `IntrinsicElements` is EMPTY on
 *  purpose — that is what makes `<div>` an error — and `IntrinsicAttributes`
 *  carries `key`, because a list rendered with `.map()` writes one and it is
 *  React's, not the component's. */
const JSX_KEY_PROP = "key?: string | number";

const JSX_FRAME = `declare namespace JSX {
  interface Element {}
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { ${JSX_KEY_PROP} }
  interface IntrinsicElements {}
}`;

/** React as a screen may use it: the hooks, the two frame values, and the
 *  default export habit writes. Not the real @types/react — that would drag the
 *  DOM in, which is the one thing this program must not have. */
const REACT_MODULE = `declare module "react" {
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void];
  export function useMemo<T>(factory: () => T, deps?: readonly any[]): T;
  export function useCallback<T>(handler: T, deps?: readonly any[]): T;
  export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function createElement(...args: any[]): JSX.Element;
  export const Fragment: (props: { children?: any }) => JSX.Element;
  const React: {
    useState: typeof useState; useMemo: typeof useMemo; useCallback: typeof useCallback;
    useEffect: typeof useEffect; useRef: typeof useRef;
    createElement: typeof createElement; Fragment: typeof Fragment;
  };
  export default React;
}`;

const componentPropsText = (props: Record<string, PropSpec>, note?: TypeNote): string => {
  const fields = Object.entries(props).map(([name, spec]) => {
    const text = spec.schema.description === ACTION_PROP_DESCRIPTION
      ? HANDLER_TYPE
      : zodTypeText(spec.schema, 0, at(note, `prop "${name}"`));
    return `${name}${spec.required === true ? "" : "?"}: ${text}`;
  });
  return `{ ${[...fields, "children?: any"].join("; ")} }`;
};

/** A HOST component's props, from the one schema the composition derived for it.
 *  The same JSON Schema printer the wire declarations use — required stays
 *  required, an unmodelled construct degrades to `any` and says so through
 *  `note`, and a schema that does not close itself keeps its index signature, so
 *  an unmodelled prop is never a false finding. Plus `children?: any`: a screen
 *  writes JSX, so nesting is allowed even where the host's schema closes. */
const hostComponentPropsText = (schema: JsonSchema, note?: TypeNote): string =>
  `${objectTypeText(schema, "props", 0, note)} & { children?: any }`;

/**
 * `<ActionButton tool="…" args={…}/>` — the one component the catalog does not
 * carry, because its props are the HOST's tools rather than a zod spec: `tool`
 * is the literal name of one tool and `args` is THAT tool's own payload.
 *
 * So `tool` types as the names and `args` is looked up BY that name, which is
 * what makes the compiler answer all three ways a screen can get this wrong,
 * each on the attribute that is wrong: a tool the host does not have (with
 * TypeScript's own "did you mean"), a name that is not written out (a `string`
 * satisfies no name), and a payload that tool's schema does not accept. The same
 * three answers `tools.<name>(args)` already gets in a handler — printed from
 * the same schemas, by the same printer, under the same required rule, so one
 * write cannot read two ways.
 *
 * The rest of the props are `Button`'s own, minus its handler slot: this
 * component IS the handler, and the engine forwards everything else straight to
 * the Button it renders (`contract/genui/component/vm-program.ts`). Derived
 * rather than written out, so a prop added to the Kit's Button arrives here the
 * day it is added. No `children`: the engine renders the `label`, and a nested
 * child would be silently dropped.
 */
const ACTION_ARGS_TYPE = "VendoActionArgs";

const actionComponentLines = (tools: readonly HostToolInfo[], note?: TypeNote): string[] => {
  const shared = [
    ...Object.entries(kitSpec("Button")?.props ?? {})
      .filter(([, spec]) => spec.schema.description !== ACTION_PROP_DESCRIPTION)
      .map(([name, spec]) => `${name}${spec.required === true ? "" : "?"}: ${zodTypeText(spec.schema, 0, at(note, `<${SCREEN_ACTION_COMPONENT}> prop "${name}"`))}`),
    // `key` is React's, not the component's, and `JSX.IntrinsicAttributes`
    // already carries it — but only into a props type that is ONE object, and
    // this one is a lookup. Without it here, every mis-typed row control reports
    // its `key` instead of the thing that is actually wrong. Written from the
    // frame's own constant, so the two cannot say different things.
    JSX_KEY_PROP,
  ];
  // One entry per tool, carrying `args` with its own required-ness — so the
  // lookup below decides both the payload's TYPE and whether it may be omitted.
  // No tools at all leaves it EMPTY, which types `tool` as `never`: there is
  // nothing to call, rather than the component being gone.
  const args = tools.map((tool) => {
    const { text, required } = toolInputText(tool, at(note, `<${SCREEN_ACTION_COMPONENT} tool="${tool.name}"> args`));
    return `    ${JSON.stringify(tool.name)}: { args${required ? "" : "?"}: ${text} };`;
  });
  // The constraint is the NAMES, not `keyof` the table: a refusal prints the
  // constraint verbatim, and a screen author can act on "…takes
  // "cancel_transfer" | "resend_receipts"" in a way they cannot act on the name
  // of a type they will never see.
  const names = tools.length === 0 ? "never" : tools.map((tool) => JSON.stringify(tool.name)).join(" | ");
  return [
    `  interface ${ACTION_ARGS_TYPE} {`,
    ...args,
    `  }`,
    `  /** One press, one tool call. The product decides whether to ask first. */`,
    `  export const ${SCREEN_ACTION_COMPONENT}: <T extends ${names}>(props: { tool: T; ${shared.join("; ")} } & ${ACTION_ARGS_TYPE}[T]) => JSX.Element;`,
  ];
};

/** A tool payload reads CLOSED, whatever `additionalProperties` says: the whole
 *  point of typing it is that a misspelled key (`amountCents` for `amount`) is
 *  an error rather than a silently-dropped field. */
const toolInputText = (tool: HostToolInfo, note?: TypeNote): { text: string; required: boolean } => {
  const required = tool.inputSchema?.required;
  return {
    text: tool.inputSchema === undefined ? "any" : jsonSchemaTypeText(tool.inputSchema, "result", 0, note),
    required: Array.isArray(required) && required.length > 0,
  };
};

/**
 * The ambient declarations for one COMPONENT screen — the plain-TSX artifact.
 *
 * Same derivation as {@link screenTypings} and the same printers, a different
 * shape: a screen file is a real module now, so the surface is declared as the
 * two modules it may import instead of as bare globals. Data arrives through
 * `useQuery`, overloaded once per read tool with that tool's declared result
 * type, and actions through `tools`, typed per tool input schema — so "reads a
 * field the response does not carry" and "calls a tool with the wrong payload
 * key" are both answered by the compiler.
 */
export function componentScreenTypings(input: ComponentScreenTypingsInput): string {
  const note = input.note;
  const lines: string[] = [
    "// GENERATED by @vendoai/apps componentScreenTypings — do not edit.",
    JSX_FRAME,
    REACT_MODULE,
    `declare module ${JSON.stringify(SCREEN_MODULE)} {`,
  ];

  // By name, first entry wins: a Kit built-in shadows a host component of the
  // same name, because the renderer resolves a built-in first.
  const declared = new Set<string>();
  for (const entry of input.catalog) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (declared.has(name)) continue;
    declared.add(name);
    if (!IDENTIFIER.test(name)) {
      note?.(`component "${name}" is not an identifier — it cannot be declared or imported`);
      continue;
    }
    const spec = kitSpec(name);
    const schema = typeof entry === "string" ? undefined : entry.propsJsonSchema;
    const propsText = spec !== undefined
      ? componentPropsText(spec.props, at(note, `<${name}>`))
      : schema === undefined
        // Schema-less, and legal: the model infers the props and nothing here can
        // check them. The skill's "a guessed prop is a failed app" is true of every
        // component whose host declared one.
        ? "{ [prop: string]: any; children?: any }"
        : hostComponentPropsText(schema, at(note, `<${name}>`));
    lines.push(`  export const ${name}: (props: ${propsText}) => JSX.Element;`);
  }
  lines.push(...actionComponentLines(input.tools, note));

  const overloads = input.tools.filter((tool) => !isMutatingTool(tool)).map((tool) => {
    const { text, required } = toolInputText(tool, at(note, `useQuery("${tool.name}") input`));
    const result = tool.outputSchema === undefined
      ? "any"
      : jsonSchemaTypeText(tool.outputSchema, "result", 0, at(note, `useQuery("${tool.name}") result`));
    return `  export function useQuery(tool: ${JSON.stringify(tool.name)}, input${required ? "" : "?"}: ${text}): ${result};`;
  });
  // No read tools at all: the surface still exports `useQuery`, so a screen that
  // calls it is told there is nothing to read rather than that the name is gone.
  lines.push(...(overloads.length === 0 ? ["  export function useQuery(tool: never, input?: never): never;"] : overloads));

  lines.push("  /** The result is deliberately untyped: a write may be answered by the");
  lines.push("   *  approval pipe rather than by the tool. */");
  lines.push("  export const tools: {");
  for (const tool of input.tools) {
    const { text, required } = toolInputText(tool, at(note, `tools.${tool.name}(…) input`));
    lines.push(`    ${JSON.stringify(tool.name)}(input${required ? "" : "?"}: ${text}): Promise<any>;`);
  }
  lines.push("  };");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
