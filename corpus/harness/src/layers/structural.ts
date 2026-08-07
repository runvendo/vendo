import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type TS from "typescript";
import {
  vendoThemeSchema,
} from "@vendoai/core";
import {
  toolsFileSchema,
  type ExtractedTool,
  type ToolsFile,
} from "@vendoai/actions";
import type { ZodError } from "zod";
import { runHostCommand } from "../process.js";
import { errorMessage, pathExists } from "../util.js";

export type StructuralCheckId =
  | "init.exit"
  | "files.expected"
  | "config.schema"
  | "host.typecheck"
  | "host.build"
  | "init.idempotent"
  | "tools.fail-closed";

export interface StructuralCheckResult {
  id: StructuralCheckId;
  pass: boolean;
  status?: "skipped-baseline-broken" | "skipped-not-configured";
  detail: string;
}

export interface StructuralCommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface StructuralCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type StructuralCommandRunner = (
  command: string,
  options: StructuralCommandOptions,
) => Promise<StructuralCommandResult>;

export interface StructuralCommandSnapshot {
  command: string;
  result?: StructuralCommandResult;
  error?: string;
}

export interface StructuralHostBaseline {
  typecheck?: StructuralCommandSnapshot;
  build?: StructuralCommandSnapshot;
}

export interface StructuralLayerContext {
  repoDir: string;
  framework?: "next" | "express";
  initExitCode: number | null;
  initDetail?: string;
  secondInitExitCode?: number | null;
  secondRunDiff?: string;
  secondRunDetail?: string;
  secondRunNoop?: boolean;
  typecheckCommand?: string;
  buildCommand?: string;
  baseline?: StructuralHostBaseline;
  commandRunner?: StructuralCommandRunner;
  expectedFiles?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface AppRouterInfo {
  appDirRel: "app" | "src/app";
  layoutRel: string;
  ts: boolean;
}

const CHECK_ORDER: StructuralCheckId[] = [
  "init.exit",
  "files.expected",
  "config.schema",
  "host.typecheck",
  "host.build",
  "init.idempotent",
  "tools.fail-closed",
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The TypeScript compiler, resolved lazily and fail-closed (the same posture
// as packages/actions/src/sync/common.ts's loadCompiler): when it cannot be
// loaded, wiring analysis verifies nothing rather than guessing with string
// scans — the check fails, never passes.
let compilerModule: typeof TS | null | undefined;

function loadCompiler(): typeof TS | null {
  if (compilerModule === undefined) {
    try {
      compilerModule = createRequire(import.meta.url)("typescript") as typeof TS;
    } catch {
      compilerModule = null;
    }
  }
  return compilerModule;
}

interface BoundModule {
  ts: typeof TS;
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
}

/** A real single-file ts.Program (noResolve, in-memory host) so symbol
 * resolution rides TypeScript's own binder — the ground truth for JS scoping
 * (hoisted vars, parameter shadows, export bindings) — instead of any
 * hand-rolled scope walk. Imports stay unresolved on purpose: an identifier's
 * symbol still declares AT its ImportSpecifier, which carries the module
 * specifier — all the provenance the check needs. */
function boundModule(source: string, fileName: string): BoundModule | null {
  const ts = loadCompiler();
  if (!ts) return null;
  const kind = /\.[cm]?ts$/u.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const options: TS.CompilerOptions = {
    allowJs: true,
    noResolve: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    types: [],
  };
  const host: TS.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const bound = program.getSourceFile(fileName);
  if (bound === undefined) return null;
  return { ts, sf: bound, checker: program.getTypeChecker() };
}

/** The import binding (module specifier + IMPORTED name, aliases resolved
 * back) an identifier use resolves to via the binder — or null when the use
 * resolves to anything else (local, parameter, hoisted var, nothing). */
function importBindingOf(mod: BoundModule, use: TS.Identifier): { specifier: string; imported: string } | null {
  const { ts, checker } = mod;
  const symbol = checker.getSymbolAtLocation(use);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) return null;
  if (ts.isImportSpecifier(declaration)) {
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return null;
    return {
      specifier: importDeclaration.moduleSpecifier.text,
      imported: (declaration.propertyName ?? declaration.name).text,
    };
  }
  return null;
}
export async function findAppRouter(repoDir: string): Promise<AppRouterInfo | null> {
  for (const appDirRel of ["app", "src/app"] as const) {
    for (const name of ["layout.tsx", "layout.jsx", "layout.js"] as const) {
      const layoutRel = path.posix.join(appDirRel, name);
      if (await pathExists(path.join(repoDir, layoutRel))) {
        return {
          appDirRel,
          layoutRel,
          ts: name.endsWith(".tsx") || await pathExists(path.join(repoDir, "tsconfig.json")),
        };
      }
    }
  }
  return null;
}

function routeRel(info: AppRouterInfo): string {
  return path.posix.join(info.appDirRel, "api/vendo/[...vendo]", info.ts ? "route.ts" : "route.js");
}

function commandPassed(snapshot: StructuralCommandSnapshot): boolean {
  return snapshot.result?.code === 0 && !snapshot.error;
}

function commandStatus(result: StructuralCommandResult): string {
  return result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.code}`;
}

function describeSnapshot(snapshot: StructuralCommandSnapshot): string {
  if (snapshot.error) return `command failed to start: ${snapshot.error}`;
  if (!snapshot.result) return "command did not produce a result";
  if (snapshot.result.code === 0) return `succeeded: ${snapshot.command}`;
  return `failed with ${commandStatus(snapshot.result)}: ${trimOutput(snapshot.result.stderr || snapshot.result.stdout)}`;
}

async function readText(repoDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoDir, rel), "utf8");
  } catch {
    return null;
  }
}

/** Two valid Express wirings exist: the pre-wired shape (an app like
 * express-host that already composes createVendo in src/server + renders
 * VendoProvider in src/client) and the generated shape `vendo init` writes for
 * a real Express/Nest API host (vendo/server.ts|mjs; the client lives in a
 * separate frontend, so no VendoProvider requirement). */
async function expressShape(repoDir: string): Promise<"pre-wired" | "generated"> {
  return await pathExists(path.join(repoDir, "src/server/vendo.ts")) ? "pre-wired" : "generated";
}

async function generatedExpressServerRel(repoDir: string): Promise<string> {
  return await pathExists(path.join(repoDir, "vendo/server.mjs")) && !await pathExists(path.join(repoDir, "vendo/server.ts"))
    ? "vendo/server.mjs"
    : "vendo/server.ts";
}

async function defaultExpectedFilesForFramework(
  repoDir: string,
  framework: "next" | "express",
): Promise<{ files: string[]; app: AppRouterInfo | null }> {
  const app = await findAppRouter(repoDir);
  const files = [
    ".vendo/tools.json",
    ".vendo/overrides.json",
    ".vendo/policy.json",
    ".vendo/brief.md",
    ".vendo/theme.json",
    ".vendo/data/.gitignore",
  ];

  if (framework === "express") {
    if (await expressShape(repoDir) === "pre-wired") {
      files.push("src/server/vendo.ts", "src/server/index.ts", "src/client/main.tsx");
    } else {
      files.push(await generatedExpressServerRel(repoDir));
    }
  } else if (app) {
    files.push(routeRel(app), app.layoutRel);
  }

  return { files, app };
}

async function sourceTreeText(repoDir: string, rel: string): Promise<string> {
  const root = path.join(repoDir, rel);
  const parts: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    const entryRel = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      parts.push(await sourceTreeText(repoDir, entryRel));
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      parts.push(await readText(repoDir, entryRel) ?? "");
    }
  }
  return parts.join("\n");
}

async function checkInitExit(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  if (ctx.initExitCode === 0) {
    return { id: "init.exit", pass: true, detail: "vendo init exited 0" };
  }
  const code = ctx.initExitCode === null ? "no exit code" : `exit code ${ctx.initExitCode}`;
  return {
    id: "init.exit",
    pass: false,
    detail: `vendo init failed with ${code}${ctx.initDetail ? `: ${ctx.initDetail}` : ""}`,
  };
}

function hasFunctionalExpressVendoMount(server: string): boolean {
  const mount = /app\.use\(\s*["']\/api\/vendo["']\s*,\s*/g;
  for (const match of server.matchAll(mount)) {
    const mounted = server.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1_200);
    if (/^mountVendo\s*\(\s*\)/.test(mounted)) return true;
    if (/^vendo\.handler\s*\(/.test(mounted)) return true;
    if (/^(?:async\s*)?\([^)]*\)\s*=>[\s\S]{0,800}?\b(?:serve|adapt|handle)[\w$]*\s*\([^;]{0,800}?vendo\.handler\b/m.test(mounted)) {
      return true;
    }
  }
  return false;
}

/** The module specifiers this file imports a binding named VendoProvider from
 * (aliases irrelevant here — tag resolution is symbol-level). */
function vendoRootImportSpecifiers(mod: BoundModule): string[] {
  const { ts, sf } = mod;
  const specifiers: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "VendoProvider") {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }
  return specifiers;
}

/** True when a `{children}` JSX expression under `root` is a DESCENDANT of a
 * JSX element whose tag SYMBOL resolves (compiler binder) to an import
 * accepted by `accept` — AST containment plus real symbol resolution, so a
 * self-closing `<Tag />` beside `{children}`, children BETWEEN two sibling
 * providers, or any shadowing declaration (parameter, local, hoisted var)
 * never count as wrapped. */
function childrenInsideProvider(
  mod: BoundModule,
  accept: (binding: { specifier: string; imported: string }) => boolean,
  root: TS.Node = mod.sf,
): boolean {
  const { ts } = mod;
  let found = false;
  const visit = (node: TS.Node, insideTag: boolean): void => {
    if (found) return;
    let inside = insideTag;
    if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName)) {
      const binding = importBindingOf(mod, node.openingElement.tagName);
      if (binding !== null && accept(binding)) inside = true;
    }
    if (
      inside
      && ts.isJsxExpression(node)
      && node.expression !== undefined
      && ts.isIdentifier(node.expression)
      && node.expression.text === "children"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(root, false);
  return found;
}

/** The function node behind the module's EXPORT named `exportName`, resolved
 * through the module symbol's export table (so what the layout imports is
 * exactly what is analyzed — a non-exported helper that happens to wrap
 * children never stands in for the exported component). */
function exportedFunctionNode(mod: BoundModule, exportName: string): TS.Node | null {
  const { ts, sf, checker } = mod;
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  let exported = moduleSymbol?.exports?.get(ts.escapeLeadingUnderscores(exportName));
  if (exported !== undefined && (exported.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      exported = checker.getAliasedSymbol(exported);
    } catch {
      return null;
    }
  }
  const declaration = exported?.valueDeclaration ?? exported?.declarations?.[0];
  if (declaration === undefined) return null;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    let initializer: TS.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
      initializer = initializer.expression;
    }
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  }
  return null;
}

/** The layout wraps children with the @vendoai/vendo/react provider either
 * directly or through ONE wrapper hop: init generates no client file at all —
 * its printed paste (init.ts's mountStep) imports <VendoProvider> from the
 * package straight into the layout — but a host may still mount its own local
 * wrapper module instead.
 * "Wraps" means the `{children}` expression is an AST descendant of a JSX
 * element whose tag SYMBOL (TypeScript's own binder — hoisted vars,
 * parameter shadows, every scoping rule) resolves to the VendoProvider import;
 * and through the wrapper hop, the layout's imported EXPORT itself — never
 * some other function in the wrapper file — must nest its children inside
 * the package's VendoProvider. Fails closed when the TypeScript compiler is
 * unavailable.
 *
 * Precision boundary (conductor ruling + Yousef ruling, 2026-07-26):
 * symbol-correct import + nesting + direct JSX usage is the required depth.
 * Shapes beyond it are documented limitations of this check, not detected —
 * it is a drift detector for honest codebases, not a defense against
 * adversarial hosts:
 * - eval/require-time indirection, dynamic component maps, runtime
 *   re-assignment;
 * - render-graph reachability: a provider element inside a component that
 *   is imported but never actually rendered by the route tree. */
async function layoutReachesVendoReact(repoDir: string, app: AppRouterInfo, layout: string): Promise<boolean> {
  const layoutModule = boundModule(layout, app.layoutRel);
  if (layoutModule === null) return false;
  const packageBinding = (binding: { specifier: string; imported: string }): boolean =>
    binding.imported === "VendoProvider" && binding.specifier === "@vendoai/vendo/react";
  for (const specifier of vendoRootImportSpecifiers(layoutModule)) {
    const fromThisImport = (binding: { specifier: string; imported: string }): boolean =>
      binding.imported === "VendoProvider" && binding.specifier === specifier;
    if (!childrenInsideProvider(layoutModule, fromThisImport)) continue;
    if (specifier === "@vendoai/vendo/react") return true;
    if (!specifier.startsWith(".")) continue;
    const base = path.posix.join(path.posix.dirname(app.layoutRel), specifier);
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`]) {
      const source = await readText(repoDir, candidate);
      if (source === null) continue;
      const wrapperModule = boundModule(source, candidate);
      if (wrapperModule === null) continue;
      const exportedComponent = exportedFunctionNode(wrapperModule, "VendoProvider");
      if (exportedComponent === null) continue;
      if (childrenInsideProvider(wrapperModule, packageBinding, exportedComponent)) return true;
    }
  }
  return false;
}

