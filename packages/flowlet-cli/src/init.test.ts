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
  it("emits all three artifacts + README into .flowlet only", async () => {
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
    const theme = JSON.parse(await readFile(path.join(dir, ".flowlet/theme.json"), "utf8"));
    expect(theme.background).toBe("#ffffff");
    const tools = JSON.parse(await readFile(path.join(dir, ".flowlet/tools.json"), "utf8"));
    expect(tools.tools[0].name).toBe("list_things");
    await readFile(path.join(dir, ".flowlet/components/Badge/impl.tsx"), "utf8");
    await readFile(path.join(dir, ".flowlet/README.md"), "utf8");
  });

  it("reports a clean error (not an unhandled rejection) when the model factory throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), "{}");
    const prevModel = process.env["FLOWLET_CLI_MODEL"];
    // An unknown provider prefix makes resolveModelChoice (via cliModel) throw
    // synchronously — deterministic regardless of which optional peers happen
    // to be installed in this workspace.
    process.env["FLOWLET_CLI_MODEL"] = "grok/whatever";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runInit({ targetDir: dir, skipLlm: false, force: false });
      expect(code).toBe(1);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/unknown provider "grok"/);
    } finally {
      errSpy.mockRestore();
      if (prevModel === undefined) delete process.env["FLOWLET_CLI_MODEL"];
      else process.env["FLOWLET_CLI_MODEL"] = prevModel;
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
    await readFile(path.join(dir, ".flowlet/theme.json"), "utf8");
  });
});
