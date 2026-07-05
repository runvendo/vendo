import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import { textModel } from "./test-helpers.js";

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
    expect(tools.tools[0].name).toBe("list_things");
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    const readme = await readFile(path.join(dir, ".vendo/README.md"), "utf8");
    expect(readme).toContain("## Events");
    expect(readme).toContain('"name": "charge.posted"');
    expect(readme).toContain("push at the source, relay webhooks, or poll upstream systems");
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
    await readFile(path.join(dir, ".vendo/theme.json"), "utf8");
  });
});
