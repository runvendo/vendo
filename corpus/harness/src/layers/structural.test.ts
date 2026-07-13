import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runStructuralLayer,
  type StructuralCommandRunner,
  type StructuralLayerContext,
} from "./structural.js";

const tempRoots: string[] = [];

const theme = {
  colors: {
    background: "#FFFFFF",
    surface: "#F5F7FA",
    text: "#111418",
    muted: "#5B6470",
    accent: "#0A7CFF",
    accentText: "#FFFFFF",
    danger: "#DC2626",
    border: "#E5E7EB",
  },
  typography: { fontFamily: "system-ui, sans-serif", baseSize: "16px" },
  radius: { small: "4px", medium: "8px", large: "12px" },
  density: "comfortable",
  motion: "full",
};

const safeTools = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "host_listInvoices",
      description: "List invoices.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
    },
    {
      name: "host_createInvoice",
      description: "Create an invoice.",
      inputSchema: { type: "object", properties: {} },
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" },
    },
  ],
};

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "vendo-corpus-structural-"));
  tempRoots.push(repoDir);
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        scripts: {
          prebuild: "vendo sync",
          build: "next build",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          "@electric-sql/pglite": "^0.2.0",
          "@vendoai/vendo": "latest",
          next: "16.0.0",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(repoDir, "next.config.ts"),
    [
      "import type { NextConfig } from \"next\";",
      "",
      "const nextConfig: NextConfig = {",
      "  transpilePackages: [\"@vendoai/vendo\"],",
      "  serverExternalPackages: [\"@electric-sql/pglite\"],",
      "};",
      "",
      "export default nextConfig;",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repoDir, ".env.example"), "ANTHROPIC_API_KEY=\nDATABASE_URL=\n");
  await writeFile(
    path.join(repoDir, "instrumentation.ts"),
    [
      "export async function register() {",
      "  if (process.env.NEXT_RUNTIME === \"nodejs\") {",
      "    const { startVendoScheduler } = await import(\"@vendoai/vendo\");",
      "    startVendoScheduler();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repoDir, "app/api/vendo/[...vendo]"), { recursive: true });
  await writeFile(
    path.join(repoDir, "app/api/vendo/[...vendo]/route.ts"),
    [
      'import { model } from "@/lib/ai";',
      'import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";',
      "const vendo = createVendo({ model, principal: async () => null });",
      "export const { GET, POST, DELETE } = nextVendoHandler(vendo);",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoDir, "app/layout.tsx"),
    [
      "import { VendoRoot } from \"@vendoai/vendo/react\";",
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      "  return <html><body><VendoRoot>{children}</VendoRoot></body></html>;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoDir, "app/vendo-root.tsx"),
    [
      "\"use client\";",
      "import { VendoRoot } from \"@vendoai/vendo/react\";",
      "import theme from \"../.vendo/theme.json\";",
      "import tools from \"../.vendo/tools.json\";",
      "export function AppVendoRoot({ children }: { children: React.ReactNode }) {",
      "  return <VendoRoot theme={theme} tools={tools}>{children}</VendoRoot>;",
      "}",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repoDir, ".vendo/data"), { recursive: true });
  await writeFile(path.join(repoDir, ".vendo/overrides.json"), '{"format":"vendo/overrides@1","tools":{}}\n');
  await writeFile(path.join(repoDir, ".vendo/policy.json"), '{"format":"vendo/policy@1"}\n');
  await writeFile(path.join(repoDir, ".vendo/brief.md"), "# Fixture app\n");
  await writeFile(path.join(repoDir, ".vendo/data/.gitignore"), "*\n!.gitignore\n");
  await writeFile(path.join(repoDir, ".vendo/theme.json"), JSON.stringify(theme, null, 2) + "\n");
  await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify(safeTools, null, 2) + "\n");
  await mkdir(path.join(repoDir, "public/vendo"), { recursive: true });
  await writeFile(path.join(repoDir, "public/vendo/react-runtime.js"), "window.__React = {};\n");
  await writeFile(path.join(repoDir, "public/vendo/components-sandbox.js"), "window.__VENDO_COMPONENTS__ = {};\n");
  return repoDir;
}

function passingContext(repoDir: string, runner: StructuralCommandRunner): StructuralLayerContext {
  return {
    repoDir,
    initExitCode: 0,
    secondInitExitCode: 0,
    secondRunDiff: "",
    typecheckCommand: "pnpm typecheck",
    buildCommand: "pnpm build",
    commandRunner: runner,
  };
}

function byId(results: Awaited<ReturnType<typeof runStructuralLayer>>) {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("runStructuralLayer", () => {
  it("passes all Layer 1 structural checks for a generated App Router fixture", async () => {
    const repoDir = await makeTempRepo();
    const calls: string[] = [];
    const runner: StructuralCommandRunner = async (command, options) => {
      calls.push(`${command} @ ${options.cwd}`);
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const results = await runStructuralLayer(passingContext(repoDir, runner));

    expect(results.map((result) => result.id)).toEqual([
      "init.exit",
      "files.expected",
      "config.schema",
      "host.typecheck",
      "host.build",
      "init.idempotent",
      "tools.fail-closed",
    ]);
    expect(results.every((result) => result.pass)).toBe(true);
    expect(calls).toEqual([
      `pnpm typecheck @ ${repoDir}`,
      `pnpm build @ ${repoDir}`,
    ]);
  });

  it("reports targeted failures without throwing and still runs every check", async () => {
    const repoDir = await makeTempRepo();
    await unlink(path.join(repoDir, "app/api/vendo/[...vendo]/route.ts"));
    await writeFile(path.join(repoDir, ".vendo/theme.json"), JSON.stringify({ ...theme, colors: { ...theme.colors, accent: 42 } }));
    await writeFile(
      path.join(repoDir, ".vendo/tools.json"),
      JSON.stringify(
        {
          ...safeTools,
          tools: [
            {
              ...safeTools.tools[1],
              risk: "read",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const calls: string[] = [];
    const runner: StructuralCommandRunner = async (command, options) => {
      calls.push(`${command} @ ${options.cwd}`);
      if (command.includes("typecheck")) throw new Error("typecheck command could not start");
      return { code: 2, stdout: "build stdout", stderr: "build stderr" };
    };

    const results = byId(await runStructuralLayer({
      repoDir,
      initExitCode: 1,
      secondInitExitCode: 0,
      secondRunDiff: "M app/layout.tsx\n",
      typecheckCommand: "pnpm typecheck",
      buildCommand: "pnpm build",
      commandRunner: runner,
    }));

    expect(Object.values(results)).toHaveLength(7);
    expect(results["init.exit"]).toMatchObject({ pass: false });
    expect(results["files.expected"]?.detail).toContain("app/api/vendo/[...vendo]/route.ts");
    expect(results["config.schema"]?.detail).toContain("theme.json");
    expect(results["host.typecheck"]?.detail).toContain("typecheck command could not start");
    expect(results["host.build"]?.detail).toContain("exit code 2");
    expect(results["init.idempotent"]?.detail).toContain("M app/layout.tsx");
    expect(results["tools.fail-closed"]?.detail).toContain("host_createInvoice");
    expect(calls).toEqual([
      `pnpm typecheck @ ${repoDir}`,
      `pnpm build @ ${repoDir}`,
    ]);
  });

  it("skips host command failures when the baseline was already broken", async () => {
    const repoDir = await makeTempRepo();
    const calls: string[] = [];
    const runner: StructuralCommandRunner = async (command, options) => {
      calls.push(`${command} @ ${options.cwd}`);
      return { code: 2, stdout: `${command} post stdout`, stderr: `${command} post stderr` };
    };

    const results = byId(await runStructuralLayer({
      ...passingContext(repoDir, runner),
      baseline: {
        typecheck: {
          command: "pnpm typecheck",
          result: { code: 1, stdout: "baseline typecheck stdout", stderr: "baseline typecheck stderr" },
        },
        build: {
          command: "pnpm build",
          error: "spawn pnpm ENOENT",
        },
      },
    }));

    expect(results["host.typecheck"]).toMatchObject({
      pass: true,
      status: "skipped-baseline-broken",
    });
    expect(results["host.typecheck"]?.detail).toContain("baseline before vendo init failed with exit code 1");
    expect(results["host.typecheck"]?.detail).toContain("post-init failed with exit code 2");
    expect(results["host.build"]).toMatchObject({
      pass: true,
      status: "skipped-baseline-broken",
    });
    expect(results["host.build"]?.detail).toContain("baseline before vendo init command failed to start");
    expect(calls).toEqual([
      `pnpm typecheck @ ${repoDir}`,
      `pnpm build @ ${repoDir}`,
    ]);
  });

  it("skips host typecheck when no command is configured or auto-detected", async () => {
    const repoDir = await makeTempRepo();
    const calls: string[] = [];
    const runner: StructuralCommandRunner = async (command, options) => {
      calls.push(`${command} @ ${options.cwd}`);
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const results = byId(await runStructuralLayer({
      ...passingContext(repoDir, runner),
      typecheckCommand: undefined,
    }));

    expect(results["host.typecheck"]).toMatchObject({
      pass: true,
      status: "skipped-not-configured",
    });
    expect(results["host.typecheck"]?.detail).toContain("no manifest typecheckCommand");
    expect(results["host.build"]).toMatchObject({ pass: true });
    expect(calls).toEqual([
      `pnpm build @ ${repoDir}`,
    ]);
  });

  it("passes local-package policy overrides to default host command execution", async () => {
    const repoDir = await makeTempRepo();
    await writeFile(
      path.join(repoDir, "env-check.mjs"),
      [
        "import { appendFileSync } from \"node:fs\";",
        "appendFileSync(\"env-check.jsonl\", JSON.stringify({",
        "  step: process.argv[2],",
        "  minimumReleaseAge: process.env.PNPM_CONFIG_MINIMUM_RELEASE_AGE,",
        "  allowBuilds: process.env.PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS,",
        "  yarnImmutable: process.env.YARN_ENABLE_IMMUTABLE_INSTALLS,",
        "}) + \"\\n\");",
        "",
      ].join("\n"),
    );
    const node = JSON.stringify(process.execPath);

    const results = byId(await runStructuralLayer({
      repoDir,
      initExitCode: 0,
      secondInitExitCode: 0,
      secondRunDiff: "",
      typecheckCommand: `${node} env-check.mjs typecheck`,
      buildCommand: `${node} env-check.mjs build`,
      env: {
        PNPM_CONFIG_MINIMUM_RELEASE_AGE: "1440",
        PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "false",
        YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
      },
    }));

    expect(results["host.typecheck"]).toMatchObject({ pass: true });
    expect(results["host.build"]).toMatchObject({ pass: true });
    const entries = (await readFile(path.join(repoDir, "env-check.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(entries).toEqual([
      {
        step: "typecheck",
        minimumReleaseAge: "0",
        allowBuilds: "true",
        yarnImmutable: "false",
      },
      {
        step: "build",
        minimumReleaseAge: "0",
        allowBuilds: "true",
        yarnImmutable: "false",
      },
    ]);
  });

  it("fails host commands only when a passing baseline regresses after init", async () => {
    const repoDir = await makeTempRepo();
    const calls: string[] = [];
    const runner: StructuralCommandRunner = async (command, options) => {
      calls.push(`${command} @ ${options.cwd}`);
      if (command.includes("build")) {
        return { code: 1, stdout: "post build stdout", stderr: "post build stderr" };
      }
      return { code: 0, stdout: "post typecheck ok", stderr: "" };
    };

    const results = byId(await runStructuralLayer({
      ...passingContext(repoDir, runner),
      baseline: {
        typecheck: {
          command: "pnpm typecheck",
          result: { code: 0, stdout: "baseline typecheck ok", stderr: "" },
        },
        build: {
          command: "pnpm build",
          result: { code: 0, stdout: "baseline build ok", stderr: "" },
        },
      },
    }));

    expect(results["host.typecheck"]).toMatchObject({ pass: true });
    expect(results["host.typecheck"]?.detail).toContain("succeeded before and after vendo init");
    expect(results["host.build"]).toMatchObject({ pass: false });
    expect(results["host.build"]?.detail).toContain("regressed after vendo init");
    expect(results["host.build"]?.detail).toContain("baseline succeeded but post-init failed with exit code 1");
    expect(calls).toEqual([
      `pnpm typecheck @ ${repoDir}`,
      `pnpm build @ ${repoDir}`,
    ]);
  });
});
