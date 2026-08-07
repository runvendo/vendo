/**
 * Kit prop schemas + classing (W2 §The Kit).
 *
 * W3 hoisted the definitions to `@vendoai/core` so the generation engine can
 * consume the prop classes (law-1 enforcement) and the generated prompt;
 * this module re-exports them so the `@vendoai/ui/kit` surface is unchanged.
 */
export {
  config,
  copy,
  data,
  propsSchema,
  validateProps,
  type KitComponentSpec,
  type PropClass,
  type PropSpec,
} from "@vendoai/core";
