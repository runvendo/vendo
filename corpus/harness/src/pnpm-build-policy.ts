import { readFile } from "node:fs/promises";
import path from "node:path";

const CURATION_KEYS = ["onlyBuiltDependencies", "neverBuiltDependencies", "allowBuilds"] as const;

/** Major of a `packageManager: "pnpm@x.y.z"` pin, or null when the field is
 * absent or pins another manager. */
function pinnedPnpmMajor(pkg: { packageManager?: unknown }): number | null {
  const field = pkg.packageManager;
  if (typeof field !== "string" || !field.startsWith("pnpm@")) return null;
  const major = Number.parseInt(field.slice("pnpm@".length).split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

/** pnpm ≥10 errors (ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES) on
 * dangerouslyAllowAllBuilds when the workspace already declares a curated
 * build allowlist — detect that curation, whether it lives in
 * pnpm-workspace.yaml (onlyBuiltDependencies/neverBuiltDependencies, or the
 * newer allowBuilds map umami uses) or in the package.json `pnpm` field
 * (ENG-334). Shared by the bootstrap and post-injection install-command
 * paths so both respect a repo's own build policy instead of forcing
 * dangerouslyAllowAllBuilds on top of it.
 *
 * The package.json `pnpm` field only counts under a packageManager pin ≤10:
 * pnpm 11 silently ignores the field, so for a repo that will run pnpm ≥11 —
 * a pin ≥11, or no pin at all (the harness environment provides pnpm 11,
 * same convention as inject.ts's writeStandalonePnpmWorkspaceOverrides) — a
 * legacy field is neither applied by pnpm nor in conflict with the blanket
 * flag, and dropping dangerouslyAllowAllBuilds for it would leave the repo
 * on pnpm 11's default build policy with required dependency builds skipped
 * (corpus-triage review finding: cubic P1). */
export async function pnpmDeclaresBuiltDependencies(installDir: string): Promise<boolean> {
  try {
    const source = await readFile(path.join(installDir, "pnpm-workspace.yaml"), "utf8");
    if (new RegExp(`^\\s*(${CURATION_KEYS.join("|")})\\s*:`, "m").test(source)) return true;
  } catch {
    // No workspace manifest — fall through to package.json.
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf8")) as {
      packageManager?: unknown;
      pnpm?: Record<string, unknown>;
    };
    const pnpmMajor = pinnedPnpmMajor(pkg);
    if (pnpmMajor === null || pnpmMajor >= 11) return false;
    return CURATION_KEYS.some((key) => pkg.pnpm?.[key] !== undefined);
  } catch {
    return false;
  }
}
