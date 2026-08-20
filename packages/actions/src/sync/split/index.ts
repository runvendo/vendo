import path from "node:path";
import { PORTED_SCREEN_DIALECT, checkComponentScreen } from "@vendoai/apps";
import type { Json } from "@vendoai/core";
import type { SeedPort } from "@vendoai/apps/contract";
import type TS from "typescript";
import { defaultExportOf } from "../capture.js";
import { isPackageSpecifier, parseModuleSource, resolveImportSource, visitNodes } from "../common.js";
import { carveModule } from "./carve.js";
import { portComponent, renderPort, type PortBinding } from "./port.js";
import {
  readToolDescription,
  writeToolDescription,
  type WiringRef,
  type WiringSlot,
} from "./wiring.js";

/**
 * THE SPLITTER. One `<Remixable>` component becomes a ported half, a home half,
 * and a verdict.
 *
 * The verdict is `checkComponentScreen` and nothing else — the same gauntlet the
 * runtime runs when a remix persists, so there is no cheaper pre-filter here on
 * purpose, and in the same DIALECT ({@link PORTED_SCREEN_DIALECT}), which the
 * floor derives off the row rather than assembling a second copy of.
 */
export interface SplitInput {
  slot: string;
  /** The component module's source, as captured. */
  source: string;
  /** Its real path, for resolving the imports it writes. */
  file: string;
  root: string;
  /** Where the wiring file will sit — the paths it imports are relative to it. */
  generatedDir: string;
  /** The host's own declared sample props for this component, when a
   *  registration carries them — what the gauntlet paints a props-dependent
   *  port with. Never invented: absent, the port is graded with none, and one
   *  that paints nothing without props is refused. */
  sampleProps?: Record<string, Json>;
}

export type SplitOutcome =
  | {
    ok: true;
    port: SeedPort;
    wiring: WiringSlot;
    /** The carver's home module — the slot's unportable half, written beside
     *  the wiring file, which imports this slot's carved holes from it. */
    home?: string;
  }
  | { ok: false; issues: string[] };

const withoutExtension = (file: string): string => file.replace(/\.[cm]?[jt]sx?$/u, "");

/** `.vendo/generated/` -> `../../src/lib/rewards`. */
function relativeSpecifier(fromDirectory: string, file: string): string {
  const relative = path.relative(fromDirectory, withoutExtension(file)).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** One parameter of a host function, as the generated tool will accept it. */
interface HostParameter { name: string; schema: { type: string }; required: boolean }

/**
 * What a host READ hook actually fetches — the binding the generated tool binds,
 * and the literal key it is called with.
 *
 * The port never server-calls a hook, and it never stops being one either:
 * `useRewards(accountId)` stays exactly that at the call site, and the SHIM the
 * splitter generates for it reads `useQuery("<envelope>")`, which the engine
 * pre-fetches. The tool underneath binds the FETCH the hook wraps.
 *
 * So the question per read is not "is this hook server-callable" — no hook ever
 * is — but "can this hook be seen through to a fetch, structurally". For the
 * ubiquitous `useSWR(key, fetcher)` shape both halves are right there in the
 * AST: the key is a literal and the fetcher is a binding. Nothing is guessed;
 * a hook that resolves to no fetch is refused, exactly as before.
 */
interface ReadSource { imported: string; specifier: string; member?: string; key?: string }

/** The import that binds `name` in this module, if any. */
function importOf(ts: typeof TS, sf: TS.SourceFile, name: string): { imported: string; specifier: string } | undefined {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name?.text === name) return { imported: "default", specifier };
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (!element.isTypeOnly && element.name.text === name) {
        return { imported: (element.propertyName ?? element.name).text, specifier };
      }
    }
  }
  return undefined;
}

/** The single call a one-expression function body is, if it is one. */
function soleCall(ts: typeof TS, body: TS.Node): TS.CallExpression | undefined {
  if (ts.isCallExpression(body)) return body;
  if (!ts.isBlock(body) || body.statements.length !== 1) return undefined;
  const [only] = body.statements;
  if (only === undefined || !ts.isReturnStatement(only) || only.expression === undefined) return undefined;
  return ts.isCallExpression(only.expression) ? only.expression : undefined;
}

