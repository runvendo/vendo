import { installedAiVersion, installedZodVersion } from "./dep-versions.js";
import { aiBelowPeerFloor, aiBumpInvocation, zodBelowAiSdkFloor, zodBumpInvocation } from "./provider-deps.js";
import type { DoctorRun } from "./doctor-report.js";

/** #478 short-term — @vendoai/vendo speaks AI SDK v6 to the host's `ai`
 *  package (peer `ai >=6 <7`), but npm installs the peer conflict anyway:
 *  the static checks all pass and every internal turn then throws
 *  AI_InvalidPromptError (v7 removed system-role messages). Fail fast on the
 *  installed major, above OR below the contract — a resolvable pre-v6 copy
 *  (usually another package's hoisted install) sailed green into runtime
 *  500s (FINDINGS F3). An absent install stays the wiring/turn checks'
 *  story. */
async function checkAiSdkMajor(run: DoctorRun): Promise<void> {
  const aiVersion = await installedAiVersion(run.root);
  const aiMajor = aiVersion === null ? Number.NaN : Number.parseInt(aiVersion, 10);
  if (aiMajor >= 7) {
    run.fail("deps/ai-sdk-major", "E-DEP-001", `installed ai@${aiVersion} is unsupported — Vendo supports ai@6; downgrade (npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3) or track github.com/runvendo/vendo/issues/478`);
  } else if (aiMajor === 6) {
    run.pass("deps/ai-sdk-major", `installed ai@${aiVersion} is the supported AI SDK major (v6)`);
  } else if (aiVersion !== null && aiBelowPeerFloor(aiVersion)) {
    run.fail("deps/ai-sdk-major", "E-DEP-001", `installed ai@${aiVersion} predates the ai@6 peer contract — every turn fails at runtime; upgrade: ${await aiBumpInvocation(run.root)}. In a workspace, another package's ai@${aiMajor} may be hoisted above the app — give the app its own ai@6 (or a packageExtension/override) so @vendoai packages resolve v6.`);
  }
}

/** FINDINGS F2 — ai@6 imports the zod/v3 + zod/v4 subpaths that arrive in
 *  zod 3.25; a host pinning older zod builds red inside ai the moment the
 *  vendo wiring pulls it into the bundle. An absent zod skips silently: a
 *  host without its own zod resolves ai's copy, which always satisfies. */
async function checkZodFloor(run: DoctorRun): Promise<void> {
  const zodVersion = await installedZodVersion(run.root);
  if (zodVersion !== null && zodBelowAiSdkFloor(zodVersion)) {
    run.fail("deps/zod-floor", "E-DEP-003", `installed zod@${zodVersion} predates the zod/v3 + zod/v4 subpaths the AI SDK imports (needs >=3.25) — the app build fails inside ai@6; bump within zod 3: ${await zodBumpInvocation(run.root)}`);
  } else if (zodVersion !== null) {
    run.pass("deps/zod-floor", `installed zod@${zodVersion} exposes the AI SDK's zod/v3 + zod/v4 subpaths (>=3.25)`);
  }
}

/** What the target project actually has installed beside Vendo. */
export async function checkInstalledDeps(run: DoctorRun): Promise<void> {
  await checkAiSdkMajor(run);
  await checkZodFloor(run);
}
