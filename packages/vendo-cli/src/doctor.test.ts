import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "./doctor.js";
import { createUi, type Ui } from "./ui.js";
import { VENDO_TRANSPILE_PACKAGES } from "./next-wiring.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** A Ui whose output is captured into a string array for assertions. */
function captureUi(): { ui: Ui; text: () => string } {
  const lines: string[] = [];
  const ui = createUi({ sink: (chunk) => lines.push(chunk), tty: false, colors: false });
  return { ui, text: () => lines.join("") };
}

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

const HEALTHY_NEXT_CONFIG =
  `const nextConfig = {\n` +
  `  transpilePackages: [\n${VENDO_TRANSPILE_PACKAGES.map((p) => `    ${JSON.stringify(p)},`).join("\n")}\n  ],\n` +
  `  serverExternalPackages: ["@electric-sql/pglite"],\n` +
  `};\nexport default nextConfig;\n`;

const WRAPPED_LAYOUT =
  `import { AppVendoRoot } from "./vendo-root";\n` +
  `export default function RootLayout({ children }) {\n` +
  `  return (<html><body><AppVendoRoot>{children}</AppVendoRoot></body></html>);\n` +
  `}\n`;

/** Builds a fully-wired, healthy Vendo app; caller can then break pieces. */
function healthyApp(): string {
  const dir = tmp("vendo-doctor-healthy-");
  write(dir, "package.json", JSON.stringify({ name: "maple-bank", dependencies: { "@vendoai/next": "latest", "@electric-sql/pglite": "^0.2.0" } }));
  write(dir, "node_modules/@vendoai/next/package.json", JSON.stringify({ name: "@vendoai/next" }));
  write(dir, "node_modules/@electric-sql/pglite/package.json", JSON.stringify({ name: "@electric-sql/pglite" }));
  write(dir, "next.config.ts", HEALTHY_NEXT_CONFIG);
  write(dir, "app/layout.tsx", WRAPPED_LAYOUT);
  write(dir, "app/vendo-root.tsx", `export function AppVendoRoot() { return null; }\n`);
  write(dir, "app/api/vendo/[...path]/route.ts", `export const GET = () => {};\n`);
  write(dir, "instrumentation.ts", `export async function register() { const { startVendoScheduler } = await import("@vendoai/next"); startVendoScheduler(); }\n`);
  write(dir, ".vendo/theme.json", JSON.stringify({ version: 1, accent: "#123456", background: "#fff", surface: "#eee", text: "#000", mutedText: "#555", fontFamily: "Inter", radius: 10, mode: "light" }));
  write(dir, ".vendo/tools.json", JSON.stringify({ version: 1, tools: [{ name: "listAccounts" }, { name: "transfer" }], events: [] }));
  write(dir, ".vendo/components/BalanceCard/descriptor.ts", "export const d = {};\n");
  write(dir, ".vendo/components/BalanceCard/impl.tsx", "export const C = () => null;\n");
  write(dir, "public/vendo/react-runtime.js", "RUNTIME-BYTES");
  write(dir, "public/vendo/components-sandbox.js", "SANDBOX-BYTES");
  mkdirSync(join(dir, ".vendo/data"), { recursive: true }); // PGlite dir exists + writable
  return dir;
}

describe("runDoctor — healthy fixture", () => {
  it("passes every check with exit 0 and no failure lines", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });

    const out = text();
    expect(code).toBe(0);
    expect(out).not.toContain("×"); // no hard-failure marks
    expect(out).toContain("provider key detected");
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("capabilities: chat");
    expect(out).toContain("route handler: app/api/vendo");
    expect(out).toContain("vendo-root wrapper");
    expect(out).toContain("root layout wraps <AppVendoRoot>");
    expect(out).toContain("next.config.ts: transpilePackages");
    expect(out).toContain("dependency installed: @vendoai/next");
    expect(out).toContain("dependency installed: @electric-sql/pglite");
    expect(out).toContain("theme.json: customized");
    expect(out).toContain("tools.json: host API tools");
    expect(out).toContain("2 tools");
    expect(out).toContain("components wrapped");
    expect(out).toContain("storage: embedded PGlite");
    expect(out).toContain("scheduler: in-process");
    expect(out).toContain("telemetry: enabled");
    // No bundled reference in an unbuilt test run → freshness degrades honestly.
    expect(out).toContain("freshness not verified");
  });

  it("treats a not-yet-created PGlite data dir as ok (fresh install), not a warning", async () => {
    const dir = healthyApp();
    rmSync(join(dir, ".vendo/data"), { recursive: true, force: true }); // dir absent; parent .vendo writable
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });
    const out = text();
    expect(code).toBe(0);
    expect(out).toContain("storage: embedded PGlite");
    expect(out).toContain("created on first run");
    // ok line, not a yellow warn with a fix.
    expect(out).not.toContain("data dir not created yet");
  });

  it("reports Postgres storage when DATABASE_URL is set", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({
      targetDir: dir,
      ui,
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx", DATABASE_URL: "postgres://localhost/db" },
    });
    expect(code).toBe(0);
    expect(text()).toContain("storage: Postgres (DATABASE_URL set)");
  });
});

