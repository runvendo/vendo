export * from "./protocol.js";
export * from "./bridge.js";
export { STAGE_RUNTIME_SRC } from "./runtime.js";
export * from "./stage-host.js";
export * from "./genui-host.js";

/** CSS-variable brand tokens, e.g. { "--vendo-accent": "#0a7c..." }. */
export type ThemeTokens = Record<string, string>;

/** Scoped, structured-clone-safe state slice projected into the stage. */
export type StateProjection = Record<string, unknown>;

/** A resolved host/prewired component implementation (framework type kept opaque here). */
export type ComponentImpl = unknown;
