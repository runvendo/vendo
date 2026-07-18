import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./init.js";
import type { Output } from "./shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Cloud step stub: absent key, no offer accepted — the quiet default. */
const NO_CLOUD = {
  cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] as readonly string[] }),
};

/** A canned theme-pass model (the refine-seam mock): returns the given slots. */
function themeModelOf(payload: object): () => Promise<LanguageModel> {
  return async () => new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  }) as LanguageModel;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-"));
  cleanup.push(root);
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
  }));
  await writeFile(join(root, "app", "layout.tsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
  return root;
}

async function expressFixture(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-express-"));
  cleanup.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "express-host",
    dependencies: { express: "5.0.0", "@vendoai/vendo": "0.3.0" },
  }));
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  if (wired) {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "server.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({ principal: async () => null });\n');
    await writeFile(join(root, "src", "client.tsx"),
      'import { VendoRoot } from "@vendoai/vendo/react";\nexport const App = () => <VendoRoot><main /></VendoRoot>;\n');
  }
  return root;
}

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

async function tree(root: string, at = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(at, { withFileTypes: true })) {
    if (name.name === "node_modules") continue;
    const path = join(at, name.name);
    if (name.isDirectory()) Object.assign(result, await tree(root, path));
    else result[path.slice(root.length + 1)] = await readFile(path, "utf8");
  }
  return result;
}

function run(root: string, sink: { output: Output }, extra: Partial<Parameters<typeof runInit>[0]> = {}): Promise<number> {
  return runInit({
    targetDir: root,
    output: sink.output,
    env: {},
    cloud: NO_CLOUD,
    themeModel: themeModelOf({ slots: {} }),
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    ...extra,
  });
}

