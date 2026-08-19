/** The engine's WebAssembly, read off disk — the `node` arm of `#engine/wasm`
 *  (../../../package.json). See ./variant.ts for why the bytes travel as a file
 *  and not inside the JavaScript. */
import { readFile } from "node:fs/promises";

export default async function loadWasm(): Promise<ArrayBuffer> {
  const bytes = await readFile(new URL("../../../quickjs.wasm", import.meta.url));
  // A Node read lands in a POOLED buffer, so the ArrayBuffer behind it holds
  // other reads too — the slice is what makes these bytes the whole module.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
