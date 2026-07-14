import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";
import type { Output } from "./shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({ model, principal: async () => null });\n');
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

describe("vendo init", () => {
  it.each([
    [{ dependencies: { express: "5.0.0" } }, "express"],
    [{ dependencies: { express: "5.0.0", next: "16.0.0" } }, "next"],
    [{ dependencies: { react: "19.0.0" } }, "unknown"],
  ] as const)("detects the host framework from package.json", async (manifest, expected) => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-detect-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({ framework: expected });
  });

  it("recognizes a wired Express host and leaves its code untouched across reruns", async () => {
    const root = await expressFixture(true);
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({ framework: "express", codeChanges: [] });

    const initialized = output();
    expect(await runInit({ targetDir: root, yes: true, output: initialized.output })).toBe(0);
    expect(initialized.logs).toContain("Vendo initialized. Run `vendo doctor` to verify the live composition.");
    expect(initialized.logs.join("\n")).not.toContain("Two manual steps remain");
    for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
      await expect(readFile(join(root, ".vendo", file), "utf8")).resolves.toBeTruthy();
    }
    await expect(readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).resolves.toBe("*\n!.gitignore\n");
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "app", "layout.tsx")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    expect(await tree(root)).toEqual(first);
  });

  it("proposes a resolvable TypeScript scaffold and model module for an unwired Express host", async () => {
    const root = await expressFixture(false);
    const planned = output();
    expect(await runInit({ targetDir: root, agent: true, output: planned.output })).toBe(0);
    const plan = JSON.parse(planned.logs.join("\n")) as {
      framework: string;
      codeChanges: Array<{ path: string; diff: string }>;
    };
    expect(plan.framework).toBe("express");
    expect(plan.codeChanges).toHaveLength(2);
    expect(plan.codeChanges[0]?.path).toBe("vendo/server.ts");
    expect(plan.codeChanges[0]?.diff).toContain("createVendo");
    expect(plan.codeChanges[0]?.diff).toContain("new Request");
    expect(plan.codeChanges[1]?.path).toBe("vendo/ai.ts");

    const declined = output();
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await runInit({ targetDir: root, confirm, output: declined.output })).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(declined.logs.join("\n")).toContain("Proposed code change");
    await expect(readFile(join(root, "vendo", "server.ts")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const initialized = output();
    expect(await runInit({ targetDir: root, yes: true, output: initialized.output })).toBe(0);
    const scaffold = await readFile(join(root, "vendo", "server.ts"), "utf8");
    expect(scaffold).toContain('from "@vendoai/vendo/server"');
    expect(scaffold).toContain('from "./ai"');
    expect(scaffold).not.toContain("x-forwarded-host");
    expect(scaffold).not.toContain("x-forwarded-proto");
    expect(scaffold).toContain("VENDO_BASE_URL");
    expect(scaffold).toContain("getSetCookie");
    expect(scaffold).toContain("Readable.toWeb(request)");
    expect(scaffold).toContain("source.body.getReader()");
    expect(scaffold).toContain('app.use("/api/vendo", mountVendo());');
    expect(scaffold).toContain("<VendoRoot theme={theme as VendoTheme}>");
    expect(scaffold).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    expect(scaffold).toContain('import theme from "<path-to>/.vendo/theme.json";');
    expect(scaffold).toContain('import type { VendoTheme } from "@vendoai/vendo";');
    expect(await readFile(join(root, "vendo", "ai.ts"), "utf8")).toContain("export const model");
    // Pinned majors: @ai-sdk/anthropic@4 targets ai v7 — unpinned install breaks fresh hosts.
    expect(initialized.logs.join("\n")).toContain("`npm install ai@^6 @ai-sdk/anthropic@^3`");
    expect(initialized.logs.join("\n")).toContain("Two manual steps remain");
    expect(initialized.logs.join("\n")).toContain('mount `mountVendo()`');
    expect(initialized.logs.join("\n")).toContain("wrap the client in `<VendoRoot>`");
    expect(initialized.logs.join("\n")).toContain("will report broken until both are complete");
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "app", "layout.tsx")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    expect(await tree(root)).toEqual(first);
  });

  it("uses an ESM scaffold when an Express host has no tsconfig", async () => {
    const root = await expressFixture(false);
    await rm(join(root, "tsconfig.json"));
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    const codeChanges = JSON.parse(sink.logs.join("\n")).codeChanges as Array<{ path: string; diff: string }>;
    expect(codeChanges).toMatchObject([
      { path: "vendo/server.mjs" },
      { path: "vendo/ai.mjs" },
    ]);
    // The JS wiring hint must be pasteable JavaScript — no type-only syntax.
    const scaffold = codeChanges[0]?.diff ?? "";
    expect(scaffold).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    expect(scaffold).toContain('import theme from "<path-to>/.vendo/theme.json";');
    expect(scaffold).toContain("<VendoRoot theme={theme}>");
    expect(scaffold).not.toContain("as VendoTheme");
    expect(scaffold).not.toContain("import type");
  });

  it("emits a read-only agent plan with the plain-language questions", async () => {
    const root = await fixture();
    const before = await tree(root);
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    expect(await tree(root)).toEqual(before);
    const plan = JSON.parse(sink.logs.join("\n")) as { questions: unknown[]; codeChanges: Array<{ diff: string }> };
    expect(plan.questions).toHaveLength(4);
    expect(plan.codeChanges).toHaveLength(3); // route + layout + starter model module
    expect(plan.codeChanges[0]?.diff).toContain("@vendoai/vendo/server");
  });

  it("writes the complete .vendo contract and permission-gated Next wiring idempotently", async () => {
    const root = await fixture();
    const sink = output();
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);

    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8"));
    const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8"));
    const policy = JSON.parse(await readFile(join(root, ".vendo", "policy.json"), "utf8"));
    expect(overrides).toEqual({ format: "vendo/overrides@1", tools: {} });
    expect(tools).toMatchObject({ format: "vendo/tools@1", tools: [] });
    expect(policy).toMatchObject({ format: "vendo/policy@1" });
    const envExample = await readFile(join(root, ".env.example"), "utf8");
    expect(envExample).toContain("VENDO_BASE_URL=http://localhost:3000");
    expect(envExample).toContain("credential forwarding is disabled without it");
    expect(await readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain("@vendoai/vendo/server");
    const wiredLayout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(wiredLayout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
    expect(wiredLayout).toContain('import theme from "../.vendo/theme.json";');
    expect(wiredLayout).toContain('import type { VendoTheme } from "@vendoai/vendo";');

    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);
    expect(await tree(root)).toEqual(first);
  });

  it("preserves an existing env example while appending the trusted Vendo origin once", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env.example"), "DATABASE_URL=postgres://localhost/host\n");

    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);

    const envExample = await readFile(join(root, ".env.example"), "utf8");
    expect(envExample).toContain("DATABASE_URL=postgres://localhost/host");
    expect(envExample).toContain("credential forwarding is disabled without it");
    expect(envExample.match(/^VENDO_BASE_URL=/gm)).toHaveLength(1);
  });

  it("shows each code diff and writes no code without approval", async () => {
    const root = await fixture();
    const sink = output();
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await runInit({ targetDir: root, confirm, output: sink.output })).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(3); // route + layout + starter model module
    expect(sink.logs.join("\n")).toContain("Proposed code change");
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).not.toContain("VendoRoot");
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records interview answers in the owned files and wiring", async () => {
    const root = await fixture();
    await runInit({
      targetDir: root,
      confirm: async () => true,
      interview: async (questions) => {
        expect(questions).toHaveLength(4);
        return {
          modelImport: "@/server/model",
          brief: "A billing product for finance teams.",
          criticalTools: ["host_invoices_send"],
        };
      },
      output: output().output,
    });
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain('from "@/server/model"');
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8"))
      .toBe("A billing product for finance teams.\n");
    expect(JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")))
      .toEqual({ format: "vendo/overrides@1", tools: { host_invoices_send: { critical: true } } });
  });

  it("extracts host CSS variables into the Vendo theme as concrete values", async () => {
    const root = await fixture();
    // hex, shadcn hsl triple behind a var() chain, oklch, rem radius — all
    // resolve to concrete hex/px (the jail knows no host custom properties).
    await writeFile(join(root, "app", "globals.css"),
      ":root { --background: #fafafa; --brand-hue: 262 83% 58%; --primary: hsl(var(--brand-hue)); " +
      "--foreground: oklch(0.205 0 0); --card: 0 0% 100%; --radius: 0.625rem; }\n");
    await runInit({ targetDir: root, yes: true, output: output().output });
    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: {
        background: "#fafafa",
        accent: "#7c3bed",
        text: "#171717",
        surface: "#ffffff",
      },
      radius: { medium: "10px" },
    });
  });

  it("extracts light theme tokens through CSS imports and recovers next/font stacks", async () => {
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
      '--muted-foreground: #737373; --primary: #2b7fff; --radius: 0.375rem; }\n' +
      '.dark { --background: #09090b; --card: #18181b; --foreground: #fafafa; ' +
      '--muted-foreground: #a1a1aa; --primary: #60a5fa; }\n');

    await runInit({ targetDir: root, yes: true, output: output().output });

    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: {
        background: "#fafafa",
        surface: "#ffffff",
        text: "#171717",
        muted: "#737373",
        accent: "#2b7fff",
      },
      typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
      radius: { medium: "6px" },
    });
  });

  it("wraps a layout that returns bare children (no JSX slot) with VendoRoot", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      "import type { ReactNode } from \"react\";\n" +
      "export default function RootLayout({ children }: { children: ReactNode }) {\n" +
      "    return children;\n}\n");
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("import { VendoRoot } from \"@vendoai/vendo/react\";");
    expect(layout).toContain("import theme from \"../.vendo/theme.json\";");
    expect(layout).toContain("return <VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>;");
  });

  it("scaffolds a fresh root app/ layout that imports and passes the extracted theme", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-fresh-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host", dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
    }));
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    // 08 §4 / 09 §4: fresh install adopts the host brand, not neutral chrome.
    expect(layout).toContain("import theme from \"../.vendo/theme.json\";");
    expect(layout).toContain("import type { VendoTheme } from \"@vendoai/vendo\";");
    expect(layout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
  });

  it("computes the theme specifier from a src/app layout (../../ to project root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcapp-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host", dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
    }));
    await writeFile(join(root, "src", "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const layout = await readFile(join(root, "src", "app", "layout.tsx"), "utf8");
    expect(layout).toContain("import theme from \"../../.vendo/theme.json\";");
    expect(layout).toContain("import type { VendoTheme } from \"@vendoai/vendo\";");
    expect(layout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
  });

  it("wires theme while preserving a \"use client\" directive at the top of the file", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      "\"use client\";\n" +
      "import type { ReactNode } from \"react\";\n" +
      "export default function Layout({ children }: { children: ReactNode }) { return <html><body>{children}</body></html>; }\n");
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(layout.startsWith("\"use client\";\n")).toBe(true);
    expect(layout).toContain("import { VendoRoot } from \"@vendoai/vendo/react\";");
    expect(layout).toContain("import theme from \"../.vendo/theme.json\";");
    expect(layout).toContain("import type { VendoTheme } from \"@vendoai/vendo\";");
    expect(layout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
    // Idempotent: a second run leaves the already-wired layout byte-identical.
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).toBe(layout);
  });

  it("degrades to bare VendoRoot wiring when the project disables resolveJsonModule", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { resolveJsonModule: false } }));
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("<VendoRoot>{children}</VendoRoot>");
    expect(layout).not.toContain("theme.json");
    expect(layout).not.toContain("theme={theme");
    expect(layout).not.toContain("VendoTheme");
  });

  it("emits only init telemetry and respects env opt-out", async () => {
    const root = await fixture();
    const home = await mkdtemp(join(tmpdir(), "vendo-home-"));
    cleanup.push(home);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await runInit({
      targetDir: root,
      yes: true,
      output: output().output,
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    });
    const events = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).event);
    expect(events).toEqual(expect.arrayContaining(["init_started", "init_completed"]));
    expect(events).not.toContain("refresh");

    const expressHome = await mkdtemp(join(tmpdir(), "vendo-home-express-"));
    cleanup.push(expressHome);
    const expressFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await runInit({
      targetDir: await expressFixture(true),
      yes: true,
      output: output().output,
      telemetry: { home: expressHome, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl: expressFetch },
    });
    expect(expressFetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body))))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        event: "init_completed",
        properties: expect.objectContaining({ framework: "express" }),
      })]));

    const disabled = vi.fn();
    await runInit({
      targetDir: await fixture(),
      yes: true,
      output: output().output,
      telemetry: {
        home: await mkdtemp(join(tmpdir(), "vendo-home-disabled-")),
        posthogKey: "phc_test",
        env: { NODE_ENV: "test", VENDO_TELEMETRY_DISABLED: "1" },
        fetchImpl: disabled,
      },
    });
    expect(disabled).not.toHaveBeenCalled();
  });
});
