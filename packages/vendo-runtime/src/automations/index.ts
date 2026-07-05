/**
 * The automations engine (ENG-188): DSL schema + expressions, interpreter,
 * Principal-scoped engine store, runner, embedded scheduler, ingest helpers,
 * and chat authoring tools. Built against the frozen core seams
 * (@vendoai/core/seams); engine types extend them additively.
 */
export * from "./schema.js";
export * from "./expressions.js";
export * from "./grants.js";
export * from "./interpreter.js";
export * from "./store.js";
export * from "./runner.js";
export * from "./in-process-scheduler.js";
export * from "./host-events.js";
export * from "./tools.js";

export * from "./agent-step.js";
export * from "./instructions.js";
