/**
 * The static twin of the boot block's ⚠ guard row: a host whose guard reads its
 * rules from a file, and no file. Doctor is static, so the whole fixture is two
 * things on disk — the wiring's spelling, and whether `.vendo/policy.json` is
 * there.
 *
 * The one that must be able to fail: drop the file test and phase 2 goes red;
 * drop the source marker and phase 1 goes red.
 */
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
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

/** How this host spells its guard. `file` is what `vendo init` writes; `inline`
 *  is the opt-out — rules in code replace the file entirely; `none` wires no
 *  policy at all. */
type Wiring = "file" | "inline" | "none";

const GUARD_LINE: Record<Wiring, string> = {
  file: "guard: guard({ policy: {} }),",
  inline: "guard: guard({ policy: { rules: [{ match: { risk: \"destructive\" }, action: \"ask\" }] } }),",
  none: "",
};

async function host(wiring: Wiring, policyFile: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-policy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0" } }));
  await write("src/server.ts",
    'import { createVendo, guard } from "@vendoai/vendo/server";\n'
    + `export const vendo = createVendo({ principal, ${GUARD_LINE[wiring]} });\n`);
  await write("src/client.tsx", "export const App = () => <VendoProvider><VendoOverlay /></VendoProvider>;\n");
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  // Removed rather than never written, so the fixture differs from the healthy
  // one in exactly the thing under test.
  if (!policyFile) await unlink(join(root, ".vendo", "policy.json"));
  return root;
}

/** Doctor's own report for one host. */
async function policyCheck(wiring: Wiring, policyFile: boolean): Promise<DoctorCheck | undefined> {
  const lines: string[] = [];
  await runDoctor({
    targetDir: await host(wiring, policyFile),
    json: true,
    env: MODEL_PINNED,
    output: { log: (line) => lines.push(line), error: () => undefined },
  });
  const report = JSON.parse(lines.at(-1) ?? "{}") as { checks?: DoctorCheck[] };
  return report.checks?.find((check) => check.id === "wiring/policy-file");
}

describe("the policy-file check", () => {
  it("warns that the host's own rules are not in force, and how to get them back", async () => {
    const check = await policyCheck("file", false);
    expect(check).toMatchObject({ status: "warning", error_code: "E-CFG-001" });
    expect(check?.message).toContain(".vendo/policy.json");
    // The consequence, which mere absence does not say: the deployment SERVES,
    // on a posture the host did not write.
    expect(check?.message).toContain("YOUR rules are not in force");
    expect(check?.message).toContain("destructive and ungraded actions ask");
    expect(check?.message).toContain("guard({ policy: { rules: [ … ] } })");
    // The code is in the PATH, not a fragment: a fragment never reaches the
    // server, so it could not select the code's own troubleshooting page.
    expect(check?.fix_ref).toContain("/production/troubleshooting/e-cfg-001");
  });

  it("passes the same host once the file is there", async () => {
    expect(await policyCheck("file", true)).toMatchObject({ status: "ok" });
  });

  // A host with its rules in code is correctly configured with no file, and
  // telling it otherwise would be a lie — the inventory check (config/policy.json)
  // already reports mere absence for every surface alike.
  it("says nothing at all to a host that does not read its rules from a file", async () => {
    expect(await policyCheck("inline", false)).toBeUndefined();
    expect(await policyCheck("none", false)).toBeUndefined();
  });
});
