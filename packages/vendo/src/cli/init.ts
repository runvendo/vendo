import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { vendoSync } from "@vendoai/actions";
import { isSafeFontStack, normalizeColor, normalizeRadius, resolveVarRefs } from "./theme-colors.js";
import type { VendoTheme } from "@vendoai/core";
import type { Telemetry } from "@vendoai/telemetry";
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
  const candidates = [
    join(root, "app", "globals.css"),
    join(root, "src", "app", "globals.css"),
    join(root, "styles", "globals.css"),
    join(root, "src", "styles", "globals.css"),
  ];
  let css = "";
  for (const candidate of candidates) {
    const source = await readOptional(candidate);
    if (source !== null) css += `\n${source}`;
  }
  const variables = new Map<string, string>();
  for (const match of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)\s*;/g)) {
    if (match[1] !== undefined && match[2] !== undefined) variables.set(match[1].toLowerCase(), match[2].trim());
  }
  // Theme values are CONCRETE (hex/px/font stacks): a raw host var() reference
  // is meaningless outside the host page (the jail defines only --vendo-*).
  const resolved = (names: string[]): string | null => {
    for (const name of names) {
      const value = variables.get(name);
      if (value === undefined) continue;
      const flat = resolveVarRefs(value, variables);
      if (flat !== null) return flat;
    }
    return null;
  };
  const pickColor = (names: string[], fallback: string): string => {
    const flat = resolved(names);
    return (flat === null ? null : normalizeColor(flat)) ?? fallback;
  };
  const pickRadius = (names: string[], fallback: string): string => {
    const flat = resolved(names);
    return (flat === null ? null : normalizeRadius(flat)) ?? fallback;
  };
  const pickFont = (names: string[], fallback: string): string => {
    const flat = resolved(names);
    return flat !== null && isSafeFontStack(flat) ? flat : fallback;
  };
  return {
    colors: {
      background: pickColor(["background", "color-background", "bg"], DEFAULT_THEME.colors.background),
      surface: pickColor(["card", "surface", "color-surface"], DEFAULT_THEME.colors.surface),
      text: pickColor(["foreground", "text", "color-text"], DEFAULT_THEME.colors.text),
      muted: pickColor(["muted-foreground", "muted", "color-muted"], DEFAULT_THEME.colors.muted),
      accent: pickColor(["primary", "accent", "color-accent"], DEFAULT_THEME.colors.accent),
      accentText: pickColor(["primary-foreground", "accent-foreground"], DEFAULT_THEME.colors.accentText),
      danger: pickColor(["destructive", "danger", "color-danger"], DEFAULT_THEME.colors.danger),
      border: pickColor(["border", "color-border"], DEFAULT_THEME.colors.border),
    },
    typography: {
      fontFamily: pickFont(["font-sans", "font-family"], DEFAULT_THEME.typography.fontFamily),
      baseSize: pickRadius(["font-size", "text-base"], DEFAULT_THEME.typography.baseSize),
    },
    radius: {
      small: pickRadius(["radius-sm"], DEFAULT_THEME.radius.small),
      medium: pickRadius(["radius", "radius-md"], DEFAULT_THEME.radius.medium),
      large: pickRadius(["radius-lg"], DEFAULT_THEME.radius.large),
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
  framework: "next" | "unknown";
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

async function detectFramework(root: string): Promise<"next" | "unknown"> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return manifest.dependencies?.next !== undefined || manifest.devDependencies?.next !== undefined
      ? "next"
      : "unknown";
  } catch {
    return "unknown";
  }
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

function defaultModelSource(): string {
  return `import { createAnthropic } from "@ai-sdk/anthropic";\n\n` +
    `// vendo init starter: swap for any ai-SDK provider (BYO-LLM, 09 §2).\n` +
    `const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n` +
    `export const model = anthropic("claude-sonnet-4-6");\n`;
}

/** Resolve an `@/`-style model import to a candidate file the scaffold owns.
    Anything else (a package, a relative path) is the host's own module. */
function modelModuleCandidate(root: string, appDir: string, modelImport: string): string | null {
  if (!modelImport.startsWith("@/")) return null;
  // Mirror the Next `@/*` alias: rooted at src/ when the app directory lives there.
  const aliasRoot = appDir.endsWith(join("src", "app")) ? join(root, "src") : root;
  return join(aliasRoot, `${modelImport.slice(2)}.ts`);
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
  const childMatches = source.match(/\{children\}/g)?.length ?? 0;
  if (childMatches !== 1) return null;
  const directive = source.match(/^(["']use (?:client|server)["'];?\s*)/);
  const importLine = `import { VendoRoot } from "@vendoai/vendo/react";\n`;
  const prefix = directive?.[1] ?? "";
  const withImport = prefix.length === 0
    ? `${importLine}${source}`
    : `${prefix}${importLine}${source.slice(prefix.length)}`;
  return withImport.replace("{children}", "<VendoRoot>{children}</VendoRoot>");
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
  const app = await appDirectory(root);
  const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
  const layout = join(app, "layout.tsx");
  const routeBefore = await readOptional(route);
  const layoutBefore = await readOptional(layout);
  const modelImport = options.modelImport ?? "@/lib/ai";
  const routeAfter = routeBefore ?? routeSource(modelImport);
  const layoutAfter = layoutBefore === null ? defaultLayoutSource() : wireLayout(layoutBefore);
  const changes: Array<{ absolute: string; path: string; before: string | null; after: string; diff: string }> = [];
  if (routeBefore === null) {
    const path = relative(root, route);
    changes.push({ absolute: route, path, before: routeBefore, after: routeAfter, diff: diff(path, routeBefore, routeAfter) });
    // A fresh app has no model module yet: scaffold the BYO-LLM seat (one env
    // key = working agent) instead of wiring an import that cannot resolve.
    const modelModule = modelModuleCandidate(root, app, modelImport);
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
