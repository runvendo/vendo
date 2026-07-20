import { readFile } from "node:fs/promises";
import path from "node:path";

const CURATION_KEYS = ["onlyBuiltDependencies", "neverBuiltDependencies", "allowBuilds"] as const;

/** pnpm ≥10 errors (ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES) on
 * dangerouslyAllowAllBuilds when the workspace already declares a curated
 * build allowlist — detect that curation, whether it lives in
 * pnpm-workspace.yaml (onlyBuiltDependencies/neverBuiltDependencies, or the
 * newer allowBuilds map umami uses) or in the package.json `pnpm` field
 * (ENG-334). Shared by the bootstrap and post-injection install-command
 * paths so both respect a repo's own build policy instead of forcing
 * dangerouslyAllowAllBuilds on top of it. */
export async function pnpmDeclaresBuiltDependencies(installDir: string): Promise<boolean> {
  try {
    const source = await readFile(path.join(installDir, "pnpm-workspace.yaml"), "utf8");
    if (new RegExp(`^\\s*(${CURATION_KEYS.join("|")})\\s*:`, "m").test(source)) return true;
  } catch {
    // No workspace manifest — fall through to package.json.
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf8")) as {
      pnpm?: Record<string, unknown>;
    };
    return CURATION_KEYS.some((key) => pkg.pnpm?.[key] !== undefined);
  } catch {
    return false;
  }
}
