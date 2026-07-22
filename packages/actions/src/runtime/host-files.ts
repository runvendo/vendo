/** The registry's one filesystem leg: optional `.vendo/*.json` host config.
 *  Split behind `#actions/host-files` conditions so Worker/edge bundles never
 *  carry node:fs — there, hosts pass catalog config inline and every file
 *  simply reads as absent (see host-files-edge.ts). */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { VendoError } from "@vendoai/core";

/** `dir` may be the host root (we look inside its .vendo/) or the .vendo
 *  directory itself; reads `file` from it, undefined when absent. */
export async function readOptionalVendoJson<T>(
  dir: string,
  file: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  const vendoDir = basename(resolve(dir)) === ".vendo" ? dir : join(dir, ".vendo");
  const path = join(vendoDir, file);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VendoError("validation", `Could not read ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new VendoError("validation", `Malformed JSON in ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return parse(value);
}
