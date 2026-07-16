import { spawn } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  vendoThemeSchema,
} from "@vendoai/core";
import {
  toolsFileSchema,
  type ExtractedTool,
  type ToolsFile,
} from "@vendoai/actions";
import type { ZodError } from "zod";

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

interface AppRouterInfo {
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
const DESTRUCTIVE_NAME = /(^|_)(delete|remove|destroy|cancel|close|reset|revoke|purge|wipe)(_|$)/;

export function corpusHostCommandEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0",
    PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
  };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

function runShellCommand(command: string, options: StructuralCommandOptions): Promise<StructuralCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: corpusHostCommandEnv(options.env),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function findAppRouter(repoDir: string): Promise<AppRouterInfo | null> {
  for (const appDirRel of ["app", "src/app"] as const) {
    for (const name of ["layout.tsx", "layout.jsx", "layout.js"] as const) {
      const layoutRel = path.posix.join(appDirRel, name);
      if (await exists(path.join(repoDir, layoutRel))) {
        return {
          appDirRel,
          layoutRel,
          ts: name.endsWith(".tsx") || await exists(path.join(repoDir, "tsconfig.json")),
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
    files.push("src/server/vendo.ts", "src/server/index.ts", "src/client/main.tsx");
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

async function checkExpectedFiles(ctx: StructuralLayerContext): Promise<StructuralCheckResult> {
  const framework = ctx.framework ?? "next";
  const { files, app } = await defaultExpectedFilesForFramework(ctx.repoDir, framework);
  const required = ctx.expectedFiles ?? files;
  const missing: string[] = [];

  for (const rel of required) {
    if (!await exists(path.join(ctx.repoDir, rel))) missing.push(rel);
  }

  const wiringProblems: string[] = [];
  if (!ctx.expectedFiles) {
    if (framework === "express") {
      const server = await sourceTreeText(ctx.repoDir, "src/server");
      const client = await sourceTreeText(ctx.repoDir, "src/client");
      if (!server.includes("@vendoai/vendo/server") || !server.includes("createVendo")) {
        wiringProblems.push("Express server sources do not compose createVendo from @vendoai/vendo/server");
      }
      if (!hasFunctionalExpressVendoMount(server)) {
        wiringProblems.push("Express server does not mount vendo.handler at /api/vendo");
      }
      if (!client.includes("<VendoRoot")) {
        wiringProblems.push("Express client sources do not render <VendoRoot");
      }
    } else if (!app) {
      wiringProblems.push("no App Router root layout found at app/layout.* or src/app/layout.*");
    } else {
      const layout = await readText(ctx.repoDir, app.layoutRel);
      const route = await readText(ctx.repoDir, routeRel(app));
      if (layout && (!layout.includes("@vendoai/vendo/react") || !layout.includes("<VendoRoot"))) {
        wiringProblems.push(`${app.layoutRel} does not wrap children with @vendoai/vendo/react VendoRoot`);
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
  const runner = ctx.commandRunner ?? runShellCommand;
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

/** A tRPC mutation is write-shaped exactly like a POST; a query like a GET. */
function effectiveWriteMethod(tool: ExtractedTool): string {
  if (tool.binding.kind === "trpc") return tool.binding.type === "query" ? "GET" : "POST";
  return tool.binding.method;
}

function isUnsafeAutoAllowed(tool: ExtractedTool): boolean {
  const method = effectiveWriteMethod(tool);
  if (WRITE_METHODS.has(method) && tool.risk === "read") return true;
  if ((method === "DELETE" || DESTRUCTIVE_NAME.test(tool.name)) && tool.risk !== "destructive") return true;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
