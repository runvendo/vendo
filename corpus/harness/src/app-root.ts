import path from "node:path";
import type { ManifestEntry } from "./manifest.js";

export type AppRootRepo = Pick<ManifestEntry, "appDir">;

export function resolveAppRoot(repo: AppRootRepo, repoDir: string): string {
  return repo.appDir ? path.join(repoDir, repo.appDir) : repoDir;
}
