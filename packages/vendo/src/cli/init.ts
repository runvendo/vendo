import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { vendoSync, type ExtractedTool, type OverridesFile } from "@vendoai/actions";
import type { VendoTheme } from "@vendoai/core";
import type { Telemetry } from "@vendoai/telemetry";
import { detectFramework, detectVendoWiring, type HostFramework } from "./framework.js";
import { extractTheme as extractThemeSlots } from "./theme/extract-theme.js";
import {
  consoleOutput,
  errorClass,
  exists,
  readOptional,
  toolingTelemetry,
  type Output,
  writeText,
} from "./shared.js";

const DEFAULT_RADIUS = { small: "4px", large: "12px" } as const;

async function extractTheme(root: string): Promise<VendoTheme> {
  const { slots } = await extractThemeSlots(root);
  const deriveRadius = (factor: number, fallback: string): string => {
    const value = slots.radius.match(/^(\d+(?:\.\d+)?)px$/)?.[1];
    return value === undefined ? fallback : `${Number(value) * factor}px`;
  };
  return {
    colors: {
      background: slots.background,
      surface: slots.surface,
      text: slots.text,
      muted: slots.mutedText,
      accent: slots.accent,
      accentText: slots.accentText,
      danger: slots.danger,
      border: slots.border,
    },
    typography: {
      fontFamily: slots.fontFamily,
      headingFamily: slots.headingFamily,
      baseSize: slots.baseSize,
    },
    radius: {
      small: deriveRadius(0.5, DEFAULT_RADIUS.small),
      medium: slots.radius,
      large: deriveRadius(1.5, DEFAULT_RADIUS.large),
    },
    density: slots.density,
    motion: slots.motion,
  };
}

export interface InitQuestion {
  id: "modelImport" | "brief" | "risk" | "mcp";
  question: string;
  recommendation: string;
}

export interface RiskRecommendation {
  tool: string;
  risk: ExtractedTool["risk"];
  recommendation: string;
}

export interface InitPlan {
  framework: HostFramework;
  root: string;
  writes: string[];
  codeChanges: Array<{ path: string; diff: string }>;
  questions: InitQuestion[];
  /** --agent only: deterministic extraction results, so an agent can answer the
      risk question from real tool names instead of re-deriving them. */
  extraction?: { tools: ExtractedTool[]; warnings: string[] };
  riskRecommendations?: RiskRecommendation[];
}

export interface InitOptions {
  targetDir: string;
  agent?: boolean;
  yes?: boolean;
  force?: boolean;
  modelImport?: string;
  brief?: string;
  output?: Output;
  confirm?: (change: { path: string; diff: string }) => Promise<boolean>;
  interview?: (questions: InitQuestion[]) => Promise<{
    modelImport?: string;
    brief?: string;
    criticalTools?: string[];
    openDoor?: boolean;
  }>;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
}

async function appDirectory(root: string): Promise<string> {
  if (await exists(join(root, "src", "app"))) return join(root, "src", "app");
  return join(root, "app");
}

function routeSource(modelImport: string): string {
  return `import { model } from ${JSON.stringify(modelImport)};\n` +
    `import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";\n\n` +
    `const vendo = createVendo({\n` +
    `  model,\n` +
    `  principal: async () => null,\n` +
    `});\n\n` +
    `export const { GET, POST, DELETE } = nextVendoHandler(vendo);\n`;
}

function wellKnownRouteSource(): string {
  return `import { GET as handleVendo } from "../../api/vendo/[...vendo]/route";\n\n` +
    `const DOOR_PATHS = new Set([\n` +
    `  "/.well-known/oauth-protected-resource/api/vendo/mcp",\n` +
    `  "/.well-known/oauth-authorization-server/api/vendo/mcp",\n` +
    `  "/.well-known/mcp/server-card.json",\n` +
    `  "/.well-known/mcp-server-card",\n` +
    `]);\n\n` +
    `const forward = (request: Request) =>\n` +
    `  DOOR_PATHS.has(new URL(request.url).pathname)\n` +
    `    ? handleVendo(request)\n` +
    `    : new Response(null, { status: 404 });\n\n` +
    `export const GET = forward;\n` +
    `export const POST = forward;\n`;
}

