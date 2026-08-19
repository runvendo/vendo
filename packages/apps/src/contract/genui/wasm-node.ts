/** The engine's WebAssembly, read off disk — the `node` arm of `#engine/wasm`
 *  (../../../package.json). See ./variant.ts for why the bytes travel as a file
 *  and not inside the JavaScript. */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default async function loadWasm(): Promise<ArrayBuffer> {
  // NOT `new URL("…", import.meta.url)`: Vite REWRITES that exact expression
  // into an emitted-asset URL, so under vitest (and any Vite host) this arm
  // would be handed an `http:` URL that `readFile` refuses. Resolving from the
  // module's own directory is the same path — `../../../` lands on the package
  // root from `src/` and from `dist/` alike — and nothing rewrites it.
  const bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../quickjs.wasm"));
  // A Node read lands in a POOLED buffer, so the ArrayBuffer behind it holds
  // other reads too — the slice is what makes these bytes the whole module.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
