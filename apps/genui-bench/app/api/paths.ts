import { join } from "node:path";

/** `next dev`/`next build` run with cwd = apps/genui-bench (pnpm --filter /
 *  turbo), so the app dir is the process cwd for every route handler. */
export const appDir = process.cwd();
export const runsDir = join(appDir, "runs");
export const packsDir = join(appDir, "packs");

/** Run ids / pack names are used as path segments — never let a request
 *  escape the directory. */
export function isSafeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}