function expressServerSource(modelImport: string, typescript: boolean): string {
  const imports = typescript
    ? `import { once } from "node:events";\n` +
      `import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";\n` +
      `import { Readable } from "node:stream";\n`
    : `import { once } from "node:events";\n` +
      `import { Readable } from "node:stream";\n`;
  const types = typescript
    ? `\ntype ExpressRequest = IncomingMessage & { originalUrl?: string };\n` +
      `type ExpressNext = (error?: unknown) => void;\n`
    : "";
  const signatures = typescript
    ? {
        requestHeaders: `(headers: IncomingHttpHeaders): Headers`,
        absoluteUrl: `(request: ExpressRequest): string`,
        sendResponse: `(source: Response, target: ServerResponse): Promise<void>`,
        handle: `(request: ExpressRequest, response: ServerResponse): Promise<void>`,
        mountReturn: `: (request: ExpressRequest, response: ServerResponse, next: ExpressNext) => void`,
      }
    : { requestHeaders: "(headers)", absoluteUrl: "(request)", sendResponse: "(source, target)", handle: "(request, response)", mountReturn: "" };
  const requestInit = typescript
    ? `  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(request.headers) };\n`
    : `  const init = { method, headers: requestHeaders(request.headers) };\n`;
  const body = typescript
    ? `    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;\n`
    : `    init.body = Readable.toWeb(request);\n`;

  // The client-entry hint mirrors the host's language: the TS variant needs the
  // VendoTheme cast (JSON-module literals widen to string), the JS variant must
  // not show type-only syntax a JavaScript host cannot paste.
  const clientHint = typescript
    ? ` *   // in the client entry — theme.json adopts the host brand (08 §4);\n` +
      ` *   // the cast narrows TypeScript's widened JSON-module string literals:\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   import type { VendoTheme } from "@vendoai/vendo";\n` +
      ` *   root.render(<VendoRoot theme={theme as VendoTheme}><App /></VendoRoot>);\n`
    : ` *   // in the client entry — theme.json adopts the host brand (08 §4):\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   root.render(<VendoRoot theme={theme}><App /></VendoRoot>);\n`;

  return `/**\n` +
    ` * Add these wiring lines in your host:\n` +
    ` *   app.use("/api/vendo", mountVendo());\n` +
    clientHint +
    ` */\n` +
    imports +
    `import { model } from ${JSON.stringify(modelImport)};\n` +
    `import { createVendo } from "@vendoai/vendo/server";\n` +
    types +
    `\nconst vendo = createVendo({\n` +
    `  model,\n` +
    `  principal: async () => null,\n` +
    `});\n\n` +
    `function requestHeaders${signatures.requestHeaders} {\n` +
    `  const result = new Headers();\n` +
    `  for (const [name, value] of Object.entries(headers)) {\n` +
    `    if (Array.isArray(value)) for (const item of value) result.append(name, item);\n` +
    `    else if (value !== undefined) result.set(name, value);\n` +
    `  }\n` +
    `  return result;\n` +
    `}\n\n` +
    `function absoluteUrl${signatures.absoluteUrl} {\n` +
    `  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;\n` +
    `  const protocol = encrypted ? "https" : "http";\n` +
    `  const host = request.headers.host ?? "localhost";\n` +
    `  // Behind a trusted proxy, set VENDO_BASE_URL explicitly or validate forwarded headers in the host.\n` +
    `  return new URL(request.originalUrl ?? request.url ?? "/", \`${"${protocol}"}://${"${host}"}\`).href;\n` +
    `}\n\n` +
    `async function sendResponse${signatures.sendResponse} {\n` +
    `  target.statusCode = source.status;\n` +
    `  source.headers.forEach((value, name) => {\n` +
    `    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);\n` +
    `  });\n` +
    `  const getSetCookie = (source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;\n` +
    `  const fallbackCookie = source.headers.get("set-cookie");\n` +
    `  const cookies = typeof getSetCookie === "function"\n` +
    `    ? getSetCookie.call(source.headers)\n` +
    `    : fallbackCookie === null ? [] : [fallbackCookie];\n` +
    `  if (cookies.length > 0) target.setHeader("set-cookie", cookies);\n` +
    `  if (source.body === null) {\n` +
    `    target.end();\n` +
    `    return;\n` +
    `  }\n` +
    `  target.flushHeaders();\n` +
    `  const reader = source.body.getReader();\n` +
    `  try {\n` +
    `    while (true) {\n` +
    `      const chunk = await reader.read();\n` +
    `      if (chunk.done) break;\n` +
    `      if (!target.write(chunk.value)) await once(target, "drain");\n` +
    `    }\n` +
    `    target.end();\n` +
    `  } finally {\n` +
    `    reader.releaseLock();\n` +
    `  }\n` +
    `}\n\n` +
    `async function handle${signatures.handle} {\n` +
    `  const method = request.method ?? "GET";\n` +
    requestInit +
    `  if (method !== "GET" && method !== "HEAD") {\n` +
    body +
    `    init.duplex = "half";\n` +
    `  }\n` +
    `  await sendResponse(await vendo.handler(new Request(absoluteUrl(request), init)), response);\n` +
    `}\n\n` +
    `export function mountVendo()${signatures.mountReturn} {\n` +
    `  return (request, response, next) => {\n` +
    `    void handle(request, response).catch(next);\n` +
    `  };\n` +
    `}\n`;
}