describe("vendo init (zero-question)", () => {
  it.each([
    [{ dependencies: { express: "5.0.0" } }, "express"],
    [{ dependencies: { express: "5.0.0", next: "16.0.0" } }, "next"],
    [{ dependencies: { react: "19.0.0" } }, "unknown"],
  ] as const)("detects the host framework from package.json", async (manifest, expected) => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-detect-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({ framework: expected });
  });

  it("wires a fresh Next host with no prompts: route + hooks + .vendo, never touching the layout", async () => {
    const root = await fixture();
    const layoutBefore = await readFile(join(root, "app", "layout.tsx"), "utf8");
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    // The one generated code file: model-less createVendo (model is optional).
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";');
    expect(route).toContain("principal: async () => null");
    expect(route).not.toContain("model");

    // package.json gains the sync hooks.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.predev).toBe("vendo sync");
    expect(manifest.scripts?.prebuild).toBe("vendo sync --strict");

    // User-authored code is never edited; no model module is scaffolded.
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).toBe(layoutBefore);
    await expect(readFile(join(root, "lib", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    // .vendo artifacts land; no encryption key is ever generated.
    for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
      await expect(readFile(join(root, ".vendo", file), "utf8")).resolves.toBeTruthy();
    }
    await expect(readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).resolves.toBe("*\n!.gitignore\n");
    await expect(readFile(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });

    // The summary lists what changed and hands the paste + next steps over.
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Wired (2 files):");
    expect(logs).toContain("+ " + join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(logs).toContain("~ package.json");
    expect(logs).toContain("Last steps are yours:");
    expect(logs).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    expect(logs).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
    expect(logs).toContain("npx vendo doctor");
    // No interview, no per-diff consent, no refine offer, no finale.
    expect(logs).not.toContain("[y/N]");
    expect(logs).not.toContain("vendo refine");
  });

  it("is idempotent: a re-run changes nothing and says so", async () => {
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const first = await tree(root);
    const again = output();
    expect(await run(root, again)).toBe(0);
    expect(await tree(root)).toEqual(first);
    expect(again.logs.join("\n")).toContain("Already wired — nothing to change.");
  });

  it("computes the theme paste specifier from a src/app layout (../../ to project root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcapp-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "src", "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    await expect(readFile(join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8")).resolves.toBeTruthy();
    expect(sink.logs.join("\n")).toContain('import theme from "../../.vendo/theme.json";');
  });

  it("prints a theme-less paste when the project disables resolveJsonModule", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { resolveJsonModule: false } }));
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("<VendoRoot>{children}</VendoRoot>");
    expect(logs).not.toContain("import theme from");
  });

  it("states an env key in one line and skips the cloud offer", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { env: { ANTHROPIC_API_KEY: "sk-a" } })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Model: explicit ANTHROPIC_API_KEY (anthropic)");
    expect(logs).not.toContain("No model key yet");
  });

  it("points a keyless host at .env.local and `vendo cloud login`", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    expect(sink.logs.join("\n")).toContain("No model key yet");
    expect(sink.logs.join("\n")).toContain("vendo cloud login");
  });

  it("preserves an existing env example while appending the trusted Vendo origin once", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env.example"), "HOST_FLAG=1\n");
    expect(await run(root, output())).toBe(0);
    const example = await readFile(join(root, ".env.example"), "utf8");
    expect(example).toContain("HOST_FLAG=1");
    expect(example).toContain("VENDO_BASE_URL=http://localhost:3000");
    expect(await run(root, output())).toBe(0);
    expect((await readFile(join(root, ".env.example"), "utf8")).match(/VENDO_BASE_URL/g)).toHaveLength(1);
  });

  it("merges the sync hooks into existing scripts without clobbering them", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { dev: "next dev", predev: "echo pre" },
    }, null, 2));
    expect(await run(root, output())).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.predev).toBe("vendo sync && echo pre");
    expect(manifest.scripts.prebuild).toBe("vendo sync --strict");
    expect(manifest.scripts.dev).toBe("next dev");
  });

  it("generates the server-action registration map and wires an existing route (ENG-248)", async () => {
    const root = await fixture();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "invoices.ts"),
      '"use server";\n\nexport async function createInvoice(input: { amount: number }) {\n  return { ok: true, amount: input.amount };\n}\n');
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    const actions = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"), "utf8");
    expect(actions).toContain("createInvoice");
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { serverActions } from "./vendo-actions";');
    expect(route).toContain("serverActions,");

    // A route generated BEFORE actions existed gets rewired on the next init.
    const bare = await fixture();
    expect(await run(bare, output())).toBe(0);
    await mkdir(join(bare, "app", "actions"), { recursive: true });
    await writeFile(join(bare, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    expect(await run(bare, output())).toBe(0);
    const rewired = await readFile(join(bare, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(rewired).toContain("serverActions,");
  });

  it("scaffolds an unwired Express host (server only, no model module) and leaves a wired one untouched", async () => {
    const unwired = await expressFixture(false);
    const sink = output();
    expect(await run(unwired, sink)).toBe(0);
    const server = await readFile(join(unwired, "vendo", "server.ts"), "utf8");
    expect(server).toContain("createVendo({");
    expect(server).not.toContain("model");
    await expect(readFile(join(unwired, "vendo", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sink.logs.join("\n")).toContain('app.use("/api/vendo", mountVendo());');

    const wired = await expressFixture(true);
    expect(await run(wired, output())).toBe(0);
    const first = await tree(wired);
    expect(await run(wired, output())).toBe(0);
    expect(await tree(wired)).toEqual(first);
    await expect(readFile(join(wired, "vendo", "server.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an ESM scaffold when an Express host has no tsconfig", async () => {
    const root = await expressFixture(false);
    await rm(join(root, "tsconfig.json"));
    expect(await run(root, output())).toBe(0);
    const server = await readFile(join(root, "vendo", "server.mjs"), "utf8");
    expect(server).not.toContain(": Headers");
    expect(server).toContain("mountVendo");
  });

  it("writes the setup skill silently when .claude exists and respects an edited copy", async () => {
    const root = await fixture();
    await mkdir(join(root, ".claude"), { recursive: true });
    expect(await run(root, output())).toBe(0);
    const skill = join(root, ".claude", "skills", "vendo-setup", "SKILL.md");
    const body = await readFile(skill, "utf8");
    expect(body.length).toBeGreaterThan(0);

    await writeFile(skill, "edited by host\n");
    expect(await run(root, output())).toBe(0);
    expect(await readFile(skill, "utf8")).toBe("edited by host\n");
  });

  it("extracts host CSS variables into the Vendo theme as concrete values", async () => {
    const root = await fixture();
    // hex, shadcn hsl triple behind a var() chain, oklch, rem radius — all
    // resolve to concrete hex/px (the jail knows no host custom properties).
    await writeFile(join(root, "app", "globals.css"),
      ":root { --background: #fafafa; --brand-hue: 262 83% 58%; --primary: hsl(var(--brand-hue)); " +
      "--primary-foreground: #ffffff; --foreground: oklch(0.205 0 0); --card: 0 0% 100%; " +
      "--border: #dedede; --destructive: #b91c1c; --font-heading: Newsreader, serif; " +
      "--density: compact; --motion: reduced; --radius: 0.625rem; }\n");
    expect(await run(root, output(), { yes: true })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: {
        background: "#fafafa",
        accent: "#7c3bed",
        accentText: "#ffffff",
        border: "#dedede",
        danger: "#b91c1c",
        text: "#171717",
        surface: "#ffffff",
      },
      typography: { headingFamily: "Newsreader, serif" },
      radius: { medium: "10px" },
      density: "compact",
      motion: "reduced",
    });
  });

  it("fills next/font gaps via the model pass and prints the one-glance summary", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./global.css";\n' +
      'import { Inter as FontSans } from "next/font/google";\n' +
      'const fontSans = FontSans({ variable: "--font-sans" });\n' +
      'export default function Layout({ children }) { return <html><body className={`font-sans ${fontSans.variable}`}>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "global.css"),
      '@import "./tokens.css";\n' +
      ':root { --font-body: var(--font-sans); }\n');
    await writeFile(join(root, "app", "tokens.css"),
      ':root { --background: #fafafa; --card: #ffffff; --foreground: #171717; ' +
      '--muted-foreground: #737373; --primary: #2b7fff; --radius: 0.375rem; }\n');

    const sink = output();
    expect(await run(root, sink, {
      yes: true,
      themeModel: themeModelOf({ slots: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" } }),
    })).toBe(0);

    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: { background: "#fafafa", surface: "#ffffff", text: "#171717", muted: "#737373", accent: "#2b7fff" },
      typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
      radius: { medium: "6px" },
    });
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Theme: accent #2b7fff");
    expect(logs).toContain(".vendo/theme.json");
  });

  it("asks about the theme ONLY when the model reports uncertainty, and applies the answer", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "globals.css"),
      ":root { --color-ink: #111111; --color-evergreen-600: #196b46; }\n");

    const reviewed: string[] = [];
    const sink = output();
    expect(await run(root, sink, {
      themeModel: themeModelOf({
        slots: { accent: "#196b46", text: "#111111" },
        uncertain: [{ slot: "accent", note: "green may be data-only" }],
      }),
      themeReview: async (summary) => {
        reviewed.push(...summary.uncertain.map((entry) => entry.slot));
        return { accent: "#facc15", border: "#ecebe8", danger: "chartreuse-ish", sparkle: "#123456" };
      },
    })).toBe(0);

    expect(reviewed).toEqual(["accent"]);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    // The human answer wins; invalid values and unknown slots are ignored.
    expect(theme.colors.accent).toBe("#facc15");
    expect(theme.colors.border).toBe("#ecebe8");
    expect(theme.colors.danger).toBe("#dc2626");
    expect(theme.colors.text).toBe("#111111");
    expect(sink.errors.join("\n")).toContain('unknown theme slot "sparkle"');
    // The contrast-derived accentText follows the replaced accent.
    expect(theme.colors.accentText).toBe("#000000");
  });

  it("emits a read-only agent plan with code changes, extraction, and paste steps", async () => {
    const root = await fixture();
    const before = await tree(root);
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as {
      framework: string;
      writes: string[];
      codeChanges: Array<{ path: string; diff: string }>;
      manualSteps: string[];
      extraction: { tools: unknown[]; warnings: string[] };
      riskRecommendations: unknown[];
      aiPolish: { instructions: string; draftSchema: Record<string, unknown>; apply: string };
    };
    expect(plan.framework).toBe("next");
    expect(plan.writes).toContain(".vendo/tools.json");
    expect(plan.writes).not.toContain(".env");
    expect(plan.codeChanges.map((change) => change.path)).toContain(join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(plan.manualSteps.join("\n")).toContain("<VendoRoot");
    expect(Array.isArray(plan.extraction.tools)).toBe(true);
    expect(Array.isArray(plan.riskRecommendations)).toBe(true);
    // The delegation contract rides the plan: instructions an external agent
    // executes, the draft schema, and the apply command that runs the guards.
    expect(plan.aiPolish.instructions).toContain("never lower");
    expect(plan.aiPolish.instructions).toContain("Statically extracted tools");
    expect(plan.aiPolish.draftSchema).toMatchObject({ type: "object", required: ["brief", "tools"] });
    expect(plan.aiPolish.apply).toContain("vendo extract --apply");
    expect(await tree(root)).toEqual(before); // --agent wrote nothing
  });
});