/** The body of the function `name` is declared as, however it is declared. */
function declaredBody(ts: typeof TS, sf: TS.SourceFile, name: string): TS.Node | undefined {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.body;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined) return undefined;
      return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer.body : undefined;
    }
  }
  return undefined;
}

/** The importable binding a hook's fetcher argument stands for. Directly, when
 *  the fetcher is itself imported; otherwise one hop through the near-universal
 *  private `const f = (url) => api.get(url)` wrapper, because a module-private
 *  binding is not something the wiring file can import. */
function fetcherBinding(
  ts: typeof TS,
  sf: TS.SourceFile,
  name: string,
): { imported: string; specifier: string; member?: string } | null {
  const direct = importOf(ts, sf, name);
  if (direct !== undefined) return direct;
  const body = declaredBody(ts, sf, name);
  if (body === undefined) return null;
  const inner = soleCall(ts, body);
  if (inner === undefined) return null;
  const callee = inner.expression;
  if (ts.isIdentifier(callee)) return importOf(ts, sf, callee.text) ?? null;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const found = importOf(ts, sf, callee.expression.text);
  return found === undefined ? null : { ...found, member: callee.name.text };
}

function readSourceOf(source: string, file: string, exported: string): ReadSource | null {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return null;
  const { ts, sf } = parsed;
  const name = exported === "default" ? defaultExportOf(source, file)?.name : exported;
  if (name === undefined || name === null) return null;
  const body = declaredBody(ts, sf, name);
  if (body === undefined) return null;
  const call = soleCall(ts, body);
  if (call === undefined || !ts.isIdentifier(call.expression) || !/^use[A-Z]/u.test(call.expression.text)) return null;

  const key = call.arguments.find((argument) =>
    ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
  const fetcher = call.arguments.find((argument) => ts.isIdentifier(argument));
  // A FETCH is a literal key PLUS something to fetch it with. Without the key
  // there is no fetch here to bind — `useContext(SomeContext)` is shaped exactly
  // like `useSWR(key, fetcher)` if you only look for an identifier argument, and
  // binding a context object as a fetcher is how this would emit a tool that
  // throws on its first call. A template with substitutions is a per-call value
  // the envelope cannot carry, so it does not count as a key either.
  if (key === undefined || fetcher === undefined || !ts.isIdentifier(fetcher)) return null;
  const bound = fetcherBinding(ts, sf, fetcher.text);
  return bound === null ? null : { ...bound, key: (key as TS.StringLiteral).text };
}

/**
 * The host's own signature for `exported`: its parameters, and whether its body
 * is a REACT HOOK.
 *
 * Both facts gate the split, and both are read off the host's own declaration:
 *
 *  - `parameters` is what the generated tool is allowed to accept. The brief's
 *    law is that a generated tool exposes only the capability the component
 *    already had, with the ORIGINAL CALL SITE's shape — so an open bag of
 *    arguments is a widening and is refused. Null when the declaration cannot
 *    be read, or carries a parameter this cannot narrow (destructured, rest, or
 *    a type that is not a JSON scalar).
 *  - `hook` is true when the body calls a `use*` function. A hook is only
 *    callable inside React's render, and the wiring calls it SERVER-side
 *    through the tool registry, where it throws "Invalid hook call". A binding
 *    we cannot really call is not a data source we can wire.
 */
function hostSignature(
  source: string,
  file: string,
  exported: string,
): { parameters: HostParameter[] | null; hook: boolean } | null {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return null;
  const { ts, sf } = parsed;
  const name = exported === "default" ? defaultExportOf(source, file)?.name : exported;
  if (name === undefined || name === null) return null;
  const scalar = (node: TS.TypeNode | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
    if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
    return undefined;
  };
  const shape = (parameters: readonly TS.ParameterDeclaration[]): HostParameter[] | null => {
    const out: HostParameter[] = [];
    for (const parameter of parameters) {
      const type = scalar(parameter.type);
      if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined || type === undefined) return null;
      out.push({
        name: parameter.name.text,
        schema: { type },
        required: parameter.questionToken === undefined && parameter.initializer === undefined,
      });
    }
    return out;
  };
  const callsHook = (body: TS.Node): boolean => {
    let found = false;
    // The BODY ITSELF counts: `visitNodes` walks children only, and a concise
    // arrow (`() => useSWR(…)`) is the single most common hook shape there is —
    // its call IS the body, so a children-only walk never sees it.
    const seen = (node: TS.Node): void => {
      if (!ts.isCallExpression(node)) return;
      // Both spellings a hook is called by: `useSWR(…)` and `React.useContext(…)`.
      // A namespace import is how half of real React code reaches its hooks, and
      // reading only the bare identifier lets exactly those through.
      const callee = node.expression;
      const called = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (called !== undefined && /^use[A-Z]/u.test(called)) found = true;
    };
    seen(body);
    visitNodes(ts, body, seen);
    return found;
  };
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { parameters: shape(statement.parameters), hook: statement.body !== undefined && callsHook(statement.body) };
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined || !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return null;
      return { parameters: shape(initializer.parameters), hook: callsHook(initializer.body) };
    }
  }
  return null;
}