function defaultModelSource(): string {
  return `import { createAnthropic } from "@ai-sdk/anthropic";\n\n` +
    `// vendo init starter: swap for any ai-SDK provider (BYO-LLM, 09 §2).\n` +
    `const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n` +
    `export const model = anthropic("claude-sonnet-4-6");\n`;
}

/** Resolve an `@/`-style model import to a candidate file the scaffold owns.
    Anything else (a package, a relative path) is the host's own module. */
async function modelModuleCandidate(root: string, appDir: string, modelImport: string): Promise<string | null> {
  if (!modelImport.startsWith("@/")) return null;
  const suffix = `${modelImport.slice(2)}.ts`;
  // Honor the project's actual alias if tsconfig/jsconfig declares one for `@/*`
  // — guessing src/ vs root would scaffold the file where TypeScript won't
  // resolve the generated import. Fall back to the Next convention only when no
  // config maps it (the alias root follows the app dir: src/app → src, else root).
  const mapped = await tsconfigAliasRoot(root);
  const aliasRoot = mapped ?? (appDir.endsWith(join("src", "app")) ? join(root, "src") : root);
  return join(aliasRoot, suffix);
}

/** Resolve the `baseUrl`-relative directory that `@/*` maps to in the nearest
    tsconfig/jsconfig (following one `extends`); null when unmapped. */
async function tsconfigAliasRoot(root: string): Promise<string | null> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const raw = await readOptional(join(root, file));
    if (raw === null) continue;
    try {
      const config = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const target = config.compilerOptions?.paths?.["@/*"]?.[0];
      if (typeof target !== "string" || !target.endsWith("/*")) continue;
      const baseUrl = config.compilerOptions?.baseUrl ?? ".";
      return join(root, baseUrl, target.slice(0, -2));
    } catch {
      // Malformed config — fall through to the convention.
    }
  }
  return null;
}

// 08 §4 / 09 §4: the scaffold imports the sync-extracted theme.json and passes it
// to VendoRoot so a fresh install adopts the host brand at the wow moment — no
// flash of neutral chrome. theme.json is a BUILD artifact (sync regenerates it),
// so baking it at build time is doctrinally consistent. `specifier === null`
// degrades to bare wiring when the theme import cannot resolve (resolveJsonModule
// off) — see themeImportSpecifier. The `as VendoTheme` cast is load-bearing:
// TypeScript widens JSON-module string literals, so the import is typed
// `{ density: string; ... }` — not assignable to `Partial<VendoTheme>`
// (`density?: "compact" | "comfortable"`); without the cast every strict host
// fails `next build`. VendoTheme comes off the umbrella root (not /react).
function themeWiring(specifier: string | null): { importLine: string; prop: string } {
  return specifier === null
    ? { importLine: "", prop: "" }
    : {
        importLine: `import theme from ${JSON.stringify(specifier)};\n` +
          `import type { VendoTheme } from "@vendoai/vendo";\n`,
        prop: " theme={theme as VendoTheme}",
      };
}

