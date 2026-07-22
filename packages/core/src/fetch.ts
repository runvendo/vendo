/** The safe default for every `options.fetch ?? …` seam. A bare
 *  `globalThis.fetch` stored in a variable and invoked later arrives with the
 *  wrong receiver, which strict Web runtimes (Cloudflare Workers, browsers)
 *  reject as "Illegal invocation"; the wrapper late-binds through globalThis
 *  on every call, so it also tracks fetch replacements (polyfills, test
 *  mocks) installed after capture. */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
