import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { vendoSync } from "@vendoai/actions";
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

const DEFAULT_THEME = {
  colors: {
    background: "#ffffff",
    surface: "#f8fafc",
    text: "#0f172a",
    muted: "#64748b",
    accent: "#2563eb",
    accentText: "#ffffff",
    danger: "#dc2626",
    border: "#e2e8f0",
  },
  typography: { fontFamily: "system-ui, sans-serif", baseSize: "16px" },
  radius: { small: "4px", medium: "8px", large: "12px" },
  density: "comfortable",
  motion: "full",
} as const;

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
      accentText: DEFAULT_THEME.colors.accentText,
      danger: DEFAULT_THEME.colors.danger,
      border: DEFAULT_THEME.colors.border,
    },
    typography: {
      fontFamily: slots.fontFamily,
      baseSize: slots.baseSize,
    },
    radius: {
      small: deriveRadius(0.5, DEFAULT_THEME.radius.small),
      medium: slots.radius,
      large: deriveRadius(1.5, DEFAULT_THEME.radius.large),
    },
    density: DEFAULT_THEME.density,
    motion: DEFAULT_THEME.motion,
  };
}

export interface InitQuestion {
  id: "modelImport" | "brief" | "risk";
  question: string;
  recommendation: string;
}

export interface InitPlan {
  framework: HostFramework;
  root: string;
  writes: string[];
  codeChanges: Array<{ path: string; diff: string }>;
  questions: InitQuestion[];
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
        firstHeader: `(value: string | string[] | undefined): string | undefined`,
        requestHeaders: `(headers: IncomingHttpHeaders): Headers`,
        absoluteUrl: `(request: ExpressRequest): string`,
        sendResponse: `(source: Response, target: ServerResponse): Promise<void>`,
        handle: `(request: ExpressRequest, response: ServerResponse): Promise<void>`,
        mountReturn: `: (request: ExpressRequest, response: ServerResponse, next: ExpressNext) => void`,
      }
    : { firstHeader: "(value)", requestHeaders: "(headers)", absoluteUrl: "(request)", sendResponse: "(source, target)", handle: "(request, response)", mountReturn: "" };
  const requestInit = typescript
    ? `  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(request.headers) };\n`
    : `  const init = { method, headers: requestHeaders(request.headers) };\n`;
  const body = typescript
    ? `    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;\n`
    : `    init.body = Readable.toWeb(request);\n`;

  return `/**\n` +
    ` * Add these two wiring lines in your host:\n` +
    ` *   app.use("/api/vendo", mountVendo());\n` +
    ` *   root.render(<VendoRoot><App /></VendoRoot>); // in the client entry\n` +
    ` */\n` +
    imports +
    `import { model } from ${JSON.stringify(modelImport)};\n` +
    `import { createVendo } from "@vendoai/vendo/server";\n` +
    types +
    `\nconst vendo = createVendo({\n` +
    `  model,\n` +
    `  principal: async () => null,\n` +
    `});\n\n` +
    `function firstHeader${signatures.firstHeader} {\n` +
    `  return Array.isArray(value) ? value[0] : value;\n` +
    `}\n\n` +
    `function requestHeaders${signatures.requestHeaders} {\n` +
    `  const result = new Headers();\n` +
    `  for (const [name, value] of Object.entries(headers)) {\n` +
    `    if (Array.isArray(value)) for (const item of value) result.append(name, item);\n` +
    `    else if (value !== undefined) result.set(name, value);\n` +
    `  }\n` +
    `  return result;\n` +
    `}\n\n` +
    `function absoluteUrl${signatures.absoluteUrl} {\n` +
    `  const forwardedProtocol = firstHeader(request.headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim();\n` +
    `  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;\n` +
    `  const protocol = forwardedProtocol || (encrypted ? "https" : "http");\n` +
    `  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host ?? "localhost";\n` +
    `  return new URL(request.originalUrl ?? request.url ?? "/", \`${"${protocol}"}://${"${host}"}\`).href;\n` +
    `}\n\n` +
    `async function sendResponse${signatures.sendResponse} {\n` +
    `  target.statusCode = source.status;\n` +
    `  source.headers.forEach((value, name) => target.setHeader(name, value));\n` +
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