function defaultLayoutSource(themeSpecifier: string | null): string {
  const theme = themeWiring(themeSpecifier);
  return `import { VendoRoot } from "@vendoai/vendo/react";\n` +
    theme.importLine +
    `import type { ReactNode } from "react";\n\n` +
    `export default function RootLayout({ children }: { children: ReactNode }) {\n` +
    `  return <html><body><VendoRoot${theme.prop}>{children}</VendoRoot></body></html>;\n` +
    `}\n`;
}

function wireLayout(source: string, themeSpecifier: string | null): string | null {
  if (source.includes("<VendoRoot") || source.includes("from \"@vendoai/vendo/react\"")) return source;
  const theme = themeWiring(themeSpecifier);
  const importLine = `import { VendoRoot } from "@vendoai/vendo/react";\n${theme.importLine}`;
  const open = `<VendoRoot${theme.prop}>`;
  const directive = source.match(/^(["']use (?:client|server)["'];?\s*)/);
  const prefix = directive?.[1] ?? "";
  const withImport = (body: string): string =>
    prefix.length === 0 ? `${importLine}${body}` : `${prefix}${importLine}${body.slice(prefix.length)}`;

  const childMatches = source.match(/\{children\}/g)?.length ?? 0;
  if (childMatches === 1) {
    return withImport(source).replace("{children}", `${open}{children}</VendoRoot>`);
  }
  // A layout that returns the bare `children` (a valid Next pattern, e.g.
  // `return children;`) has no {children} JSX slot to wrap — rewrite the return.
  const bareReturn = /(\breturn\s*\(?\s*)children(\s*\)?\s*;)/;
  if (childMatches === 0 && bareReturn.test(source)) {
    return withImport(source).replace(bareReturn, `$1${open}{children}</VendoRoot>$2`);
  }
  return null;
}

/** Relative, posix-style import specifier from the layout's directory to the
    project-root `.vendo/theme.json` — NOT the `@/` alias (its root is often
    src/ while .vendo sits at the project root). Returns null when the project
    EXPLICITLY disables resolveJsonModule, so we degrade to bare VendoRoot wiring
    instead of scaffolding an import that will not compile. runInit always writes
    theme.json (writeIfMissing) before any code change applies, so the specifier
    always resolves at build time — no exists() gate needed on the normal path. */
async function themeImportSpecifier(root: string, layoutDir: string): Promise<string | null> {
  if (await resolveJsonModuleDisabled(root)) return null;
  const themeJson = join(root, ".vendo", "theme.json");
  return relative(layoutDir, themeJson).split(sep).join("/");
}

/** True only when tsconfig/jsconfig EXPLICITLY sets
    `compilerOptions.resolveJsonModule === false` — the one case where importing
    theme.json breaks the build. Next's default (and demo hosts) leave it on.
    Reads the project's own config only (no `extends` follow — matches
    tsconfigAliasRoot's actual behavior); a JSONC config with comments fails
    JSON.parse and is treated as the safe default (enabled). */
async function resolveJsonModuleDisabled(root: string): Promise<boolean> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const raw = await readOptional(join(root, file));
    if (raw === null) continue;
    try {
      const config = JSON.parse(raw) as { compilerOptions?: { resolveJsonModule?: boolean } };
      if (config.compilerOptions?.resolveJsonModule === false) return true;
    } catch {
      // Malformed config — assume the default (enabled).
    }
  }
  return false;
}

function diff(path: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.trimEnd().split("\n");
  const newLines = after.trimEnd().split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function packageWithSyncHooks(raw: string): string | null {
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const priorScripts = manifest["scripts"];
  const scripts = typeof priorScripts === "object" && priorScripts !== null && !Array.isArray(priorScripts)
    ? priorScripts as Record<string, unknown>
    : {};
  let changed = false;
  const hook = (name: "predev" | "prebuild", command: string): void => {
    const prior = scripts[name];
    if (typeof prior !== "string") {
      scripts[name] = command;
      changed = true;
    } else if (!prior.includes(command)) {
      scripts[name] = `${command} && ${prior}`;
      changed = true;
    }
  };
  hook("predev", "vendo sync");
  hook("prebuild", "vendo sync --strict");
  if (!changed) return null;
  manifest["scripts"] = scripts;

  const detectedIndent = raw.match(/^[\t ]+(?=")/m)?.[0] ?? "  ";
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(manifest, null, detectedIndent)}${trailingNewline}`;
}

/** Read-only extraction for the agent plan. vendoSync writes its artifacts, so
    it runs against a throwaway out dir — the host tree stays untouched (the
    --agent contract). Existing overrides ride along so the plan reflects prior
    human risk decisions, mirroring vendoSync's own merge semantics. */
async function extractForPlan(root: string): Promise<{ tools: ExtractedTool[]; warnings: string[] }> {
  const out = await mkdtemp(join(tmpdir(), "vendo-agent-plan-"));
  try {
    const overridesRaw = await readOptional(join(root, ".vendo", "overrides.json"));
    if (overridesRaw !== null) await writeText(join(out, "overrides.json"), overridesRaw);
    const report = await vendoSync({ root, out });
    const file = JSON.parse(await readFile(join(out, "tools.json"), "utf8")) as { tools?: ExtractedTool[] };
    let overrides: OverridesFile | null = null;
    try {
      overrides = overridesRaw === null ? null : JSON.parse(overridesRaw) as OverridesFile;
    } catch {
      // vendoSync already validated the copy; an unreadable original merges as absent.
    }
    const tools = (file.tools ?? []).map((tool) => {
      const override = overrides?.tools[tool.name];
      return override === undefined
        ? tool
        : { ...tool, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) };
    });
    return { tools, warnings: report.warnings };
  } catch (error) {
    // The plan must always emit — extraction failures degrade to a warning.
    return { tools: [], warnings: [`extraction failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** 04-actions §1 risk ladder projected as advice: destructive asks first,
    writes get reviewed, reads auto-run (no entry). */
function riskRecommendations(tools: ExtractedTool[]): RiskRecommendation[] {
  return tools.flatMap((tool) => {
    if (tool.disabled === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "extracted disabled (unclassifiable); enable it deliberately in .vendo/overrides.json after review" }];
    }
    if (tool.critical === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "already marked critical in .vendo/overrides.json; policy asks before running it" }];
    }
    if (tool.risk === "destructive") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "irreversible; mark it critical in .vendo/overrides.json so policy asks first" }];
    }
    if (tool.risk === "write") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "writes host data; review it and mark critical in .vendo/overrides.json when irreversible" }];
    }
    return [];
  });
}

