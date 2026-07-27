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
    // ENOENT ("file absent") degrades as before. A CODE-LESS failure degrades
    // too: on a build whose "workerd" custom condition didn't resolve to
    // host-files-edge.ts, node:fs/promises falls through to unenv's shim,
    // which throws a "not implemented" Error with NO .code at all — a real
    // filesystem never produces that shape, so it's an unambiguous signal
    // this is workerd, not a present-but-broken file.
    //
    // Every OTHER real fs error code still THROWS — this file (overrides.json
    // in particular) is the one place "absent" is MORE permissive than
    // "present": a disabled tool or an audience exclusion vanishes with it,
    // going LIVE. A present-but-unreadable file on a real filesystem (EACCES
    // from a volume-mount permission mismatch, EISDIR, EMFILE under fd
    // pressure, ...) must fail CLOSED and surface loudly, exactly like
    // before this seam existed — silently dropping it would fail OPEN.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === undefined) return undefined;
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

  try {
    return parse(value);
  } catch (cause) {
    throw new VendoError("validation", `Invalid Vendo actions file ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
