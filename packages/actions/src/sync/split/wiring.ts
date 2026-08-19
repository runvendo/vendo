/**
 * The HOME half: one generated module in the host's own repo that binds every
 * ported slot back to the functions and components the host already wrote.
 *
 * It is CODE, not JSON — the first thing sync emits that is — because what it
 * carries cannot be data: a tool's `execute` is the host's own function, and a
 * hole is the host's own component. Regenerated whole on every sync and never
 * hand-edited, so the host reads it the way they read any other generated file:
 * in the diff.
 */
export const WIRING_MODULE = ".vendo/generated/remix-wiring";

/** One host binding, as the wiring file imports it. */
export interface WiringRef {
  /** The name the port knows it by — the hole key, or the envelope field. */
  name: string;
  /** The name its module exports it under; "default" for a default import. */
  imported: string;
  /** The specifier to write: a package name, or a path relative to this file. */
  from: string;
  /** For a read seen through a hook: the property to call on the imported
   *  binding (`api.get`), and the literal key the hook passed its fetcher. */
  member?: string;
  key?: string;
}

/** One parameter the host function declares, carried verbatim into the tool's
 *  input schema. This is what keeps a generated tool exactly as wide as the
 *  call the component already made — never an open bag of arguments. */
export interface WiringParameter { name: string; schema: { type: string }; required: boolean }

export interface WiringSlot {
  slot: string;
  /** `parameters` is the union of the read bindings' declared parameters — the
   *  allowlist the seed's live props are admitted against. */
  read?: { tool: string; bindings: WiringRef[]; parameters: WiringParameter[] };
  writes: Array<{ tool: string; binding: WiringRef; parameters: WiringParameter[] }>;
  holes: WiringRef[];
}

export const readToolDescription = (slot: string): string =>
  `Read the data the ${slot} remixable component renders.`;

export const writeToolDescription = (slot: string, binding: string): string =>
  `Run the ${binding} action the ${slot} remixable component performs.`;

export function remixWiringSource(slots: readonly WiringSlot[]): string {
  const locals = new Map<string, string>();
  const taken = new Set<string>();
  const imports: string[] = [];
  /** The local name this reference rides under, importing it on first use. Two
   *  slots naming the same export share one import; two different exports that
   *  want one name get `$2`, `$3`, so the file always compiles. */
  const localFor = (reference: WiringRef): string => {
    const key = `${reference.from}\0${reference.imported}`;
    const already = locals.get(key);
    if (already !== undefined) return already;
    // The local name follows the EXPORT, not the port's name for it: a read
    // seen through a hook is imported as `api` and called as `api.get(key)`,
    // while its envelope field stays the hook's own name.
    const base = reference.imported === "default" ? reference.name : reference.imported;
    let local = base;
    for (let index = 2; taken.has(local); index += 1) local = `${base}$${index}`;
    taken.add(local);
    locals.set(key, local);
    imports.push(reference.imported === "default"
      ? `import ${local} from ${JSON.stringify(reference.from)};`
      : `import { ${reference.imported === local ? local : `${reference.imported} as ${local}`} } from ${JSON.stringify(reference.from)};`);
    return local;
  };

  /** `{ billId: { type: "string" } }` — a tool's declared input, or `{}`. */
  const propertiesOf = (parameters: readonly WiringParameter[]): string => {
    const entries = parameters.map((parameter) => `${parameter.name}: { type: ${JSON.stringify(parameter.schema.type)} }`);
    return `{${entries.length === 0 ? "" : ` ${entries.join(", ")} `}}`;
  };

  const body: string[] = [];
  for (const entry of slots) {
    const tools: string[] = [];
    if (entry.read !== undefined) {
      const fields = entry.read.bindings.map((reference) => {
        const call = `${localFor(reference)}${reference.member === undefined ? "" : `.${reference.member}`}`;
        return `${reference.name}: await ${call}(${reference.key === undefined ? "" : JSON.stringify(reference.key)})`;
      });
      tools.push(
        `      ${entry.read.tool}: {`,
        `        name: ${JSON.stringify(entry.read.tool)},`,
        `        description: ${JSON.stringify(readToolDescription(entry.slot))},`,
        // No `required`: the port's own useQuery carries no input — a query is
        // resolved before the screen renders — so every declared name is
        // answered out-of-band, by the seed's live props, or not at all.
        `        inputSchema: { type: "object", properties: ${propertiesOf(entry.read.parameters)}, additionalProperties: false },`,
        `        risk: "read",`,
        `        execute: async () => ({ ${fields.join(", ")} }),`,
        "      },",
      );
    }
    for (const { tool, binding, parameters } of entry.writes) {
      const local = localFor(binding);
      const required = parameters.filter((parameter) => parameter.required).map((parameter) => JSON.stringify(parameter.name));
      const signature = parameters.map((parameter) =>
        `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.schema.type}`).join("; ");
      tools.push(
        `      ${tool}: {`,
        `        name: ${JSON.stringify(tool)},`,
        `        description: ${JSON.stringify(writeToolDescription(entry.slot, binding.name))},`,
        `        inputSchema: { type: "object", properties: ${propertiesOf(parameters)}, required: [${required.join(", ")}], additionalProperties: false },`,
        `        risk: "write",`,
        `        execute: async (input: { ${signature} }) => ${local}(${parameters.map((parameter) => `input.${parameter.name}`).join(", ")}),`,
        "      },",
      );
    }
    const holes = entry.holes.map((reference) => {
      const local = localFor(reference);
      return local === reference.name ? reference.name : `${reference.name}: ${local}`;
    });
    body.push(
      `  ${entry.slot}: {`,
      ...(tools.length === 0 ? ["    tools: {},"] : ["    tools: {", ...tools, "    },"]),
      `    holes: {${holes.length === 0 ? "" : ` ${holes.join(", ")} `}},`,
      "  },",
    );
  }

  return `${[
    // The hookup is property SHORTHAND, which is only valid while the
    // `createVendo` option and the exported const below share the name
    // `remixWiring`. Rename either and this header silently needs `key: value`
    // back — nothing type-checks a comment, so no gate would catch it.
    //
    // BOTH call sites, or the feature silently does not exist: the server half
    // registers the tools, and the PROVIDER half renders the holes and is what
    // shows the ✦ on ported components at all — the chrome is fail-closed, so a
    // host that wires only createVendo sees no ✦ anywhere.
    "// Generated by `vendo sync` — do not edit. Regenerated on every sync.",
    "// Hook it up in BOTH places — the server registers the tools, the provider",
    "// renders the holes and shows the ✦ on ported components:",
    `//   import { remixWiring } from "./${WIRING_MODULE}";`,
    "//   createVendo({ remixWiring })                 // server",
    "//   <VendoProvider remixWiring={remixWiring}>    // client",
    ...imports,
    "",
    "export const remixWiring = {",
    ...body,
    "} as const;",
  ].join("\n")}\n`;
}
