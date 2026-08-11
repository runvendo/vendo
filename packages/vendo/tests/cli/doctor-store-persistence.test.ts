import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStorePersistence } from "../../src/cli/doctor-config-checks.js";
import { createDoctorRun, type DoctorRun } from "../../src/cli/doctor-report.js";

// The static twin of the store's boot warning: the PGlite default writes under
// the project root, so an ephemeral root loses every app the product's users
// built on the next redeploy.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function project(options: { booted: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-store-persistence-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".vendo", "data"), { recursive: true });
  await writeFile(join(root, ".vendo", "data", ".gitignore"), "*\n");
  // PG_VERSION is what initdb writes: the evidence a real database lives here.
  if (options.booted) await writeFile(join(root, ".vendo", "data", "PG_VERSION"), "15\n");
  return root;
}

function run(root: string, env: Record<string, string | undefined> = {}): DoctorRun {
  return createDoctorRun({
    root,
    env,
    json: true, // no console lines from the reporters
    statusUrl: "http://localhost:3000/api/vendo",
    fetchImpl: fetch,
    output: { log: () => {}, error: () => {} },
  });
}

describe("store/persistence (E-STORE-001)", () => {
  it("warns when a booted store's data dir sits under /tmp", async () => {
    const root = await project({ booted: true });
    const doctor = run(root);

    await checkStorePersistence(doctor);

    const check = doctor.checks.find((candidate) => candidate.id === "store/persistence");
    expect(check?.status).toBe("warning");
    expect(check?.error_code).toBe("E-STORE-001");
    expect(check?.fix_ref).toContain("#E-STORE-001");
    expect(check?.message).toContain(join(root, ".vendo", "data"));
    expect(check?.message).toContain("wipes it on every redeploy");
    expect(doctor.failures).toBe(0); // ephemeral disk is a warning, never a block
  });

  it.each([
    ["RAILWAY_ENVIRONMENT", "production", "Railway"],
    ["RENDER", "true", "Render"],
    ["FLY_APP_NAME", "maple", "Fly.io"],
    ["DYNO", "web.1", "Heroku"],
  ])("warns on %s before any data exists", async (marker, value, platform) => {
    const doctor = run("/srv/maple", { [marker]: value });

    await checkStorePersistence(doctor);

    const check = doctor.checks.find((candidate) => candidate.id === "store/persistence");
    expect(check?.error_code).toBe("E-STORE-001");
    expect(check?.message).toContain(`${platform} wipes it on every redeploy`);
  });

  it("stays silent on a persistent disk", async () => {
    const doctor = run("/srv/maple");

    await checkStorePersistence(doctor);

    expect(doctor.checks).toEqual([]);
    expect(doctor.warnings).toBe(0);
  });

  // The local PGlite default is only the store when no Cloud key fills the slot
  // (selectStore, compose-store.ts). Warning on a Cloud deployment names a
  // directory nothing writes — to every Cloud user, on every doctor run.
  it.each([
    ["RAILWAY_ENVIRONMENT", "production"],
    ["RENDER", "true"],
    ["FLY_APP_NAME", "maple"],
    ["DYNO", "web.1"],
  ])("stays silent on %s when VENDO_API_KEY composes the hosted store", async (marker, value) => {
    const doctor = run("/srv/maple", { [marker]: value, VENDO_API_KEY: "vk_live_test" });

    await checkStorePersistence(doctor);

    expect(doctor.checks).toEqual([]);
    expect(doctor.warnings).toBe(0);
  });

  // `environment()` (wire/shared.ts) accepts ANY non-empty string, so a
  // whitespace-only key still composes hostedStore and .vendo/data is never
  // written. Doctor must read the key the same way it is read at runtime.
  it("stays silent when VENDO_API_KEY is whitespace, because the hosted store still composes", async () => {
    const doctor = run("/srv/maple", { RAILWAY_ENVIRONMENT: "production", VENDO_API_KEY: "  " });

    await checkStorePersistence(doctor);

    expect(doctor.checks).toEqual([]);
    expect(doctor.warnings).toBe(0);
  });

  // The other side of that boundary: an empty key is what `environment()`
  // itself rejects, so the local PGlite store is what composes and the warning
  // is the truth.
  it("still warns when VENDO_API_KEY is set but empty", async () => {
    const doctor = run("/srv/maple", { RAILWAY_ENVIRONMENT: "production", VENDO_API_KEY: "" });

    await checkStorePersistence(doctor);

    expect(doctor.checks.find((candidate) => candidate.id === "store/persistence")?.error_code)
      .toBe("E-STORE-001");
  });

  it("stays silent for a scratch project under /tmp with no database in it", async () => {
    const root = await project({ booted: false });
    const doctor = run(root);

    await checkStorePersistence(doctor);

    expect(doctor.checks).toEqual([]);
  });
});