async function checkExpectedFiles(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  const framework = ctx.framework ?? "next";
  const { files, app } = await defaultExpectedFilesForFramework(ctx.repoDir, framework);
  const required = ctx.expectedFiles ?? files;
  const missing: string[] = [];

  for (const rel of required) {
    if (!await pathExists(path.join(ctx.repoDir, rel))) missing.push(rel);
  }

  const wiringProblems: string[] = [];
  if (!ctx.expectedFiles) {
    if (framework === "express") {
      if (await expressShape(ctx.repoDir) === "pre-wired") {
        const server = await sourceTreeText(ctx.repoDir, "src/server");
        const client = await sourceTreeText(ctx.repoDir, "src/client");
        if (!server.includes("@vendoai/vendo/server") || !server.includes("createVendo")) {
          wiringProblems.push("Express server sources do not compose createVendo from @vendoai/vendo/server");
        }
        if (!hasFunctionalExpressVendoMount(server)) {
          wiringProblems.push("Express server does not mount vendo.handler at /api/vendo");
        }
        if (!client.includes("<VendoProvider")) {
          wiringProblems.push("Express client sources do not render <VendoProvider");
        }
      } else {
        const server = await readText(ctx.repoDir, await generatedExpressServerRel(ctx.repoDir));
        if (server !== null && (!server.includes("@vendoai/vendo/server") || !server.includes("createVendo"))) {
          wiringProblems.push("generated vendo/server module does not compose createVendo from @vendoai/vendo/server");
        }
      }
    } else if (!app) {
      wiringProblems.push("no App Router root layout found at app/layout.* or src/app/layout.*");
    } else {
      const layout = await readText(ctx.repoDir, app.layoutRel);
      const route = await readText(ctx.repoDir, routeRel(app));
      if (layout && !await layoutReachesVendoReact(ctx.repoDir, app, layout)) {
        wiringProblems.push(`${app.layoutRel} does not wrap children with @vendoai/vendo/react VendoProvider (directly or via a local provider wrapper module)`);
      }
      if (route && (!route.includes("createVendo") || !route.includes("nextVendoHandler"))) {
        wiringProblems.push(`${routeRel(app)} does not compose createVendo() with nextVendoHandler()`);
      }
    }
  }

  if (missing.length === 0 && wiringProblems.length === 0) {
    return {
      id: "files.expected",
      pass: true,
      detail: `found ${required.length} generated files plus v0 ${framework === "express" ? "Express handler/provider" : "Next route/provider"} wiring`,
    };
  }

  return {
    id: "files.expected",
    pass: false,
    detail: [...missing.map((rel) => `missing ${rel}`), ...wiringProblems].join("; "),
  };
}

