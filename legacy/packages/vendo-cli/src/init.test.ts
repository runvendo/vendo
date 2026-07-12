import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import { DEFAULT_THEME_STUB } from "./next-wiring.js";
import { textModel, throwingModel } from "./test-helpers.js";

const ROUTE_REPLY = JSON.stringify([{
  name: "list_things", description: "List things.", method: "get", path: "/api/things",
  inputSchema: { type: "object", properties: {} },
}]);
const COMPONENT_REPLY = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A badge.",
  imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Text." }],
  jsx: "<Badge>{p.text}</Badge>",
});
describe("runInit e2e (mock model)", () => {
  it("emits all three artifacts + README into .vendo only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "src/app/api/things"), { recursive: true });
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/app/globals.css"), "@theme { --color-bg: #ffffff; --color-ink: #111111; }");
    await writeFile(path.join(dir, "src/app/api/things/route.ts"), "export async function GET() {}");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runInit({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    log.mockRestore();
    expect(code).toBe(0);
    const theme = JSON.parse(await readFile(path.join(dir, ".vendo/theme.json"), "utf8"));
    expect(theme.background).toBe("#ffffff");
    const tools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(tools.tools[0]).toMatchObject({
      name: "getThings",
      description: "List things.",
      binding: { type: "http", method: "GET", path: "/api/things" },
      annotations: { mutating: true, dangerous: false },
    });
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    const readme = await readFile(path.join(dir, ".vendo/README.md"), "utf8");
    expect(readme).toContain("## Events");
    expect(readme).toContain('"version": 1');
    expect(readme).toContain('"events": [');
    expect(readme).toContain('"name": "charge.posted"');
    expect(readme).toContain("ingestVendoEvent()");
    expect(readme).toContain("POST /api/vendo/events/ingest");
    expect(readme).toContain("push at the source, relay webhooks, or poll upstream systems");
    expect(readme).not.toContain("vendo publish");
  });

  it("interactive run shows the catalog picker and wraps only the picked component", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await mkdir(path.join(dir, "src/app/api/things"), { recursive: true });
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/app/globals.css"), ":root { --color-bg: #ffffff; }");
    await writeFile(path.join(dir, "src/app/api/things/route.ts"), "export async function GET() {}");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/panel.tsx"), "export const Panel = () => null");

    const PROPOSE = JSON.stringify({
      proposals: [
        { file: "src/components/ui/badge.tsx", wrappable: true, reason: "Status primitive." },
        { file: "src/components/ui/panel.tsx", wrappable: true, reason: "Container primitive." },
      ],
    });
    let shown: string[] = [];
    const interactor = {
      async maskedInput() {
        return null;
      },
      async multiSelect(opts: { options: { value: string; label: string }[] }) {
        shown = opts.options.map((o) => o.label);
        return ["src/components/ui/badge.tsx"]; // pick Badge, drop Panel
      },
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runInit({
      targetDir: dir,
      skipLlm: false,
      force: false,
      // Interactive init: route scan → catalog proposal → analyze the pick.
      model: textModel([ROUTE_REPLY, PROPOSE, COMPONENT_REPLY]),
      interactive: true,
      interactor: interactor as never,
    });
    const out = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(code).toBe(0);
    expect(shown).toEqual(["Badge", "Panel"]); // picker labeled by component name
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    await expect(readFile(path.join(dir, ".vendo/components/Panel/impl.tsx"), "utf8")).rejects.toThrow();
    expect(out).toContain("deselected in picker (not wrapped): Panel");
  });

  it("reports a clean error (not an unhandled rejection) when the model factory throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), "{}");
    const prevEnv = {
      VENDO_CLI_MODEL: process.env["VENDO_CLI_MODEL"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    };
    // With a key present (cliModel is gated on key presence — no key means
    // the deterministic-rescue null path, never an error), an unknown provider
    // prefix makes resolveModelChoice (via cliModel) throw synchronously —
    // deterministic regardless of which optional peers happen to be installed
    // in this workspace.
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-fake-test";
    process.env["VENDO_CLI_MODEL"] = "grok/whatever";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runInit({ targetDir: dir, skipLlm: false, force: false });
      expect(code).toBe(1);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/unknown provider "grok"/);
    } finally {
      errSpy.mockRestore();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("falls back to non-LLM init and still wires Next when route scan generation fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "host-app", dependencies: { next: "16.0.0" } }));
    await writeFile(path.join(dir, "tsconfig.json"), "{}");
    await mkdir(path.join(dir, "app/api/things"), { recursive: true });
    await writeFile(
      path.join(dir, "app/layout.tsx"),
      "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
    );
    await writeFile(path.join(dir, "app/api/things/route.ts"), "export async function GET() { return Response.json([]); }\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runInit({
        targetDir: dir,
        skipLlm: false,
        force: false,
        model: throwingModel("temperature is deprecated for this model"),
      });
      expect(code).toBe(0);
      expect(err.mock.calls.flat().join("\n")).not.toContain("LLM-assisted route scan failed");
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("warning: LLM route enrichment failed");
      expect(out).toContain("temperature is deprecated");
      expect(out).toContain("deterministic route inventory was used");
      expect(out).toContain("next wiring:");
      const tools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
      expect(tools.tools[0]).toMatchObject({
        name: "getThings",
        description: "GET /api/things",
        binding: { type: "http", method: "GET", path: "/api/things" },
        annotations: { mutating: true, dangerous: false },
      });
      const route = await readFile(path.join(dir, "app/api/vendo/[...path]/route.ts"), "utf8");
      expect(route).toContain("createVendoHandler()");
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies["vendoai"]).toBe("latest");
      expect(pkg.dependencies["@electric-sql/pglite"]).toBe("^0.2.0");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("skips LLM steps cleanly when VENDO_CLI_MODEL is set but no provider key is present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), "{}");
    await writeFile(path.join(dir, "globals.css"), ":root { --color-bg: #ffffff; }");
    const prevEnv = {
      VENDO_CLI_MODEL: process.env["VENDO_CLI_MODEL"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
      GOOGLE_GENERATIVE_AI_API_KEY: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
    };
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    process.env["VENDO_CLI_MODEL"] = "claude-sonnet-5"; // a model id is not a credential
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runInit({ targetDir: dir, skipLlm: false, force: false });
      const out = log.mock.calls.flat().join("\n");
      expect(code).toBe(0);
      expect(out).toContain("LLM steps skipped");
      await readFile(path.join(dir, ".vendo/theme.json"), "utf8");
    } finally {
      log.mockRestore();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("--skip-llm still writes theme.json and reports skips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), "{}");
    await writeFile(path.join(dir, "globals.css"), ":root { --color-bg: #ffffff; }");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runInit({ targetDir: dir, skipLlm: true, force: false });
    const out = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(code).toBe(0);
    expect(out).toContain("LLM steps skipped");
    expect(out).not.toContain("only fills gaps"); // coaching line is for missing keys, not an explicit --skip-llm
    await readFile(path.join(dir, ".vendo/theme.json"), "utf8");
  });
});

/** A wireable Next.js App Router fixture: layout, CSS vars, one API route, one component. */
async function wiredNextAppFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "init-rerun-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "host-app", dependencies: { next: "15.0.0" } }),
  );
  await writeFile(path.join(dir, "tsconfig.json"), "{}");
  await mkdir(path.join(dir, "app/api/things"), { recursive: true });
  await mkdir(path.join(dir, "components/ui"), { recursive: true });
  await writeFile(
    path.join(dir, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(path.join(dir, "app/globals.css"), ":root { --color-bg: #ffffff; --color-ink: #111111; }");
  await writeFile(path.join(dir, "app/api/things/route.ts"), "export async function GET() { return Response.json([]); }\n");
  await writeFile(path.join(dir, "components/ui/badge.tsx"), "export const Badge = () => null");
  return dir;
}

async function runCaptured(
  opts: Parameters<typeof runInit>[0],
): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runInit(opts);
    return {
      code,
      out: log.mock.calls.flat().join("\n"),
      err: err.mock.calls.flat().join("\n"),
    };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("additive re-run (decision matrix)", () => {
  it("no-key run coaches + writes deterministic tools; keyed re-run fills components without touching theme/tools", async () => {
    const dir = await wiredNextAppFixture();

    // Run 1: no provider key (model: null). Must exit 0, end with coaching,
    // and still produce deterministic route tools with placeholder metadata.
    const first = await runCaptured({ targetDir: dir, skipLlm: false, force: false, model: null });
    expect(first.code).toBe(0);
    expect(first.out).toContain("only fills gaps");
    expect(first.out).toContain("re-run");
    const deterministicTools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(deterministicTools).toMatchObject({
      version: 1,
      events: [],
      tools: [{
        name: "getThings",
        description: "GET /api/things",
        inputSchema: { type: "object", properties: {} },
        annotations: { mutating: true, dangerous: false },
        binding: { type: "http", method: "GET", path: "/api/things" },
      }],
    });

    // Hand-edit the extracted theme to prove the re-run preserves it.
    const themePath = path.join(dir, ".vendo/theme.json");
    const editedTheme = (await readFile(themePath, "utf8")).replace(/#ffffff/i, "#123456");
    await writeFile(themePath, editedTheme);

    // Run 2: keyed (mock model). The deterministic tools are real content now,
    // so additive init keeps them byte-for-byte and fills only missing wrappers.
    const second = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(second.code).toBe(0);
    expect(second.out).toContain("theme.json: kept");
    expect(second.out).toContain("tools.json: kept");
    expect(await readFile(themePath, "utf8")).toBe(editedTheme);
    const tools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(tools).toEqual(deterministicTools);
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
  });

  it("hand-edited theme.json and real tools.json survive a plain re-run byte-for-byte, with no LLM calls", async () => {
    const dir = await wiredNextAppFixture();
    const first = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(first.code).toBe(0);

    const themePath = path.join(dir, ".vendo/theme.json");
    const toolsPath = path.join(dir, ".vendo/tools.json");
    const implPath = path.join(dir, ".vendo/components/Badge/impl.tsx");
    const editedTheme = (await readFile(themePath, "utf8")).replace(/#ffffff/i, "#123456");
    const editedTools = (await readFile(toolsPath, "utf8")).replace("getThings", "getWidgets");
    await writeFile(themePath, editedTheme);
    await writeFile(toolsPath, editedTools);
    const implBefore = await readFile(implPath, "utf8");

    // Fully initialized: a plain re-run must not consult the LLM at all.
    const second = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: throwingModel("LLM must not be called on a fully-initialized re-run"),
    });
    expect(second.code).toBe(0);
    expect(second.err).not.toContain("LLM must not be called");
    expect(second.out).toContain("theme.json: kept");
    expect(second.out).toContain("tools.json: kept");
    expect(second.out).toContain("components/: kept");
    expect(second.out).not.toContain("FAILED");
    expect(await readFile(themePath, "utf8")).toBe(editedTheme);
    expect(await readFile(toolsPath, "utf8")).toBe(editedTools);
    expect(await readFile(implPath, "utf8")).toBe(implBefore);
  });

  it("plain re-run with an existing component catalog does not add newly scanned wrappers", async () => {
    const dir = await wiredNextAppFixture();
    const first = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(first.code).toBe(0);

    await writeFile(path.join(dir, "components/ui/panel.tsx"), "export const Panel = () => null");

    const second = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: throwingModel("LLM must not be called on a plain re-run with an existing component catalog"),
    });
    expect(second.code).toBe(0);
    expect(second.err).not.toContain("LLM must not be called");
    expect(second.out).toContain("components/: kept");
    await expect(readFile(path.join(dir, ".vendo/components/Panel/impl.tsx"), "utf8")).rejects.toThrow();
  });

  it("re-extracts theme over the wiring-written default stub once CSS vars are available", async () => {
    const dir = await wiredNextAppFixture();
    // Simulate a first run whose extraction produced no theme.json, leaving
    // only the default-brand stub next-wiring's step 0 writes.
    await mkdir(path.join(dir, ".vendo"), { recursive: true });
    const themePath = path.join(dir, ".vendo/theme.json");
    await writeFile(themePath, JSON.stringify(DEFAULT_THEME_STUB, null, 2) + "\n");

    const run = await runCaptured({ targetDir: dir, skipLlm: true, force: false });
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("theme.json: kept");
    expect(run.out).toContain("theme.json: written");
    const theme = JSON.parse(await readFile(themePath, "utf8"));
    expect(theme.background).toBe("#ffffff"); // from app/globals.css — the stub was replaced
  });

  it("plain re-run on a fully-initialized app exits 0 even without a key", async () => {
    const dir = await wiredNextAppFixture();
    const first = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(first.code).toBe(0);

    const second = await runCaptured({ targetDir: dir, skipLlm: false, force: false, model: null });
    expect(second.code).toBe(0);
    expect(second.out).toContain("theme.json: kept");
    expect(second.out).toContain("tools.json: kept");
  });

  it("prints the first-run onboarding block on a fresh (unwired) app", async () => {
    const dir = await wiredNextAppFixture();
    const run = await runCaptured({ targetDir: dir, skipLlm: true, force: false });
    expect(run.code).toBe(0);
    expect(run.out).toContain("Next steps:");
  });

  it("init on an already-wired app suppresses the onboarding block", async () => {
    const dir = await wiredNextAppFixture();
    const first = await runCaptured({ targetDir: dir, skipLlm: true, force: false });
    expect(first.code).toBe(0);
    expect(first.out).toContain("Next steps:"); // first run: not yet wired

    // Second plain `init` — the app is now wired, so it must catch up like refresh.
    const second = await runCaptured({ targetDir: dir, skipLlm: true, force: false });
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("Next steps:");
  });

  it("--force regenerates all artifacts and prints a warning listing the overwrites first", async () => {
    const dir = await wiredNextAppFixture();
    const first = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(first.code).toBe(0);

    const themePath = path.join(dir, ".vendo/theme.json");
    const editedTheme = (await readFile(themePath, "utf8")).replace(/#ffffff/i, "#123456");
    await writeFile(themePath, editedTheme);

    const second = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: true,
      model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
    });
    expect(second.code).toBe(0);
    expect(second.out).toContain(".vendo/theme.json");
    expect(second.out).toContain(".vendo/tools.json");
    expect(second.out).toContain(".vendo/components/Badge/");
    expect(second.out).toContain(".vendo/components/entry.ts");
    expect(second.out).toContain(".vendo/components/vite.config.mts");
    expect(second.out).toContain(".vendo/README.md");
    expect(second.out).toMatch(/overwrit/i);
    // The warning prints before any extraction output.
    expect(second.out.indexOf("--force")).toBeGreaterThanOrEqual(0);
    expect(second.out.indexOf("--force:")).toBeLessThan(second.out.indexOf("framework:"));
    // Hand-edit was regenerated away.
    expect(await readFile(themePath, "utf8")).not.toContain("#123456");
  });
});
