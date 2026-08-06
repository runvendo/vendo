export { createAgent } from "./agent.js";
// Re-exported from its new home so a caller that reached `createAgent`'s
// `stopWhen` ceiling through this package keeps compiling while the door lives.
export { tokenBudgetStop } from "@vendoai/harnesses";
export type { ScriptedTurn, VendoAgent } from "./agent.js";
export type { Thread, ThreadSummary } from "./threads.js";