function defaultLayoutSource(): string {
  return `import { VendoRoot } from "@vendoai/vendo/react";\n` +
    `import type { ReactNode } from "react";\n\n` +
    `export default function RootLayout({ children }: { children: ReactNode }) {\n` +
    `  return <html><body><VendoRoot>{children}</VendoRoot></body></html>;\n` +
    `}\n`;
}

function wireLayout(source: string): string | null {
  if (source.includes("<VendoRoot") || source.includes("from \"@vendoai/vendo/react\"")) return source;
  const importLine = `import { VendoRoot } from "@vendoai/vendo/react";\n`;
  const directive = source.match(/^(["']use (?:client|server)["'];?\s*)/);
  const prefix = directive?.[1] ?? "";
  const withImport = (body: string): string =>
    prefix.length === 0 ? `${importLine}${body}` : `${prefix}${importLine}${body.slice(prefix.length)}`;

  const childMatches = source.match(/\{children\}/g)?.length ?? 0;
  if (childMatches === 1) {
    return withImport(source).replace("{children}", "<VendoRoot>{children}</VendoRoot>");
  }
  // A layout that returns the bare `children` (a valid Next pattern, e.g.
  // `return children;`) has no {children} JSX slot to wrap — rewrite the return.
  const bareReturn = /(\breturn\s*\(?\s*)children(\s*\)?\s*;)/;
  if (childMatches === 0 && bareReturn.test(source)) {
    return withImport(source).replace(bareReturn, "$1<VendoRoot>{children}</VendoRoot>$2");
  }
  return null;
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

async function buildPlan(options: InitOptions): Promise<{ plan: InitPlan; changes: Array<{ absolute: string; path: string; before: string | null; after: string; diff: string }> }> {
  const root = resolve(options.targetDir);
  const framework = await detectFramework(root);
  const modelImport = options.modelImport ?? "@/lib/ai";
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
    }
  } else {
    const app = await appDirectory(root);
    const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
    const layout = join(app, "layout.tsx");
    const routeBefore = await readOptional(route);
    const layoutBefore = await readOptional(layout);
    const routeAfter = routeBefore ?? routeSource(modelImport);
    const layoutAfter = layoutBefore === null ? defaultLayoutSource() : wireLayout(layoutBefore);
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
    if (layoutAfter !== null && layoutAfter !== layoutBefore) {
      const path = relative(root, layout);
      changes.push({ absolute: layout, path, before: layoutBefore, after: layoutAfter, diff: diff(path, layoutBefore, layoutAfter) });
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
        { id: "modelImport", question: "Where does your ai-SDK model export live?", recommendation: options.modelImport ?? "@/lib/ai" },
        { id: "brief", question: "In one paragraph, what should the agent know about this product?", recommendation: options.brief ?? "Describe the product, users, and the jobs they do." },
        { id: "risk", question: "Which extracted write actions need stricter review?", recommendation: "Mark destructive or irreversible tools critical in .vendo/overrides.json." },
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
}> {
  if (!stdin.isTTY || !stdout.isTTY) return {};
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const modelImport = await prompt.question(`${questions[0]?.question} [${questions[0]?.recommendation}] `);
    const brief = await prompt.question(`${questions[1]?.question} [${questions[1]?.recommendation}] `);
    const critical = await prompt.question(`${questions[2]?.question} [comma-separated names; Enter accepts recommendation] `);
    return {
      ...(modelImport.trim() === "" ? {} : { modelImport: modelImport.trim() }),
      ...(brief.trim() === "" ? {} : { brief: brief.trim() }),
      ...(critical.trim() === "" ? {} : {
        criticalTools: critical.split(",").map((name) => name.trim()).filter(Boolean),
      }),
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
    output.log(JSON.stringify(initial.plan, null, 2));
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
  const { plan, changes } = await buildPlan(effective);

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
      output.log("Wrote a starter model module: install its provider (`npm install ai @ai-sdk/anthropic`) and set ANTHROPIC_API_KEY.");
    }
    output.log("Vendo initialized. Run `vendo doctor` to verify the live composition.");
    return 0;
  } catch (error) {
    await telemetry.track("init_failed", { framework: plan.framework, failedStep: "wiring" });
    await telemetry.track("error_class", { errorClass: errorClass(error) });
    output.error(error instanceof Error ? error.message : "vendo init failed");
    return 1;
  }
}
