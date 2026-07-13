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
  it("emits a read-only agent plan with three plain-language questions", async () => {
    const root = await fixture();
    const before = await tree(root);
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    expect(await tree(root)).toEqual(before);
    const plan = JSON.parse(sink.logs.join("\n")) as { questions: unknown[]; codeChanges: Array<{ diff: string }> };
    expect(plan.questions).toHaveLength(3);
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
    expect(await readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain("@vendoai/vendo/server");
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8"))
      .toContain("<VendoRoot>{children}</VendoRoot>");

    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);
    expect(await tree(root)).toEqual(first);
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
        expect(questions).toHaveLength(3);
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
    expect(layout).toContain("return <VendoRoot>{children}</VendoRoot>;");
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