/** The packaged vendo-setup skill (shipped in the npm tarball next to dist/).
    Resolved relative to this module so src (tests) and dist (published bin)
    agree; a missing file degrades to not offering the skill. */
async function setupSkillSource(): Promise<string | null> {
  try {
    return await readFile(new URL("../../skills/vendo-setup/SKILL.md", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

async function buildPlan(options: InitOptions, mcpEnabled = false): Promise<{ plan: InitPlan; changes: Array<{ absolute: string; path: string; before: string | null; after: string; diff: string }> }> {
  const root = resolve(options.targetDir);
  const framework = await detectFramework(root);
  const modelImport = options.modelImport ?? (framework === "express" ? "./ai" : "@/lib/ai");
  const changes: Array<{ absolute: string; path: string; before: string | null; after: string; diff: string }> = [];

  if (framework === "express") {
    const wiring = await detectVendoWiring(root);
    if (!wiring.server || !wiring.client) {
      const typescript = await exists(join(root, "tsconfig.json"));
      const server = join(root, "vendo", typescript ? "server.ts" : "server.mjs");
      const serverBefore = await readOptional(server);
      const serverAfter = expressServerSource(modelImport, typescript);
      if (serverBefore !== serverAfter) {
        const path = relative(root, server);
        changes.push({ absolute: server, path, before: serverBefore, after: serverAfter, diff: diff(path, serverBefore, serverAfter) });
      }
      if (modelImport === "./ai") {
        const modelModule = join(root, "vendo", typescript ? "ai.ts" : "ai.mjs");
        if (!(await exists(modelModule))) {
          const modelPath = relative(root, modelModule);
          const modelAfter = defaultModelSource();
          changes.push({ absolute: modelModule, path: modelPath, before: null, after: modelAfter, diff: diff(modelPath, null, modelAfter) });
        }
      }
    }
  } else {
    const app = await appDirectory(root);
    const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
    const wellKnownRoute = join(app, ".well-known", "[...vendo]", "route.ts");
    const layout = join(app, "layout.tsx");
    const routeBefore = await readOptional(route);
    const wellKnownRouteBefore = await readOptional(wellKnownRoute);
    const layoutBefore = await readOptional(layout);
    const routeAfter = routeBefore ?? routeSource(modelImport);
    const themeSpecifier = await themeImportSpecifier(root, app);
    const layoutAfter = layoutBefore === null
      ? defaultLayoutSource(themeSpecifier)
      : wireLayout(layoutBefore, themeSpecifier);
    if (routeBefore === null) {
      const path = relative(root, route);
      changes.push({ absolute: route, path, before: routeBefore, after: routeAfter, diff: diff(path, routeBefore, routeAfter) });
      // A fresh app has no model module yet: scaffold the BYO-LLM seat (one env
      // key = working agent) instead of wiring an import that cannot resolve.
      const modelModule = await modelModuleCandidate(root, app, modelImport);
      if (modelModule !== null && !(await exists(modelModule)) && !(await exists(modelModule.replace(/\.ts$/, ".js")))) {
        const modelPath = relative(root, modelModule);
        const modelAfter = defaultModelSource();
        changes.push({ absolute: modelModule, path: modelPath, before: null, after: modelAfter, diff: diff(modelPath, null, modelAfter) });
      }
    }
    if (mcpEnabled && wellKnownRouteBefore === null) {
      const path = relative(root, wellKnownRoute);
      const after = wellKnownRouteSource();
      changes.push({ absolute: wellKnownRoute, path, before: null, after, diff: diff(path, null, after) });
    }
    if (layoutAfter !== null && layoutAfter !== layoutBefore) {
      const path = relative(root, layout);
      changes.push({ absolute: layout, path, before: layoutBefore, after: layoutAfter, diff: diff(path, layoutBefore, layoutAfter) });
    }
  }
  const packageJson = join(root, "package.json");
  const packageBefore = await readOptional(packageJson);
  if (packageBefore !== null) {
    const packageAfter = packageWithSyncHooks(packageBefore);
    if (packageAfter !== null) {
      const path = relative(root, packageJson);
      changes.push({
        absolute: packageJson,
        path,
        before: packageBefore,
        after: packageAfter,
        diff: diff(path, packageBefore, packageAfter),
      });
    }
  }
  // Agent surface: a host that already uses skills (.claude/ exists) is offered
  // the packaged vendo-setup skill through the same diff-consent flow. Offered
  // only while missing — a host that edited or removed its copy is respected.
  if (await exists(join(root, ".claude"))) {
    const skillAbsolute = join(root, ".claude", "skills", "vendo-setup", "SKILL.md");
    if (!(await exists(skillAbsolute))) {
      const skillSource = await setupSkillSource();
      if (skillSource !== null) {
        const path = relative(root, skillAbsolute);
        changes.push({ absolute: skillAbsolute, path, before: null, after: skillSource, diff: diff(path, null, skillSource) });
      }
    }
  }
  const writes = [
    ".vendo/tools.json",
    ".vendo/overrides.json",
    ".vendo/policy.json",
    ".vendo/brief.md",
    ".vendo/theme.json",
    ".vendo/data/.gitignore",
  ];
  return {
    changes,
    plan: {
      framework,
      root,
      writes,
      codeChanges: changes.map(({ path, diff: rendered }) => ({ path, diff: rendered })),
      questions: [
        { id: "modelImport", question: "Where does your ai-SDK model export live?", recommendation: modelImport },
        { id: "brief", question: "In one paragraph, what should the agent know about this product?", recommendation: options.brief ?? "Describe the product, users, and the jobs they do." },
        { id: "risk", question: "Which extracted write actions need stricter review?", recommendation: "Mark destructive or irreversible tools critical in .vendo/overrides.json." },
        // 10-mcp §2: opening the door is a host decision, never a default — so ask.
        { id: "mcp", question: "Open the MCP door so agents (Claude, ChatGPT, Cursor) can use your product's tools?", recommendation: "No — opening it is a host decision and needs a HostOAuthAdapter (docs/contracts/10-mcp)." },
      ],
    },
  };
}

async function defaultConfirm(change: { path: string; diff: string }, output: Output): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`Apply this change to ${change.path}? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function defaultInterview(questions: InitQuestion[]): Promise<{
  modelImport?: string;
  brief?: string;
  criticalTools?: string[];
  openDoor?: boolean;
}> {
  if (!stdin.isTTY || !stdout.isTTY) return {};
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const modelImport = await prompt.question(`${questions[0]?.question} [${questions[0]?.recommendation}] `);
    const brief = await prompt.question(`${questions[1]?.question} [${questions[1]?.recommendation}] `);
    const critical = await prompt.question(`${questions[2]?.question} [comma-separated names; Enter accepts recommendation] `);
    const door = await prompt.question(`${questions[3]?.question} [y/N] `);
    return {
      ...(modelImport.trim() === "" ? {} : { modelImport: modelImport.trim() }),
      ...(brief.trim() === "" ? {} : { brief: brief.trim() }),
      ...(critical.trim() === "" ? {} : {
        criticalTools: critical.split(",").map((name) => name.trim()).filter(Boolean),
      }),
      ...(/^y(?:es)?$/i.test(door.trim()) ? { openDoor: true } : {}),
    };
  } finally {
    prompt.close();
  }
}

async function writeIfMissing(path: string, content: string, force: boolean): Promise<void> {
  if (!force && await exists(path)) return;
  await writeText(path, content);
}

function telemetryFor(options: InitOptions, output: Output): Telemetry {
  return toolingTelemetry({ ...options.telemetry, log: (message) => output.log(message) });
}

/** 09-vendo §5 — idempotent, permission-gated setup. */
export async function runInit(options: InitOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  const started = Date.now();
  const root = resolve(options.targetDir);
  const initial = await buildPlan(options);

  if (options.agent === true) {
    // Extraction runs before the plan is emitted so the plan carries real tool
    // names and risk advice; the throwaway out dir keeps --agent read-only.
    const extraction = await extractForPlan(root);
    const plan: InitPlan = {
      ...initial.plan,
      extraction,
      riskRecommendations: riskRecommendations(extraction.tools),
    };
    output.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  const answers = options.yes === true
    ? {}
    : await (options.interview ?? defaultInterview)(initial.plan.questions);
  const effective: InitOptions = {
    ...options,
    modelImport: answers.modelImport ?? options.modelImport,
    brief: answers.brief ?? options.brief,
  };
  const { plan, changes } = await buildPlan(effective, answers.openDoor === true);

  const telemetry = telemetryFor(options, output);
  await telemetry.track("init_started", { framework: plan.framework });

  try {
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeIfMissing(
      join(root, ".vendo", "overrides.json"),
      `${JSON.stringify({
        format: "vendo/overrides@1",
        tools: Object.fromEntries((answers.criticalTools ?? []).map((name) => [name, { critical: true }])),
      }, null, 2)}\n`,
      options.force === true,
    );
    await writeIfMissing(
      join(root, ".vendo", "policy.json"),
      `${JSON.stringify({
        format: "vendo/policy@1",
        directions: [],
        rules: [
          { match: { risk: "destructive" }, action: "ask", note: "Review irreversible actions" },
          { match: { risk: "read" }, action: "run" },
        ],
      }, null, 2)}\n`,
      options.force === true,
    );
    await writeIfMissing(
      join(root, ".vendo", "brief.md"),
      `${effective.brief?.trim() || "Describe this product, its users, and the jobs the agent should help them complete."}\n`,
      options.force === true,
    );
    await writeIfMissing(join(root, ".vendo", "theme.json"), `${JSON.stringify(await extractTheme(root), null, 2)}\n`, options.force === true);
    await writeIfMissing(join(root, ".vendo", "data", ".gitignore"), "*\n!.gitignore\n", options.force === true);

    const report = await vendoSync({ root, out: join(root, ".vendo") });
    for (const warning of report.warnings) output.error(`warning: ${warning}`);

    for (const change of changes) {
      output.log(`\nProposed code change:\n${change.diff}\n`);
      const approved = options.yes === true
        || await (options.confirm ?? ((candidate) => defaultConfirm(candidate, output)))(change);
      if (approved) await writeText(change.absolute, change.after);
      else output.error(`skipped ${change.path}; run again to apply it`);
    }

    let toolCount = 0;
    try {
      const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8")) as { tools?: unknown[] };
      toolCount = tools.tools?.length ?? 0;
    } catch {
      // Sync already reported any extraction warning; telemetry gets a count only.
    }
    await telemetry.track("init_completed", {
      framework: plan.framework,
      provider: effective.modelImport === undefined ? "existing" : "configured",
      llmSkipped: false,
      keyPrompt: "not-shown",
      command: "init",
      componentsOffered: 0,
      componentCount: 0,
      remixOffered: 0,
      remixWrapped: 0,
      remixSkipped: 0,
      toolCount,
      durationMs: Date.now() - started,
    });
    if (changes.some((change) => change.after === defaultModelSource() && change.before === null)) {
      // Majors pinned deliberately: @ai-sdk/anthropic@4 targets ai v7
      // (LanguageModelV4), incompatible with the umbrella's `ai >=6 <7` peer —
      // an unpinned install breaks `createVendo({ model })` on fresh hosts.
      output.log("Wrote a starter model module: install its provider (`npm install ai@^6 @ai-sdk/anthropic@^3`) and set ANTHROPIC_API_KEY.");
    }
    // 10-mcp §2: the door never opens by default. When the host asks to open it,
    // point them at the one code change they make deliberately — a HostOAuthAdapter
    // (session + principal resolution) plus `mcp: true` on createVendo. init cannot scaffold the
    // adapter (it is host auth), so it guides rather than writes broken wiring.
    if (answers.openDoor === true) {
      output.log("MCP door: implement a HostOAuthAdapter (session lookup + principal resolution) and pass `createVendo({ mcp: true, oauth })`; the door serves consent. Then run `vendo mcp server-json`, `vendo mcp verify-domain`, and `vendo doctor` for registry discovery. See docs/quickstart.md.");
    }
    const finalWiring = plan.framework === "express" ? await detectVendoWiring(root) : null;
    if (finalWiring !== null && (!finalWiring.server || !finalWiring.client)) {
      output.log("Vendo Express setup is incomplete. Two manual steps remain: mount `mountVendo()` with `app.use(\"/api/vendo\", mountVendo())`, and wrap the client in `<VendoRoot>`. `vendo doctor` will report broken until both are complete.");
    } else {
      output.log("Vendo initialized. Run `vendo doctor` to verify the live composition.");
    }
    return 0;
  } catch (error) {
    await telemetry.track("init_failed", { framework: plan.framework, failedStep: "wiring" });
    await telemetry.track("error_class", { errorClass: errorClass(error) });
    output.error(error instanceof Error ? error.message : "vendo init failed");
    return 1;
  }
}
