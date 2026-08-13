/**
 * One screen, compiled and booted the way the engine is fed in production.
 *
 * The compile flags are the gauntlet's own `engine` form
 * (server/checking/toolchain.ts): CommonJS, because the VM hosts a `require` and
 * no module loader, the AUTOMATIC jsx transform, because the VM publishes
 * `react/jsx-runtime` and has no bare `React` global, and the `"use strict";`
 * banner, because CommonJS output is otherwise sloppy. A test that hand-wrote the
 * CJS would be asserting against a source shape nothing produces.
 */
import { transformSync } from "esbuild";
import {
  bootScreen,
  type NestedNode,
  type ScreenInstance,
} from "../../../../src/contract/genui/component/index.js";

export const compileScreen = (tsx: string): string =>
  transformSync(tsx, { loader: "tsx", format: "cjs", target: "es2020", jsx: "automatic", banner: '"use strict";' }).code;

/** The Kit names a host surface holds, as the engine receives them. */
export const CATALOG: readonly string[] = [
  "Stack", "Row", "Card", "Text", "Money", "DateTime", "Button", "Input", "Checkbox", "Callout", "Accordion", "DataTable",
];

export const bootTsx = (
  tsx: string,
  queries: Record<string, unknown> = {},
  now?: number,
): ScreenInstance => bootScreen({
  compiledSource: compileScreen(tsx),
  queries,
  catalog: CATALOG,
  ...(now === undefined ? {} : { now }),
});

/** Every `text` prop and text run in a paint, in paint order — the cheapest
 *  honest read of "what does this screen say now". */
export const textsOf = (tree: NestedNode): string[] => {
  const found: string[] = [];
  const walk = (node: NestedNode): void => {
    if (typeof node.props.text === "string" || typeof node.props.text === "number") found.push(String(node.props.text));
    for (const child of node.children) {
      if (typeof child === "string") found.push(child);
      else walk(child);
    }
  };
  walk(tree);
  return found;
};

/** Every handler the paint named, as `label=id` — a label is what a person would
 *  click, so this reads as the screen's own buttons. */
export const handlersOf = (tree: NestedNode): string[] => {
  const found: string[] = [];
  const walk = (node: NestedNode): void => {
    for (const [prop, value] of Object.entries(node.props)) {
      if (typeof value === "object" && value !== null && typeof (value as { $handler?: unknown }).$handler === "string") {
        found.push(`${node.props.label ?? node.component}.${prop}=${(value as { $handler: string }).$handler}`);
      }
    }
    for (const child of node.children) if (typeof child !== "string") walk(child);
  };
  walk(tree);
  return found;
};

/** The first node in the paint whose component matches — for reading one prop. */
export const nodeOf = (tree: NestedNode, component: string): NestedNode | undefined => {
  if (tree.component === component) return tree;
  for (const child of tree.children) {
    if (typeof child === "string") continue;
    const found = nodeOf(child, component);
    if (found !== undefined) return found;
  }
  return undefined;
};
