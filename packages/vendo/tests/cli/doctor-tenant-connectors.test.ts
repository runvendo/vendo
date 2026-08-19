/**
 * The static tenant-connector check: a source marker and two env names, and
 * nothing else. Doctor never opens the store and never dials a tenant server,
 * so every fixture here is files on disk.
 *
 * The one that must be able to fail: drop the env test and phase 2 goes red;
 * drop the source marker and phase 3 goes red.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import type { DoctorCheck } from "../../src/cli/doctor-report.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

/** A pinned model credential, so the fixtures below are about THIS check. */
const MODEL_PINNED = { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-test" };

/** A minimal wired host; `reachesApi` decides whether its source names the API,
 *  and `ownStore` whether it builds its own store instead of taking Cloud's. */
async function host(reachesApi: boolean, ownStore = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-tenant-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0" } }));
  await write("src/server.ts", ownStore
    ? 'import { createStore, createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ principal, store: createStore({ url }) });\n'
    : 'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ principal });\n');
  await write("src/client.tsx", "export const App = () => <VendoProvider><VendoOverlay /></VendoProvider>;\n");
  if (reachesApi) {
    await write("src/admin.ts", 'export const add = (input) => vendo.tenantConnectors.register(input);\n');
  }
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

/** Doctor's own report for one host, under an exactly-known environment. */
async function vaultCheck(
  reachesApi: boolean,
  env: Record<string, string> = {},
  ownStore = false,
): Promise<DoctorCheck | undefined> {
  const lines: string[] = [];
  await runDoctor({
    targetDir: await host(reachesApi, ownStore),
    json: true,
    env: { ...MODEL_PINNED, ...env },
    output: { log: (line) => lines.push(line), error: () => undefined },
  });
  const report = JSON.parse(lines.at(-1) ?? "{}") as { checks?: DoctorCheck[] };
  return report.checks?.find((check) => check.id === "wiring/tenant-connector-vault");
}

describe("the tenant-connector vault check", () => {
  it("says nothing at all to a host that does not use the API", async () => {
    expect(await vaultCheck(false)).toBeUndefined();
    // …not even when the key is missing, which is the whole point of the marker.
    expect(await vaultCheck(false, { VENDO_STORE_ENCRYPTION_KEY: "" })).toBeUndefined();
  });

  it("warns E-TENANT-001 when the tokens have nowhere encrypted to live", async () => {
    const check = await vaultCheck(true);
    expect(check).toMatchObject({ status: "warning", error_code: "E-TENANT-001" });
    expect(check?.message).toContain("VENDO_STORE_ENCRYPTION_KEY");
    // The failure it is really about is the DEPLOY, and it says so.
    expect(check?.message).toContain("REFUSED outright in production");
    // The code is in the PATH, not a fragment: a fragment never reaches the
    // server, so it could not select the code's own troubleshooting page.
    expect(check?.fix_ref).toContain("/production/troubleshooting/e-tenant-001");
  });

  it("passes on either vault: the host's own key, or Cloud's", async () => {
    const vaults: Array<Record<string, string>> = [
      { VENDO_STORE_ENCRYPTION_KEY: "Zm9vYmFy" },
      { VENDO_API_KEY: "vk_test" },
    ];
    for (const env of vaults) {
      expect(await vaultCheck(true, env)).toMatchObject({ status: "ok" });
    }
  });

  it("does not let a Cloud key green a host that passes its own store", async () => {
    // An explicitly passed store WINS over VENDO_API_KEY (the adapter rule), so
    // Cloud never composes and there is no vault — the shape the live proof
    // caught printing "ok" one line before the registration was refused.
    const check = await vaultCheck(true, { VENDO_API_KEY: "vk_test" }, true);
    expect(check).toMatchObject({ status: "warning", error_code: "E-TENANT-001" });
    expect(check?.message).toContain("this host passes its own createStore()");
    // Its own key still satisfies it, own store or not.
    expect(await vaultCheck(true, { VENDO_API_KEY: "vk_test", VENDO_STORE_ENCRYPTION_KEY: "Zm9vYmFy" }, true))
      .toMatchObject({ status: "ok" });
  });

  it("keeps doctor green — which vault a host uses is its own call", async () => {
    const root = await host(true);
    const exit = await runDoctor({
      targetDir: root,
      json: true,
      env: MODEL_PINNED,
      output: { log: () => undefined, error: () => undefined },
    });
    expect(exit).toBe(0);
  });
});