export async function splitSlot(input: SplitInput): Promise<SplitOutcome> {
  // The carver first: inline unportable subtrees become holes and `<button>`
  // becomes the Kit Button, so what the porter reads is already the portable
  // half. A guard the carver cannot prove is a refusal, never a guess.
  const carved = carveModule(input.slot, input.source, input.file);
  if (carved.issues.length > 0) return { ok: false, issues: carved.issues };
  const port = portComponent(input.slot, carved.source, input.file);
  if (port === null) {
    return { ok: false, issues: ["the host's TypeScript compiler could not read the module"] };
  }

  const issues: string[] = [];
  /** The parameters each generated tool may accept, by binding name — an action
   *  tool's input, and a read binding's share of the envelope tool's input. */
  const toolParameters = new Map<string, HostParameter[]>();
  /** One host binding placed in the wiring file, or the reason it cannot be.
   *  `calls` is the widest call the component makes, for a binding this port
   *  turns into a tool; undefined for a hole, which is never called at all. */
  const reference = async (binding: PortBinding, calls: number | undefined): Promise<WiringRef | undefined> => {
    const base = { name: binding.name, imported: binding.imported };
    // The package boundary the capture walk already draws: an npm component is
    // not the host's code, so the wiring names the package the host installed.
    if (await isPackageSpecifier(input.file, binding.specifier, input.root)) {
      return { ...base, from: binding.specifier };
    }
    const resolved = await resolveImportSource(input.file, binding.specifier, input.root, binding.imported);
    if (resolved === null) {
      issues.push(`it imports ${binding.name} from "${binding.specifier}", which does not resolve to source inside the host root`);
      return undefined;
    }
    const placed = { ...base, from: relativeSpecifier(input.generatedDir, resolved.file) };
    if (calls === undefined) return placed;

    const signature = hostSignature(resolved.source, resolved.file, binding.imported);
    // Reads and writes under ONE law: the tool's input is the host's own
    // declared parameters, exactly as wide as the component's widest call. For
    // a write those names are what the tool forwards; for a read they are the
    // allowlist the seed's live props are admitted against — either way, a
    // declaration this cannot narrow is a boundary this cannot write.
    if (signature === null || signature.parameters === null) {
      issues.push(`it binds ${binding.name}(…), whose declaration in "${binding.specifier}" could not be narrowed to a signature — a generated tool may only accept the host's own parameters, so one that cannot be read is not one this can wire`);
      return undefined;
    }
    const accepted = signature.parameters.slice(0, calls);
    if (signature.parameters.slice(calls).some((parameter) => parameter.required)) {
      issues.push(`it calls ${binding.name}() with ${calls} argument(s) but the host declares more required parameters — a generated tool must carry the original call's shape, and this call cannot satisfy the function it names`);
      return undefined;
    }
    toolParameters.set(binding.name, accepted);
    // A READ that is a hook is the normal case, not a failure: the port keeps
    // calling it, and the tool binds the FETCH underneath it. A hook that
    // resolves to no fetch — `useContext(…)` has none — is still refused.
    if (signature.hook) {
      const read = readSourceOf(resolved.source, resolved.file, binding.imported);
      if (read === null) {
        issues.push(`it binds ${binding.name}(…), a React hook this cannot see a fetch through — the generated tool runs on the server, where the hook itself would throw. Read with a hook that wraps a fetch, or leave this component un-remixable`);
        return undefined;
      }
      const target = await resolveImportSource(resolved.file, read.specifier, input.root, read.imported);
      if (target === null) {
        issues.push(`it binds ${binding.name}(…), whose fetch comes from "${read.specifier}" — a module that does not resolve to source inside the host root`);
        return undefined;
      }
      return {
        name: binding.name,
        imported: read.imported,
        from: relativeSpecifier(input.generatedDir, target.file),
        ...(read.member === undefined ? {} : { member: read.member }),
        ...(read.key === undefined ? {} : { key: read.key }),
      };
    }
    return placed;
  };

  // A read's `useQuery` input is a literal resolved before the component
  // renders, so the call site's arguments cannot ride the source — the tool
  // DECLARES them instead, and the seed's live props answer them server-side.
  const readBindings = await Promise.all((port.read?.bindings ?? []).map((binding) => reference(binding, binding.arity)));
  const writes = await Promise.all(port.writes.map(async ({ tool, binding, arity }) => {
    const placed = await reference(binding, arity);
    return placed === undefined ? undefined : { tool, binding: placed };
  }));
  const holes = await Promise.all(port.holes.map((binding) => reference(binding, undefined)));
  // One envelope tool serves every read binding, so its input is the UNION of
  // their declared parameters. One name declared with two types is an input
  // that tool cannot carry, and it is refused by name.
  const readParameters: HostParameter[] = [];
  for (const binding of port.read?.bindings ?? []) {
    for (const parameter of toolParameters.get(binding.name) ?? []) {
      const already = readParameters.find((entry) => entry.name === parameter.name);
      if (already === undefined) readParameters.push(parameter);
      else if (already.schema.type !== parameter.schema.type) {
        issues.push(`its hooks declare "${parameter.name}" as both ${already.schema.type} and ${parameter.schema.type} — one envelope tool serves every read, and its input cannot carry one name with two types`);
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const source = renderPort(port, new Map(
    [...toolParameters].map(([name, parameters]) => [name, parameters.map((parameter) => parameter.name)]),
  ), [...(carved.button ? ["Button"] : []), ...carved.holes]);
  const hostTools = [
    ...(port.read === undefined ? [] : [{ name: port.read.tool, description: readToolDescription(input.slot), risk: "read" }]),
    ...port.writes.map(({ tool, binding }) =>
      ({ name: tool, description: writeToolDescription(input.slot, binding.name), risk: "write" })),
  ];
  const check = await checkComponentScreen({
    ...PORTED_SCREEN_DIALECT,
    source,
    hostTools,
    // The catalog the RUNTIME will have for this screen: the names the wiring
    // file registers as holes — the host's imports and the carver's cuts — plus
    // the Kit Button when a host <button> was rewritten to it. Assembled here
    // and emitted there from the same list, so sync cannot bless a name the
    // floor has never heard of.
    catalog: [...port.holes.map((hole) => hole.name), ...carved.holes, ...(carved.button ? ["Button"] : [])],
    // Sync holds no host data — the tools it just generated are answered by the
    // host's own session at render time, and there is no session here. So the
    // grade runs the port against the answer every one of them really gives on
    // its first paint: none. A port that cannot draw itself empty is a port an
    // end user would meet mid-crash.
    runQuery: async () => null,
    // The host's own declared sample props, when the registration carries
    // them — the same values the runtime floor will grade this port with.
    ...(input.sampleProps === undefined ? {} : { props: input.sampleProps }),
  });
  if (!check.ok) return { ok: false, issues: check.issues.map((issue) => issue.message) };

  return {
    ok: true,
    port: {
      source,
      tools: [...(port.read === undefined ? [] : [port.read.tool]), ...port.writes.map(({ tool }) => tool)],
      holes: [...port.holes.map((hole) => hole.name), ...carved.holes],
    },
    wiring: {
      slot: input.slot,
      ...(port.read === undefined ? {} : {
        read: { tool: port.read.tool, bindings: readBindings as WiringRef[], parameters: readParameters },
      }),
      writes: (writes as Array<{ tool: string; binding: WiringRef }>).map((write) =>
        ({ ...write, parameters: toolParameters.get(write.binding.name) ?? [] })),
      holes: [
        ...holes as WiringRef[],
        ...carved.holes.map((name) => ({ name, imported: name, from: `./remix-holes/${input.slot}` })),
      ],
    },
    ...(carved.home === undefined ? {} : { home: carved.home }),
  };
}
