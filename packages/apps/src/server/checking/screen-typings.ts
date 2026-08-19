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
 * prop list: the component vocabulary comes from `KIT_SCREEN_COMPONENT_NAMES` + the
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
  ACTION_PROP_DESCRIPTION,
  DISPLAY_TAG_NAMES,
  ICON_NAME_DESCRIPTION,
  KIT_COMPONENT_NAMES,
  KIT_ICON_NAMES,
  KIT_SCREEN_COMPONENT_NAMES,
  KIT_SLOT_PROPS,
  SAFE_STYLE_PROPERTIES,
  SLOT_PROP_DESCRIPTION,
  kitSpec,
  type KitComponentSpec,
  type NormalizedCatalog,
} from "../../contract/index.js";
import type { ZodTypeAny } from "zod";
import { zodShape } from "../../contract/kit/zod-shape.js";
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

/**
 * What a slot may hold — an element tree, or a function that returns one.
 *
 * One law for every slot: the element, or the function that makes it. The VM
 * calls whichever it was given (`genui/component/vm-program.ts` `emitSlot`) and
 * emits the result where the slot sits, so `header={() => <Text/>}` is as real as
 * `header={<Text/>}`.
 *
 * The ARITY is the only thing that differs, and it is what this alias states: a
 * slot painted ONCE has no row to be a function of, so its function takes
 * nothing. A `(row) => …` written here would be called with no row and read a
 * field off `undefined` — the compiler is the only thing that can refuse it, and
 * {@link ROW_SLOT_TYPE} is the other arity.
 *
 * The wire printer keeps the permissive alias: a stored document's slot holds a
 * SERIALIZED element (an `$element`-sigilled object) that no type here
 * describes, and JSON cannot carry a closure, so neither form reaches it.
 */
export const SLOT_TYPE = "VendoSlot";
const SLOT_DECLARATION =
  `declare type ${SLOT_TYPE} = JSX.Element | string | number | boolean | null | undefined | readonly ${SLOT_TYPE}[] | (() => ${SLOT_TYPE});`;
const WIRE_SLOT_DECLARATION = `declare type ${SLOT_TYPE} = any;`;

/**
 * The same law at the other arity: a slot the Kit paints once PER ROW, whose
 * function is handed the row.
 *
 * A per-row slot is painted once for every row, so a function of the row is the
 * only way to say something different in each — and it is what React trains
 * anyone to write. The VM calls it once per row and hands the component that
 * row's own element (`vm-program.ts` `emitSlot`), so the closure is real: the
 * handler inside `rowActions={(row) => <Button onClick={() => …row.id…}/>}` is
 * that row's handler and nobody else's.
 *
 * A separate alias rather than a widened {@link SLOT_TYPE} because the ARGUMENTS
 * differ, not the law: a function of the row written in a slot painted once is
 * called with no row, and this is the only place that can say so.
 */
export const ROW_SLOT_TYPE = "VendoRowSlot";
const ROW_SLOT_DECLARATION =
  `declare type ${ROW_SLOT_TYPE} = ${SLOT_TYPE} | ((row: any, index: number) => ${SLOT_TYPE});`;

/**
 * Every glyph the Kit ships, as a closed union of literals.
 *
 * `<Icon name="invented-glyph"/>` paints an EMPTY SPAN — the renderer draws a
 * name it has no path data for as nothing at all (`ui` kit/icon.tsx), on purpose,
 * because a missing glyph must never be a crash. So the name is a value no gate
 * downstream can question: the screen compiles, type-checks, paints and validates
 * with a hole where it said there was an icon.
 *
 * Printed closed, the compiler is the one thing that can refuse it, and it
 * refuses it the way it refuses any wrong literal — naming the prop, and
 * suggesting the nearest real name it can spell. `KIT_ICON_NAMES` is generated
 * from the same lucide export the renderer's path data is (icon-names.gen.ts), so
 * the set this admits is exactly the set that draws. A couple of hundred literals
 * is nothing to tsc, and it is the whole vocabulary now: the catalog stopped
 * spending ~575 tokens per generation teaching the list.
 *
 * A prop typed this way still takes a BINDING in the wire printer
 * ({@link BINDING_TYPE}), so a stored screen resolving the name at render time is
 * untouched.
 */
const ICON_NAME_TYPE = KIT_ICON_NAMES.map((name) => JSON.stringify(name)).join(" | ");

/** The Kit's zod vocabulary is closed — it is our own schema file — so a
 *  direct walker beats a converter dependency (see the module note in the PR).
 *  Anything outside the vocabulary degrades to `any`: a prop we cannot type
 *  precisely must never become a false positive. */
