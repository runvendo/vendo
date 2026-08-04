/**
 * Compatibility barrel — the engine lives in ./generation/ (prompts and
 * validation around the conductor, with the shared model plumbing in
 * generation/engine.ts). This path is kept so runtime.ts, pins consumers,
 * tests, and bench keep importing "./engine.js" unchanged.
 */
export * from "./generation/engine.js";
export { APP_NAME_MAX_CHARS } from "./generation/contracts/sections.js";
