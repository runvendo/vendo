import { installedAiVersion, installedZodVersion, isOlderVersion, npmLatestVersion } from "./dep-versions.js";
import { zodBelowAiSdkFloor, zodBumpInvocation } from "./provider-deps.js";
import type { DoctorRun } from "./doctor-report.js";
import { CLI_VERSION, type Output } from "./shared.js";

/** #478 short-term — @vendoai/vendo speaks AI SDK v6 to the host's `ai`
 *  package (peer `ai >=6 <7`), but npm installs the peer conflict anyway:
 *  the static checks all pass and every internal turn then throws
 *  AI_InvalidPromptError (v7 removed system-role messages). Fail fast on the
 *  installed major. An absent install is the wiring/turn checks' story, and
 *  pre-v6 installs predate the peer contract — both skip silently. */
async function checkAiSdkMajor(run: DoctorRun): Promise<void> {
  const aiVersion = await installedAiVersion(run.root);
  const aiMajor = aiVersion === null ? Number.NaN : Number.parseInt(aiVersion, 10);
  if (aiMajor >= 7) {
    run.fail("deps/ai-sdk-major", "E-DEP-001", `installed ai@${aiVersion} is unsupported — Vendo supports ai@6; downgrade (npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3) or track github.com/runvendo/vendo/issues/478`);
  } else if (aiMajor === 6) {
    run.pass("deps/ai-sdk-major", `installed ai@${aiVersion} is the supported AI SDK major (v6)`);
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

/** Self-serve audit F1 — npm release-cooldown configs (`min-release-age`)
 *  resolve an old @vendoai/vendo silently, and Vendo ships often enough that
 *  those users stay permanently behind with nothing ever saying so. A hint,
 *  not a check: it has no fix_ref registry code and never changes the exit
 *  code, and an unreachable registry says nothing at all. Skipped outright
 *  under --json, so an agent run never pays for a lookup it cannot see. */
async function noteVersionBehindLatest(
  run: DoctorRun,
  output: Output,
  npmLatest: (() => Promise<string | null>) | undefined,
): Promise<void> {
  if (run.json) return;
  const latestPublished = await (npmLatest ?? (() => npmLatestVersion("@vendoai/vendo")))();
  if (latestPublished !== null && isOlderVersion(CLI_VERSION, latestPublished)) {
    output.error(`warning: installed @vendoai/vendo ${CLI_VERSION} is behind latest ${latestPublished} — npm install @vendoai/vendo@latest (release-cooldown npm configs like min-release-age resolve old versions silently)`);
  }
}

/** What the target project actually has installed beside Vendo. */
export async function checkInstalledDeps(
  run: DoctorRun,
  output: Output,
  npmLatest: (() => Promise<string | null>) | undefined,
): Promise<void> {
  await checkAiSdkMajor(run);
  await checkZodFloor(run);
  await noteVersionBehindLatest(run, output, npmLatest);
}