export const zodTypeText = (schema: ZodTypeAny | undefined, depth = 0, note?: TypeNote): string => {
  if (depth > 8) {
    note?.("the schema nests deeper than 8 levels — typed as any below that");
    return "any";
  }
  const shape = zodShape(schema);
  switch (shape.kind) {
    // A described string is not just a string: an icon NAME is the closed set the
    // renderer has path data for ({@link ICON_NAME_TYPE}).
    case "string": return schema?.description === ICON_NAME_DESCRIPTION ? ICON_NAME_TYPE : "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    // `any` is these two's FAITHFUL type, not a degradation — no note. A SLOT is
    // the one exception: it holds an element, and `any` admitted the closure that
    // cannot work — see {@link SLOT_TYPE}.
    case "unknown":
    case "any":
      return schema?.description === SLOT_PROP_DESCRIPTION ? SLOT_TYPE : "any";
    // One case for both: a literal is an enum of one, and zod 4 spells it as a
    // list either way.
    case "enum":
    case "literal":
      return (shape.values ?? []).map((value) => JSON.stringify(value)).join(" | ");
    case "array":
      return `Array<${zodTypeText(shape.inner, depth + 1, note)}>`;
    case "union":
      return (shape.options ?? []).map((option) => zodTypeText(option, depth + 1, note)).join(" | ");
    case "record":
      return `Record<string, ${zodTypeText(shape.valueType, depth + 1, note)}>`;
    case "object": {
      const fields = Object.entries(shape.shape ?? {}).map(([name, field]) => {
        const inner = zodShape(field);
        const optional = inner.kind === "optional";
        return `${name}${optional ? "?" : ""}: ${zodTypeText(optional ? inner.inner : field, depth + 1, at(note, name))}`;
      });
      // A passthrough object keeps what it does not declare, and the printer must
      // say so: a chart's series descriptor carries that one series' engine props
      // beside `key`, and a closed type makes writing one an excess-property error.
      if (shape.passthrough === true) fields.push(ENGINE_INDEX);
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    case "optional":
      return zodTypeText(shape.inner, depth + 1, note);
    case "nullable":
      return `${zodTypeText(shape.inner, depth + 1, note)} | null`;
    case "effects":
      return zodTypeText(shape.inner, depth + 1, note);
    default:
      note?.(`zod ${shape.tag ?? "construct"} is not in the printer's vocabulary — typed as any`);
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

/** What OPENS a component that renders an engine (`KitComponentSpec.engine`):
 *  the engine's prop vocabulary is the engine's, so the type check stops
 *  measuring against a list we would have to keep in step with it. The cost is
 *  the excess-property gate on that component, which is the trade the upgrade
 *  posture already made. */
const ENGINE_INDEX = "[prop: string]: any";

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

const propsTextFrom = (spec: KitComponentSpec): string => {
  const fields = Object.entries(spec.props).map(([name, prop]) =>
    `${name}${prop.required === true ? "" : "?"}: ${zodTypeText(prop.schema)} | ${BINDING_TYPE}`);
  const engine = spec.engine === undefined ? [] : [ENGINE_INDEX];
  return `{ ${[...fields, AMBIENT_PROPS, ...engine].join("; ")} }`;
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
    WIRE_SLOT_DECLARATION,
  ];

  const push = (name: string, propsText: string): void => {
    if (declared.has(name)) return;
    declared.add(name);
    lines.push(componentDeclaration(name, propsText));
  };

  // The Kit first: a built-in shadows a host component of the same name,
  // because the renderer resolves a built-in name before it looks at the
  // catalog (facts.ts `catalogIssues`). V4: the Kit specs are the only source.
  for (const name of KIT_SCREEN_COMPONENT_NAMES) {
    const spec = kitSpec(name);
    if (spec !== undefined) push(name, propsTextFrom(spec));
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

/**
 * What a screen may import from `@vendo/screen`: the WHOLE Kit plus this host's
 * own catalog.
 *
 * The whole Kit, not the wire-safe subset — a screen writes JSX, so the
 * element-valued slots the wire dialect could never express (`Accordion`) are
 * ordinary here.
 *
 * Composed once, and to match the RENDERER exactly (`packages/ui` renderer.tsx
 * boots the VM with `[...KIT_COMPONENT_NAMES, ...host components]`): a name this
 * check admits and the renderer does not is a screen that passes every gate and
 * paints nothing, and a name the renderer has and the check does not is a type
 * error over working code.
 *
 * A host entry brings its derived props schema along, because the type check has
 * no other way to learn a host component's props and a name alone degrades every
 * one of them to `any` — which makes a guessed prop on a host component compile,
 * the one thing the skill promises it will not. The Kit half stays bare NAMES:
 * those are typed from their own zod specs, the stricter source.
 */
export const screenCatalog = (
  catalog: readonly { name: string; propsJsonSchema?: JsonSchema }[],
): ScreenCatalogEntry[] => [
  ...KIT_COMPONENT_NAMES,
  ...catalog.map(({ name, propsJsonSchema }) =>
    (propsJsonSchema === undefined ? name : { name, propsJsonSchema })),
];

/** `Promise`, and no DOM: a handler awaits a tool call, and `document`/`fetch`
 *  must stay undeclared so reaching for them is an error.
 *
 *  It is also what declares `Intl` — `NumberFormat`, `formatToParts`, `dateStyle`,
 *  and the locale-taking `toLocaleString`/`toLocaleDateString` overloads — and
 *  those declarations are TRUE inside the box: the VM carries no ICU and borrows
 *  the host's real `Intl` across the wall (`genui/component/vm-program.ts`
 *  `INTL_SOURCE`). A smaller lib here would refuse the one idiom every model
 *  writes for money and dates while the VM ran it perfectly well.
 *
 *  THIS PIN DECIDES WHAT THE BRIDGE MUST CARRY. Every value-side name in this
 *  lib's `Intl` is a name a screen may write and the box therefore has to answer;
 *  one that is declared and unbridged is a green check over a screen that dies on
 *  its first paint. Moving the pin moves that obligation — `ListFormat` and the
 *  `formatRange` family arrive with es2021 and es2023 — so a bump lands together
 *  with the bridge's new methods, and `tests/checking/screen-intl-parity.test.ts`
 *  walks the two surfaces and refuses any difference either way. */
export const COMPONENT_SCREEN_LIB = ["lib.es2020.d.ts"];

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

/** A handler slot, printed for every prop whose schema carries
 *  {@link ACTION_PROP_DESCRIPTION}. The WIRE dialect passed a tool NAME through
 *  that prop, which is why its zod says `string` and must keep saying so — it
 *  still validates stored documents in the old format — while a component screen
 *  passes a real handler that calls `tools.tool_name(args)` itself. Without this,
 *  every `onClick={() => tools.x(…)}` would fail the type check against a string.
 *
 *  The event is the small React-shaped object a screen actually
 *  reads off one (`event.target.value` from an Input, `event.target.checked` from
 *  a Checkbox) — this program has no DOM lib to describe the real thing, and
 *  anything wider would reject working code. It is OPTIONAL because most handlers
 *  ignore it, and the return covers both `() => setOpen(true)` and an `async`
 *  handler that awaits a tool. */
const HANDLER_TYPE = "(event?: { target: { value?: string; checked?: boolean } }) => void | Promise<void>";

/** An identifier a declaration can be written under. A catalog name that is not
 *  one cannot be imported by a screen either. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** The paint allowlist, as a TYPE. The renderer drops an unnamed property at
 *  paint (`@vendoai/ui` `safeStyle`), so leaving it legal here shipped screens
 *  that compiled clean and then did not paint what they wrote. Printed from the
 *  contract's one list, so the compiler and the renderer cannot disagree. */
const SAFE_STYLE_TYPE = "VendoStyle";
const SAFE_STYLE_DECLARATION = `interface ${SAFE_STYLE_TYPE} {
${SAFE_STYLE_PROPERTIES.map((property) => `  ${property}?: string | number;`).join("\n")}
}`;

/** Everything the frame needs and nothing more. `IntrinsicElements` lists the
 *  display bricks and NOTHING else — that is what keeps `<img>` and `<script>`
 *  errors while `<div>` compiles — and each one takes only children and an
 *  inline style, so `className`, `onClick` and `dangerouslySetInnerHTML` are
 *  type errors on the tag itself — plus `key`, because a list rendered with
 *  `.map()` writes one on whatever it maps to. `IntrinsicAttributes` says the
 *  same thing for a COMPONENT, and only for a component: TypeScript intersects
 *  it into a value-based element's props and never into an intrinsic tag's,
 *  which take `IntrinsicElements[tag]` verbatim. Declaring `key` in one place
 *  only made `key={i}` on `<div>` a hard error while the format skill was
 *  telling the model to write exactly that.
 *
 *  `Element` is BRANDED rather than empty. `{}` is the type every value is
 *  assignable to — a closure included — so an empty `Element` made
 *  {@link SLOT_TYPE} admit every function, including the two it must refuse: one
 *  that reads a row where there is no row, and one that returns no element. A JSX
 *  expression is typed `JSX.Element` by the compiler whatever its shape, so the
 *  brand costs a screen nothing; the name is the VM's own sigil for a serialized
 *  element (`genui/component/vm-program.ts` `emitValue`). */
const JSX_FRAME = `declare namespace JSX {
  interface Element { readonly $element: true }
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  interface IntrinsicElements {
${DISPLAY_TAG_NAMES.map((tag) => `    ${tag}: { children?: any; style?: ${SAFE_STYLE_TYPE}; key?: string | number };`).join("\n")}
  }
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
  /** So a screen can name the type of a style it hoists out of the JSX. It is
   *  the SAME allowlist: an open index signature here would be the one spelling
   *  that smuggles a dropped property past the check. */
  export type CSSProperties = ${SAFE_STYLE_TYPE};
  const React: {
    useState: typeof useState; useMemo: typeof useMemo; useCallback: typeof useCallback;
    useEffect: typeof useEffect; useRef: typeof useRef;
    createElement: typeof createElement; Fragment: typeof Fragment;
  };
  export default React;
}`;

const componentPropsText = (spec: KitComponentSpec, note?: TypeNote): string => {
  const slots = KIT_SLOT_PROPS[spec.name];
  const fields = Object.entries(spec.props).map(([name, prop]) => {
    // `style` prints as the paint allowlist, not as its own zod — which still
    // has to say `Record<string, string | number>` because it validates stored
    // documents, while what a Kit root may actually paint is the same list a
    // display brick gets.
    const text = prop.schema.description === ACTION_PROP_DESCRIPTION
      ? HANDLER_TYPE
      : name === "style"
        ? SAFE_STYLE_TYPE
        : zodTypeText(prop.schema, 0, at(note, `prop "${name}"`));
    // Every slot this prop prints is a PER-ROW slot when the prop's slot maps over
    // rows — `rowActions` is the slot itself, `columns[].cell` is a field of one — so
    // the substitution is over the printed text rather than threaded through the walk.
    const typed = slots?.[name]?.rows === undefined ? text : text.replaceAll(SLOT_TYPE, ROW_SLOT_TYPE);
    return `${name}${prop.required === true ? "" : "?"}: ${typed}`;
  });
  const engine = spec.engine === undefined ? [] : [ENGINE_INDEX];
  return `{ ${[...fields, "children?: any", ...engine].join("; ")} }`;
};

/** A HOST component's props, from the one schema the composition derived for it.
 *  The same JSON Schema printer the wire declarations use — required stays
 *  required, an unmodelled construct degrades to `any` and says so through
 *  `note`, and a schema that does not close itself keeps its index signature, so
 *  an unmodelled prop is never a false finding. Plus `children?: any`: a screen
 *  writes JSX, so nesting is allowed even where the host's schema closes. */
const hostComponentPropsText = (schema: JsonSchema, note?: TypeNote): string =>
  `${objectTypeText(schema, "props", 0, note)} & { children?: any }`;

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
    SAFE_STYLE_DECLARATION,
    JSX_FRAME,
    SLOT_DECLARATION,
    ROW_SLOT_DECLARATION,
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
      ? componentPropsText(spec, at(note, `<${name}>`))
      : schema === undefined
        // Schema-less, and legal: the model infers the props and nothing here can
        // check them. The skill's "a guessed prop is a failed app" is true of every
        // component whose host declared one.
        ? "{ [prop: string]: any; children?: any }"
        : hostComponentPropsText(schema, at(note, `<${name}>`));
    lines.push(`  export const ${name}: (props: ${propsText}) => JSX.Element;`);
  }

  const overloads = input.tools.filter((tool) => !isMutatingTool(tool)).map((tool) => {
    const { text, required } = toolInputText(tool, at(note, `useQuery("${tool.name}") input`));
    // `Partial`, because a read whose input the screen COMPUTES has no answer on
    // the first paint: the VM hands back `{ data: undefined }` there and the host
    // supplies the real result a paint later (`genui/component/vm-program.ts`
    // `MISS`). Declaring the fields as always-present would be a green check over
    // a screen whose every field is undefined for one render.
    const result = tool.outputSchema === undefined
      ? "any"
      : `Partial<${jsonSchemaTypeText(tool.outputSchema, "result", 0, at(note, `useQuery("${tool.name}") result`))}>`;
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
