/**
 * The sealed screen engine — a model-written React component, run for real,
 * emitting data.
 *
 * ```ts
 * await warmScreenEngine();                       // once, per process
 * const screen = bootScreen({ compiledSource, queries, catalog });
 * const { intents } = screen.fire("h4");          // a click; state has landed
 * screen.settle(intents[0].id, await runTool());  // the tool's answer
 * screen.dispose();
 * ```
 *
 * `compiledSource` is the component compiled to CommonJS — esbuild with
 * `format: "cjs"`, `jsx: "automatic"`, and `process.env.NODE_ENV` defined. The
 * three modules it may import are `react` (mapped onto Preact and its hooks),
 * `react/jsx-runtime`, and `@vendo/screen`, which carries `useQuery`, `tools`,
 * and every catalog name.
 *
 * The pieces: ./boot.ts runs the VM, ./vm-program.ts is what the VM runs,
 * ./preact-source.ts is the pinned Preact it runs it with, ./budget.ts is what
 * stops a screen that will not stop, ./flatten.ts turns a paint into addressable
 * nodes, ./press.ts activates what the paint drew to find the controls that do
 * nothing, ./types.ts is the vocabulary.
 */
export { bootScreen, warmScreenEngine, type ScreenEngineVariant } from "./boot.js";
export {
  BOOT_INTERRUPT_BUDGET,
  OP_INTERRUPT_BUDGET,
  opsBudget,
  wallClockBudget,
  type ScreenBudget,
  type ScreenTurn,
  type TurnLimit,
} from "./budget.js";
export { flattenTree } from "./flatten.js";
export { pressControls } from "./press.js";
export {
  isHandlerRef,
  queryKey,
  SCREEN_FILE,
  SCREEN_TEXT_NODE,
  ScreenError,
  type BootScreenOptions,
  type FireResult,
  type FlatNode,
  type FlatTree,
  type HandlerRef,
  type InertControl,
  type Intent,
  type NestedNode,
  type ScreenErrorKind,
  type ScreenInstance,
  type ScreenQuery,
} from "./types.js";
export { PREACT_VERSION } from "./preact-source.js";
