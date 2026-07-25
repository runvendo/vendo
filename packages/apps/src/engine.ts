/**
 * Compatibility barrel — the engine lives in ./generation/ (contracts /
 * validation / stages, orchestrated by generation/engine.ts). This path is
 * kept so runtime.ts, pins consumers, tests, and bench keep importing
 * "./engine.js" unchanged.
 */
export * from "./generation/engine.js";
export { APP_NAME_MAX_CHARS } from "./generation/contracts/sections.js";
export { CONTRACT_EXEMPLARS, EXEMPLAR_HOST_TOOLS, exemplarContract } from "./generation/contracts/exemplar.js";