async function readJsonFile(repoDir: string, rel: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const full = path.join(repoDir, rel);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch (err) {
    return { ok: false, error: `${rel} could not be read: ${errorMessage(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `${rel} is not valid JSON: ${errorMessage(err)}` };
  }
}

function zodSummary(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

async function parseToolsManifest(repoDir: string): Promise<{ ok: true; manifest: ToolsFile } | { ok: false; error: string }> {
  const tools = await readJsonFile(repoDir, ".vendo/tools.json");
  if (!tools.ok) return { ok: false, error: tools.error };
  const parsed = toolsFileSchema.safeParse(tools.value);
  if (!parsed.success) {
    return { ok: false, error: `.vendo/tools.json schema error: ${zodSummary(parsed.error)}` };
  }
  return { ok: true, manifest: parsed.data };
}

async function checkConfigSchema(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  const failures: string[] = [];
  const theme = await readJsonFile(ctx.repoDir, ".vendo/theme.json");
  if (!theme.ok) {
    failures.push(theme.error);
  } else {
    const parsed = vendoThemeSchema.safeParse(theme.value);
    if (!parsed.success) failures.push(`.vendo/theme.json schema error: ${zodSummary(parsed.error)}`);
  }

  const tools = await parseToolsManifest(ctx.repoDir);
  if (!tools.ok) failures.push(tools.error);

  if (failures.length > 0) {
    return { id: "config.schema", pass: false, detail: failures.join("; ") };
  }
  return { id: "config.schema", pass: true, detail: ".vendo/theme.json and .vendo/tools.json match exported schemas" };
}

async function checkCommand(
  id: "host.typecheck" | "host.build",
  label: string,
  command: string | undefined,
  ctx: StructuralLayerContext,
): Promise<StructuralCheckResult> {
  if (!command) {
    if (id === "host.typecheck") {
      return {
        id,
        pass: true,
        status: "skipped-not-configured",
        detail: "typecheck skipped-not-configured; no manifest typecheckCommand was provided and no package.json typecheck script was auto-detected",
      };
    }
    return { id, pass: false, detail: `no ${label} command was provided` };
  }
  const baseline = id === "host.typecheck" ? ctx.baseline?.typecheck : ctx.baseline?.build;
  const runner = ctx.commandRunner ?? runHostCommand;
  try {
    const result = await runner(command, { cwd: ctx.repoDir, env: ctx.env });
    if (baseline && !commandPassed(baseline)) {
      return {
        id,
        pass: true,
        status: "skipped-baseline-broken",
        detail: `${label} skipped-baseline-broken; baseline before vendo init ${describeSnapshot(baseline)}; post-init ${describeSnapshot({ command, result })}`,
      };
    }
    if (result.code === 0) {
      return {
        id,
        pass: true,
        detail: baseline
          ? `${label} command succeeded before and after vendo init: ${command}`
          : `${label} command succeeded: ${command}`,
      };
    }
    return {
      id,
      pass: false,
      detail: baseline && commandPassed(baseline)
        ? `${label} regressed after vendo init; baseline succeeded but post-init failed with ${commandStatus(result)}: ${trimOutput(result.stderr || result.stdout)}`
        : `${label} command failed with ${commandStatus(result)}: ${trimOutput(result.stderr || result.stdout)}`,
    };
  } catch (err) {
    if (baseline && !commandPassed(baseline)) {
      return {
        id,
        pass: true,
        status: "skipped-baseline-broken",
        detail: `${label} skipped-baseline-broken; baseline before vendo init ${describeSnapshot(baseline)}; post-init command failed to start: ${errorMessage(err)}`,
      };
    }
    return { id, pass: false, detail: `${label} command failed: ${errorMessage(err)}` };
  }
}

async function checkIdempotency(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  if (ctx.secondRunNoop === true) {
    return { id: "init.idempotent", pass: true, detail: "second init explicitly reported an idempotent no-op" };
  }
  const diff = ctx.secondRunDiff;
  const exitOk = ctx.secondInitExitCode === undefined || ctx.secondInitExitCode === 0;
  if (diff !== undefined && diff.trim() === "" && exitOk) {
    return { id: "init.idempotent", pass: true, detail: "second init left an empty git diff" };
  }
  const detail = ctx.secondRunDetail ?? "";
  if (ctx.secondInitExitCode === 0 && /idempotent|no changes|already (?:up[- ]to[- ]date|wired|initialized)/i.test(detail)) {
    return { id: "init.idempotent", pass: true, detail: `second init reported idempotent success: ${trimOutput(detail)}` };
  }
  const pieces = [
    ctx.secondInitExitCode === undefined ? "second init exit code was not provided" : `second init exit code ${ctx.secondInitExitCode}`,
    diff === undefined ? "second init diff was not provided" : `second init diff:\n${trimOutput(diff)}`,
  ];
  return { id: "init.idempotent", pass: false, detail: pieces.join("; ") };
}

/** A tRPC mutation is write-shaped exactly like a POST; a query like a GET;
 * a server action is always POST-shaped. */
function effectiveWriteMethod(tool: ExtractedTool): string {
  if (tool.binding.kind === "trpc") {
    return tool.binding.type === "query" ? "GET" : "POST";
  }
  if (tool.binding.kind === "server-action") return "POST";
  return tool.binding.method;
}

/** Fail-closed against PROTOCOL FACTS only (risk-grading redesign D1: a tool
 * NAME grades nothing). `ungraded` is never auto-allowed — the guard asks on
 * it — so two defects remain: a write-capable method that landed `read`, and
 * a DELETE that is not `destructive`. */
function isUnsafeAutoAllowed(tool: ExtractedTool): boolean {
  const method = effectiveWriteMethod(tool);
  if (WRITE_METHODS.has(method) && tool.risk === "read") return true;
  if (method === "DELETE" && tool.risk !== "destructive") return true;
  return false;
}

async function checkFailClosedTools(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  const tools = await parseToolsManifest(ctx.repoDir);
  if (!tools.ok) return { id: "tools.fail-closed", pass: false, detail: tools.error };

  const unsafe = tools.manifest.tools.filter(isUnsafeAutoAllowed);
  if (unsafe.length === 0) {
    return {
      id: "tools.fail-closed",
      pass: true,
      detail: `${tools.manifest.tools.length} tools keep write-capable actions fail-closed`,
    };
  }
  return {
    id: "tools.fail-closed",
    pass: false,
    detail: `write-capable tools are auto-allowed: ${unsafe.map((tool) => tool.name).join(", ")}`,
  };
}

function trimOutput(output: string, max = 500): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

async function safeCheck(
  id: StructuralCheckId,
  check: () => Promise<StructuralCheckResult>,
): Promise<StructuralCheckResult> {
  try {
    return await check();
  } catch (err) {
    return { id, pass: false, detail: `check threw unexpectedly: ${errorMessage(err)}` };
  }
}

export async function runStructuralLayer(ctx: StructuralLayerContext): Promise<StructuralCheckResult[]> {
  const checks: Record<StructuralCheckId, () => Promise<StructuralCheckResult>> = {
    "init.exit": () => checkInitExit(ctx),
    "files.expected": () => checkExpectedFiles(ctx),
    "config.schema": () => checkConfigSchema(ctx),
    "host.typecheck": () => checkCommand("host.typecheck", "typecheck", ctx.typecheckCommand, ctx),
    "host.build": () => checkCommand("host.build", "build", ctx.buildCommand, ctx),
    "init.idempotent": () => checkIdempotency(ctx),
    "tools.fail-closed": () => checkFailClosedTools(ctx),
  };
  const results: StructuralCheckResult[] = [];
  for (const id of CHECK_ORDER) {
    results.push(await safeCheck(id, checks[id]));
  }
  return results;
}
