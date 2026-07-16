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

const WELL_KNOWN_ROUTE = `import { GET as handleVendo } from "../../api/vendo/[...vendo]/route";

const DOOR_PATHS = new Set([
  "/.well-known/oauth-protected-resource/api/vendo/mcp",
  "/.well-known/oauth-authorization-server/api/vendo/mcp",
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp-server-card",
]);

const forward = (request: Request) =>
  DOOR_PATHS.has(new URL(request.url).pathname)
    ? handleVendo(request)
    : new Response(null, { status: 404 });

export const GET = forward;
export const POST = forward;
`;

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
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({
      framework: "express",
      codeChanges: [{ path: "package.json" }],
    });

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
    expect(plan.codeChanges).toHaveLength(3);
    expect(plan.codeChanges[0]?.path).toBe("vendo/server.ts");
    expect(plan.codeChanges[0]?.diff).toContain("createVendo");
    expect(plan.codeChanges[0]?.diff).toContain("new Request");
    expect(plan.codeChanges[1]?.path).toBe("vendo/ai.ts");
    expect(plan.codeChanges[2]?.path).toBe("package.json");

    const declined = output();
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await runInit({ targetDir: root, confirm, output: declined.output })).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(3);
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
      { path: "package.json" },
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
    const plan = JSON.parse(sink.logs.join("\n")) as {
      questions: unknown[];
      codeChanges: Array<{ path: string; diff: string }>;
    };
    expect(plan.questions).toHaveLength(4);
    expect(plan.codeChanges).toHaveLength(4); // route + layout + starter model module + package hooks
    expect(plan.codeChanges[0]?.diff).toContain("@vendoai/vendo/server");
    expect(plan.codeChanges.find((change) => change.path === "package.json")?.diff)
      .toContain('"predev": "vendo sync"');
  });

  it("adds predev and prebuild sync hooks only when the package change is approved", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "package.json"), "utf8");
    const confirm = vi.fn(async (change: { path: string }) => change.path === "package.json");

    expect(await runInit({ targetDir: root, confirm, output: output().output })).toBe(0);

    expect(confirm).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({
      scripts: { predev: "vendo sync", prebuild: "vendo sync --strict" },
    });
    expect(await readFile(join(root, "package.json"), "utf8")).not.toBe(before);
  });

  it("prepends sync to existing lifecycle hooks and preserves package formatting", async () => {
    const root = await fixture();
    const manifest = {
      name: "host",
      scripts: { predev: "echo warmup", prebuild: "npm run check" },
      dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
    };
    await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 4)}\n`);

    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);

    const raw = await readFile(join(root, "package.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('    "scripts"');
    expect(JSON.parse(raw)).toMatchObject({
      scripts: {
        predev: "vendo sync && echo warmup",
        prebuild: "vendo sync --strict && npm run check",
      },
    });
  });

  it("offers no package change on an idempotent rerun", async () => {
    const root = await fixture();
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const first = await readFile(join(root, "package.json"), "utf8");
    const confirm = vi.fn().mockResolvedValue(false);

    expect(await runInit({ targetDir: root, confirm, output: output().output })).toBe(0);

    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(first);
  });

  it("leaves package.json untouched when its prompt is declined", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "package.json"), "utf8");
    const confirm = vi.fn(async (change: { path: string }) => change.path !== "package.json");

    expect(await runInit({ targetDir: root, confirm, output: output().output })).toBe(0);

    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("writes the complete .vendo contract and permission-gated Next wiring idempotently", async () => {
    const root = await fixture();
    const sink = output();
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);

    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8"));
    const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8"));
    const policy = JSON.parse(await readFile(join(root, ".vendo", "policy.json"), "utf8"));
    expect(overrides).toEqual({ format: "vendo/overrides@1", tools: {}, remix: { ignoreSlots: [] } });
    expect(tools).toMatchObject({ format: "vendo/tools@1", tools: [] });
    const catalog = JSON.parse(await readFile(join(root, ".vendo", "catalog.json"), "utf8"));
    expect(catalog).toEqual({ format: "vendo/catalog@1", entries: [] });
    expect(sink.logs).toContain("catalog.json: 0 discovered, 0 registered");
    expect(policy).toMatchObject({ format: "vendo/policy@1" });
    const envExample = await readFile(join(root, ".env.example"), "utf8");
    expect(envExample).toContain("VENDO_BASE_URL=http://localhost:3000");
    expect(envExample).toContain("credential forwarding is disabled without it");
    expect(await readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain("@vendoai/vendo/server");
    await expect(readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const wiredLayout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(wiredLayout).toContain("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>");
    expect(wiredLayout).toContain('import theme from "../.vendo/theme.json";');
    expect(wiredLayout).toContain('import type { VendoTheme } from "@vendoai/vendo";');

    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);
    expect(await tree(root)).toEqual(first);
  });

  it("offers remix wrapping for capturable registrations and captures approved slots (ENG-288 M6)", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "card.tsx"),
      "export function HostCard() { return <div>host card</div>; }\n");
    await writeFile(join(root, "app", "vendo-components.ts"),
      "import { HostCard } from \"./card\";\n" +
      "export const components = [\n" +
      "  { name: \"HostCard\", component: HostCard, description: \"A host card\" },\n" +
      "];\n");
    const home = await mkdtemp(join(tmpdir(), "vendo-home-remix-"));
    cleanup.push(home);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sink = output();
    expect(await runInit({
      targetDir: root,
      yes: true,
      output: sink.output,
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    })).toBe(0);

    const rewritten = await readFile(join(root, "app", "vendo-components.ts"), "utf8");
    expect(rewritten).toContain("{ remixable: true, name: \"HostCard\", component: HostCard");
    expect(sink.logs.join("\n")).toContain("Remix offer — mark HostCard remixable");
    // The post-wrap re-sync captured the freshly wrapped slot immediately.
    const baseline = JSON.parse(await readFile(join(root, ".vendo", "remixable", "HostCard.json"), "utf8"));
    expect(baseline).toMatchObject({ slot: "HostCard", exportable: false });
    expect(baseline.source).toContain("host card");
    const completed = fetchImpl.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((event) => event.event === "init_completed");
    expect(completed?.properties).toMatchObject({ remixOffered: 1, remixWrapped: 1, remixSkipped: 0 });

    // Idempotent: the wrapped registration is never offered again.
    const first = await tree(root);
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    expect(await tree(root)).toEqual(first);
  });

  it("counts declined remix offers as skipped and leaves the source untouched", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "card.tsx"),
      "export function HostCard() { return <div>host card</div>; }\n");
    const registration = "import { HostCard } from \"./card\";\n" +
      "export const components = [{ name: \"HostCard\", component: HostCard }];\n";
    await writeFile(join(root, "app", "vendo-components.ts"), registration);
    const home = await mkdtemp(join(tmpdir(), "vendo-home-remix-skip-"));
    cleanup.push(home);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    // Approve everything except the remix wrap.
    const confirm = vi.fn(async (change: { path: string; diff: string }) =>
      !change.diff.includes("remixable: true"));
    expect(await runInit({
      targetDir: root,
      confirm,
      interview: async () => ({}),
      output: output().output,
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    })).toBe(0);

    expect(await readFile(join(root, "app", "vendo-components.ts"), "utf8")).toBe(registration);
    await expect(readFile(join(root, ".vendo", "remixable", "HostCard.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const completed = fetchImpl.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((event) => event.event === "init_completed");
    expect(completed?.properties).toMatchObject({ remixOffered: 1, remixWrapped: 0, remixSkipped: 1 });
  });

  it("surfaces unresolved remixable slots loudly at init without aborting", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "vendo-components.ts"),
      "export const components = [{ name: \"InlineCard\", component: () => null, remixable: true }];\n");
    const sink = output();
    expect(await runInit({ targetDir: root, yes: true, output: sink.output })).toBe(0);
    const errors = sink.errors.join("\n");
    expect(errors).toContain("UNRESOLVED REMIXABLE SLOTS (init continues)");
    expect(errors).toContain("InlineCard [inline-component]");
    expect(errors).toContain("sync exits non-zero while they remain unresolved");
  });

  it("provisions VENDO_STORE_ENCRYPTION_KEY into .env and never regenerates it (02-store §4)", async () => {
    const root = await fixture();
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const env = await readFile(join(root, ".env"), "utf8");
    const key = env.match(/^VENDO_STORE_ENCRYPTION_KEY=(.+)$/m)?.[1];
    expect(key).toBeDefined();
    // A valid createStore key: base64-encoded 32 bytes (AES-256-GCM).
    expect(Buffer.from(key ?? "", "base64").byteLength).toBe(32);

    // Re-running init — even with --force — keeps the key: rotating it would
    // orphan every already-encrypted vendo_secrets row.
    expect(await runInit({ targetDir: root, yes: true, force: true, output: output().output })).toBe(0);
    const again = await readFile(join(root, ".env"), "utf8");
    expect(again.match(/^VENDO_STORE_ENCRYPTION_KEY=(.+)$/m)?.[1]).toBe(key);
  });

  it("appends the encryption key to an existing .env without clobbering it (02-store §4)", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env"), "EXISTING_VAR=keep-me"); // no trailing newline on purpose
    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(env.startsWith("EXISTING_VAR=keep-me\n")).toBe(true);
    expect(env).toMatch(/^VENDO_STORE_ENCRYPTION_KEY=.+$/m);
  });

  it.each(["app", join("src", "app")])(
    "generates the MCP sibling route with exact content under %s",
    async (appDir) => {
      const root = await mkdtemp(join(tmpdir(), "vendo-init-mcp-"));
      cleanup.push(root);
      await mkdir(join(root, appDir), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "host",
        dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
      }));
      await writeFile(join(root, appDir, "layout.tsx"),
        "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");

      const confirm = vi.fn().mockResolvedValue(true);
      expect(await runInit({
        targetDir: root,
        confirm,
        interview: async () => ({ openDoor: true }),
        output: output().output,
      })).toBe(0);

      const routePath = join(appDir, ".well-known", "[...vendo]", "route.ts");
      await expect(readFile(join(root, routePath), "utf8"))
        .resolves.toBe(WELL_KNOWN_ROUTE);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        path: routePath,
        diff: expect.stringContaining('+import { GET as handleVendo }'),
      }));
      const otherAppDir = appDir === "app" ? join("src", "app") : "app";
      await expect(readFile(join(root, otherAppDir, ".well-known", "[...vendo]", "route.ts"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves an existing hand-written MCP sibling route", async () => {
    const root = await fixture();
    const routeDir = join(root, "app", ".well-known", "[...vendo]");
    const route = join(routeDir, "route.ts");
    const existing = "export { GET } from \"../../api/vendo/[...vendo]/route\";\n";
    await mkdir(routeDir, { recursive: true });
    await writeFile(route, existing);

    expect(await runInit({
      targetDir: root,
      confirm: async () => true,
      interview: async () => ({ openDoor: true }),
      output: output().output,
    })).toBe(0);

    expect(await readFile(route, "utf8")).toBe(existing);
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
    expect(confirm).toHaveBeenCalledTimes(4); // route + layout + starter model module + package hooks
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
      .toEqual({
        format: "vendo/overrides@1",
        tools: { host_invoices_send: { critical: true } },
        remix: { ignoreSlots: [] },
      });
  });

  it("guides an explicitly opened MCP door without generating registry-auth routes", async () => {
    const root = await fixture();
    const sink = output();
    await runInit({
      targetDir: root,
      confirm: async () => true,
      interview: async () => ({ openDoor: true }),
      output: sink.output,
    });

    expect(sink.logs.join("\n")).toContain("vendo mcp server-json");
    expect(sink.logs.join("\n")).toContain("vendo mcp verify-domain");
    expect(sink.logs.join("\n")).toContain("vendo doctor");
    expect(Object.keys(await tree(root)).some((path) => path.includes("mcp-registry-auth"))).toBe(false);
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
    await runInit({ targetDir: root, yes: true, output: output().output });
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

  it("runs extraction for the agent plan and stays read-only", async () => {
    const root = await fixture();
    await writeFile(join(root, "openapi.json"), JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Host", version: "1.0.0" },
      paths: {
        "/api/invoices": { get: { summary: "List invoices" } },
        "/api/invoices/{id}": { delete: { summary: "Delete an invoice" } },
      },
    }));
    const before = await tree(root);
    const sink = output();

    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);

    expect(await tree(root)).toEqual(before); // extraction ran against a throwaway dir
    const plan = JSON.parse(sink.logs.join("\n")) as {
      extraction: { tools: Array<{ name: string; risk: string; binding: { kind: string; method: string } }>; warnings: string[] };
      riskRecommendations: Array<{ tool: string; risk: string; recommendation: string }>;
    };
    expect(plan.extraction.tools).toHaveLength(2);
    expect(plan.extraction.tools.every((tool) => tool.binding.kind === "openapi")).toBe(true);
    const destructive = plan.extraction.tools.find((tool) => tool.binding.method === "DELETE");
    expect(destructive?.risk).toBe("destructive");
    expect(plan.riskRecommendations).toContainEqual({
      tool: destructive?.name,
      risk: "destructive",
      recommendation: expect.stringContaining("mark it critical in .vendo/overrides.json"),
    });
  });

  it("agent-plan recommendations respect existing overrides", async () => {
    const root = await fixture();
    await writeFile(join(root, "openapi.json"), JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Host", version: "1.0.0" },
      paths: { "/api/invoices/{id}": { delete: { summary: "Delete an invoice" } } },
    }));
    const first = output();
    expect(await runInit({ targetDir: root, agent: true, output: first.output })).toBe(0);
    const name = (JSON.parse(first.logs.join("\n")) as { extraction: { tools: Array<{ name: string }> } })
      .extraction.tools[0]!.name;

    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@1",
      tools: { [name]: { critical: true } },
    }));
    const second = output();
    expect(await runInit({ targetDir: root, agent: true, output: second.output })).toBe(0);
    const plan = JSON.parse(second.logs.join("\n")) as {
      extraction: { tools: Array<{ name: string; critical?: boolean }> };
      riskRecommendations: Array<{ tool: string; recommendation: string }>;
    };
    expect(plan.extraction.tools[0]).toMatchObject({ name, critical: true });
    expect(plan.riskRecommendations).toContainEqual(expect.objectContaining({
      tool: name,
      recommendation: expect.stringContaining("already marked critical"),
    }));
  });

  it("degrades the agent plan to a warning when extraction fails", async () => {
    const root = await fixture();
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "overrides.json"), "{ not json"); // malformed overrides make vendoSync throw
    const sink = output();

    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);

    const plan = JSON.parse(sink.logs.join("\n")) as {
      extraction: { tools: unknown[]; warnings: string[] };
      riskRecommendations: unknown[];
    };
    expect(plan.extraction.tools).toEqual([]);
    expect(plan.extraction.warnings[0]).toContain("extraction failed:");
    expect(plan.riskRecommendations).toEqual([]);
  });

  it("offers the packaged setup skill only to hosts with a .claude directory", async () => {
    const skillPath = join(".claude", "skills", "vendo-setup", "SKILL.md");
    const without = output();
    expect(await runInit({ targetDir: await fixture(), agent: true, output: without.output })).toBe(0);
    expect((JSON.parse(without.logs.join("\n")) as { codeChanges: Array<{ path: string }> })
      .codeChanges.some((change) => change.path === skillPath)).toBe(false);

    const root = await fixture();
    await mkdir(join(root, ".claude"), { recursive: true });
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as { codeChanges: Array<{ path: string; diff: string }> };
    const offered = plan.codeChanges.find((change) => change.path === skillPath);
    expect(offered?.diff).toContain("name: vendo-setup");
  });

  it("writes the setup skill through diff consent and stays idempotent", async () => {
    const root = await fixture();
    await mkdir(join(root, ".claude"), { recursive: true });
    const skillAbsolute = join(root, ".claude", "skills", "vendo-setup", "SKILL.md");
    const skillPath = join(".claude", "skills", "vendo-setup", "SKILL.md");

    const declined = vi.fn(async (change: { path: string }) => change.path !== skillPath);
    expect(await runInit({ targetDir: root, confirm: declined, output: output().output })).toBe(0);
    await expect(readFile(skillAbsolute, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runInit({ targetDir: root, yes: true, output: output().output })).toBe(0);
    const written = await readFile(skillAbsolute, "utf8");
    expect(written).toContain("name: vendo-setup");
    expect(written).toContain("docs.vendo.run/install.md");

    // A rerun (or a host that edited its copy) is never re-prompted.
    await writeFile(skillAbsolute, "# my edited copy\n");
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await runInit({ targetDir: root, confirm, output: output().output })).toBe(0);
    expect(confirm.mock.calls.map(([change]) => (change as { path: string }).path)).not.toContain(skillPath);
    expect(await readFile(skillAbsolute, "utf8")).toBe("# my edited copy\n");

    // A deleted copy is offered again, like any missing scaffold.
    await rm(skillAbsolute);
    const reoffered = output();
    expect(await runInit({ targetDir: root, agent: true, output: reoffered.output })).toBe(0);
    expect((JSON.parse(reoffered.logs.join("\n")) as { codeChanges: Array<{ path: string }> })
      .codeChanges.some((change) => change.path === skillPath)).toBe(true);
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

  describe("end-of-init refine offer (one engine, two surfaces)", () => {
    it("runs `vendo refine` against the initialized root when the offer is accepted", async () => {
      const root = await fixture();
      const sink = output();
      const runRefine = vi.fn(async () => 0);
      expect(await runInit({
        targetDir: root,
        interview: async () => ({}),
        confirm: async () => true,
        output: sink.output,
        offerRefine: async () => true,
        runRefine,
      })).toBe(0);
      expect(runRefine).toHaveBeenCalledWith(expect.objectContaining({ targetDir: root }));
    });

    it("forwards the model the dev configured during init into the refine offer", async () => {
      const runRefine = vi.fn(async () => 0);
      expect(await runInit({
        targetDir: await fixture(),
        modelImport: "@/lib/ai",
        interview: async () => ({}),
        confirm: async () => true,
        output: output().output,
        offerRefine: async () => true,
        runRefine,
      })).toBe(0);
      expect(runRefine).toHaveBeenCalledWith(expect.objectContaining({ modelImport: "@/lib/ai" }));
    });

    it("a declined offer runs nothing; a failed refine never fails init", async () => {
      const declinedRefine = vi.fn(async () => 0);
      const declined = output();
      expect(await runInit({
        targetDir: await fixture(),
        interview: async () => ({}),
        confirm: async () => true,
        output: declined.output,
        offerRefine: async () => false,
        runRefine: declinedRefine,
      })).toBe(0);
      expect(declinedRefine).not.toHaveBeenCalled();

      const failed = output();
      expect(await runInit({
        targetDir: await fixture(),
        interview: async () => ({}),
        confirm: async () => true,
        output: failed.output,
        offerRefine: async () => true,
        runRefine: async () => 1,
      })).toBe(0);
      expect(failed.errors.join("\n")).toContain("vendo refine did not complete");
    });

    it("--yes skips the prompt and points at `vendo refine` instead", async () => {
      const sink = output();
      const runRefine = vi.fn(async () => 0);
      expect(await runInit({
        targetDir: await fixture(),
        yes: true,
        output: sink.output,
        offerRefine: async () => true,
        runRefine,
      })).toBe(0);
      expect(runRefine).not.toHaveBeenCalled();
      expect(sink.logs.join("\n")).toContain("`vendo refine` proposes compound capabilities");
    });
  });
});
