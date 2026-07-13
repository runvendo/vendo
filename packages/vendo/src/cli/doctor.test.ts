import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "./doctor.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function healthy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-"));
  cleanup.push(root);
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0", next: "16" } }));
  await write("app/layout.tsx", "export default ({children}) => <VendoRoot>{children}</VendoRoot>;");
  await write("app/api/vendo/[...vendo]/route.ts", "export const GET = () => {};\n");
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

describe("vendo doctor", () => {
  it("checks wiring and performs one live status round-trip", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      posture: "unconfigured",
      version: "0.3.0",
      blocks: { store: true },
    }));
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      output: { log() {}, error() {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/vendo/status");
  });

  it("returns one for broken wiring or an unreachable live handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-broken-"));
    cleanup.push(root);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await runDoctor({ targetDir: root, fetchImpl, output: { log() {}, error() {} } })).toBe(1);
  });
});
