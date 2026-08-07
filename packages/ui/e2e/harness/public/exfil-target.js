// An off-allowlist module the jail must never be able to load. Served by the
// harness itself so the proof needs no third-party network: a real origin, real
// JS MIME type, so "LOADED" means the jail truly reached a module loader and
// executed foreign code — not that a request 404'd. The secret rides in the
// query string, which is what a real exfiltration would do.
globalThis.__vendoExfilLoaded = true;
export default "exfiltrated";