describe("runDoctor — broken wiring fixture", () => {
  it("exits 1 with fix lines for a missing route handler and vendo-root", async () => {
    const dir = tmp("vendo-doctor-broken-");
    write(dir, "package.json", JSON.stringify({ name: "empty" }));
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });

    const out = text();
    expect(code).toBe(1);
    expect(out).toContain("× route handler missing");
    expect(out).toContain("× vendo-root wrapper missing");
    expect(out).toContain("× next.config not found");
    expect(out).toContain("× dependency not installed: @vendoai/next");
    // Every failure line is followed by an actionable fix line.
    expect(out).toContain("fix: run `vendo init`");
  });

  it("hard-fails when the root layout does not wrap {children}", async () => {
    const dir = healthyApp();
    write(dir, "app/layout.tsx", `export default function RootLayout({ children }) { return (<html><body>{children}</body></html>); }\n`);
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });
    expect(code).toBe(1);
    expect(text()).toContain("× root layout does not wrap {children}");
  });
});

describe("runDoctor — sandbox asset staleness", () => {
  it("warns (exit 0) when an installed asset differs from the CLI's bundled copy", async () => {
    const dir = healthyApp();
    const bundled = tmp("vendo-doctor-assets-");
    // React runtime matches; components-sandbox differs → stale.
    writeFileSync(join(bundled, "vendo-react-runtime.js"), "RUNTIME-BYTES");
    writeFileSync(join(bundled, "vendo-components-sandbox.js"), "NEW-SANDBOX-BYTES");
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" }, bundledAssetsDir: bundled });

    const out = text();
    expect(code).toBe(0); // stale assets are a warning, not a hard failure
    expect(out).toContain("sandbox asset public/vendo/react-runtime.js up to date");
    expect(out).toContain("public/vendo/components-sandbox.js is stale");
  });

  it("warns when an installed sandbox asset is missing entirely", async () => {
    const dir = healthyApp();
    rmSync(join(dir, "public/vendo/components-sandbox.js"));
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });
    expect(code).toBe(0);
    expect(text()).toContain("sandbox asset public/vendo/components-sandbox.js missing");
  });
});

describe("runDoctor — no-key fixture", () => {
  it("warns (exit 0) and reports deterministic-only capabilities", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: {} });

    const out = text();
    expect(code).toBe(0); // no key is a warning, wiring is intact
    expect(out).toContain("no provider key found");
    expect(out).toContain("capabilities: deterministic-only");
    expect(out).not.toContain("provider key detected");
  });
});

describe("runDoctor — model override sanity", () => {
  it("hard-fails an unknown-provider override when a key is set", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx", VENDO_MODEL: "grok/whatever" } });
    expect(code).toBe(1);
    expect(text()).toContain("× model override invalid");
  });

  it("accepts a valid provider/model override", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx", VENDO_CLI_MODEL: "openai/gpt-5.5-mini" } });
    expect(code).toBe(0);
    expect(text()).toContain("model override: openai/gpt-5.5-mini");
    expect(text()).toContain("resolves to openai/gpt-5.5-mini");
  });

  it("only warns for a bad override when no key is set (chat already off)", async () => {
    const dir = healthyApp();
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { VENDO_MODEL: "grok/whatever" } });
    expect(code).toBe(0);
    expect(text()).toContain("model override invalid (no key set");
  });
});

describe("runDoctor — scheduler + tools state", () => {
  it("warns when instrumentation is absent and when tools are the empty fallback", async () => {
    const dir = healthyApp();
    rmSync(join(dir, "instrumentation.ts"));
    write(dir, ".vendo/tools.json", JSON.stringify({ version: 1, tools: [], events: [] }));
    const { ui, text } = captureUi();
    const home = tmp("vendo-doctor-home-");
    const code = await runDoctor({ targetDir: dir, ui, home, env: { ANTHROPIC_API_KEY: "sk-ant-xxx" } });

    const out = text();
    expect(code).toBe(0);
    expect(out).toContain("scheduler: not wired");
    expect(out).toContain("tools.json: empty fallback");
  });
});
