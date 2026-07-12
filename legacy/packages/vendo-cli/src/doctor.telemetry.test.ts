import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** A no-op Ui so the checks run without touching the console. */
function silentUi(): Ui {
  return createUi({ sink: () => {}, tty: false, colors: false });
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

function healthyApp(): string {
  const dir = tmp("vendo-doctor-tele-");
  write(dir, "package.json", JSON.stringify({ name: "maple-bank", dependencies: { "@vendoai/next": "latest", "@electric-sql/pglite": "^0.2.0" } }));
  write(dir, "node_modules/@vendoai/next/package.json", JSON.stringify({ name: "@vendoai/next" }));
  write(dir, "node_modules/@electric-sql/pglite/package.json", JSON.stringify({ name: "@electric-sql/pglite" }));
  write(dir, "next.config.ts", HEALTHY_NEXT_CONFIG);
  write(dir, "app/layout.tsx", WRAPPED_LAYOUT);
  write(dir, "app/vendo-root.tsx", `export function AppVendoRoot() { return null; }\n`);
  write(dir, "app/api/vendo/[...path]/route.ts", `export const GET = () => {};\n`);
  write(dir, "instrumentation.ts", `export async function register() { const { startVendoScheduler } = await import("@vendoai/next"); startVendoScheduler(); }\n`);
  write(dir, ".vendo/theme.json", JSON.stringify({ version: 1, accent: "#123456", background: "#fff", surface: "#eee", text: "#000", mutedText: "#555", fontFamily: "Inter", radius: 10, mode: "light" }));
  write(dir, ".vendo/tools.json", JSON.stringify({ version: 1, tools: [{ name: "listAccounts" }], events: [] }));
  write(dir, ".vendo/components/BalanceCard/descriptor.ts", "export const d = {};\n");
  write(dir, ".vendo/components/BalanceCard/impl.tsx", "export const C = () => null;\n");
  write(dir, "public/vendo/react-runtime.js", "RUNTIME-BYTES");
  write(dir, "public/vendo/components-sandbox.js", "SANDBOX-BYTES");
  mkdirSync(join(dir, ".vendo/data"), { recursive: true });
  return dir;
}

/** The doctor_run properties captured by the fetch spy. */
function doctorProps(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  for (const call of fetchImpl.mock.calls) {
    const body = JSON.parse((call[1] as { body: string }).body);
    if (body.event === "doctor_run") return body.properties ?? {};
  }
  throw new Error("no doctor_run event captured");
}

describe("doctor telemetry", () => {
  it("emits doctor_run with failures:0 and wired:true on a healthy install", async () => {
    const dir = healthyApp();
    const home = tmp("vendo-doctor-tele-home-");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const code = await runDoctor({
      targetDir: dir,
      ui: silentUi(),
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    });
    expect(code).toBe(0);
    const props = doctorProps(fetchImpl);
    expect(props.failures).toBe(0);
    expect(props.warnings).toEqual(expect.any(Number));
    expect(props.wired).toBe(true);
  });

  it("emits doctor_run with failures>0 and wired:false on a broken install", async () => {
    const dir = tmp("vendo-doctor-tele-broken-");
    write(dir, "package.json", JSON.stringify({ name: "empty" }));
    const home = tmp("vendo-doctor-tele-home-");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const code = await runDoctor({
      targetDir: dir,
      ui: silentUi(),
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    });
    expect(code).toBe(1);
    const props = doctorProps(fetchImpl);
    expect(props.failures as number).toBeGreaterThan(0);
    expect(props.wired).toBe(false);
  });

  it("never puts app content (name/path) in the doctor_run body — counts and bools only", async () => {
    const dir = healthyApp();
    const home = tmp("vendo-doctor-tele-home-");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await runDoctor({
      targetDir: dir,
      ui: silentUi(),
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
    });
    const allBodies = fetchImpl.mock.calls.map((c) => (c[1] as { body: string }).body).join("\n");
    for (const leak of ["maple-bank", "sk-ant-xxx", "BalanceCard", "listAccounts", dir]) {
      expect(allBodies).not.toContain(leak);
    }
  });

  it("sends nothing when telemetry is opted out", async () => {
    const dir = healthyApp();
    const home = tmp("vendo-doctor-tele-home-");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await runDoctor({
      targetDir: dir,
      ui: silentUi(),
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      // VENDO_TELEMETRY_DISABLED disables product telemetry via the shared plumbing.
      telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test", VENDO_TELEMETRY_DISABLED: "1" }, fetchImpl },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
