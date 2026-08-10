/**
 * The Kit's model-facing surface (W2 §The Kit, hoisted to core in W3): prop
 * schemas + classes, the component specs, and the generated prompt. The React
 * implementations stay in `@vendoai/ui` (`KIT_COMPONENTS`), keyed by these
 * names — a ui drift test pins the two in step.
 */
export * from "./schema.js";
export * from "./specs.js";
export { kitPrompt, type KitPromptOptions } from "./kit-prompt.js";
