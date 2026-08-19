/** The engine's WebAssembly, fetched as an asset — the default arm of
 *  `#engine/wasm` (../../../package.json). `new URL(…, import.meta.url)` is the
 *  ONE asset form Turbopack, webpack, Vite and esbuild all emit and rewrite, so
 *  the bundler that builds the host's page also ships the `.wasm` beside it.
 *  See ./variant.ts for why the bytes travel as a file at all. */
export default async function loadWasm(): Promise<ArrayBuffer> {
  const response = await fetch(new URL("../../../quickjs.wasm", import.meta.url));
  if (!response.ok) throw new Error(`the screen engine's WebAssembly answered ${response.status} — @vendoai/apps ships quickjs.wasm beside its dist, and this host's bundler did not emit it`);
  return response.arrayBuffer();
}
