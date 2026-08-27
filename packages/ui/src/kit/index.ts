"use client";

/**
 * @vendoai/ui/kit — the Kit (W2 §The Kit).
 *
 * The best component stack in generative UI: a strict superset of Crayon /
 * Tambo / json-render surfaces, then better on our axes — host-brand-native via
 * theme tokens, action-gated interactivity, semantics-driven formatting,
 * named-query empty states, composable inside islands. Every prop is
 * zod-schema'd and classed `config | copy | data`; the model-facing prompt is
 * GENERATED from those schemas by `kitPrompt()`.
 *
 * V4: the Kit is the ONLY component family — the legacy prewired/branded set
 * under `../tree` is retired.
 */

// Semantics
export {
  applyFormat,
  currencyMinorUnits,
  formatDateTime,
  formatMoney,
  formatNum,
  getKitIntl,
  isRenderableNumber,
  setKitIntl,
  type DateInput,
  type DateTimeOptions,
  type KitIntl,
  type MoneyOptions,
  type NumOptions,
  type ValueFormat,
} from "./format.js";
export { readField, type KitRow } from "./row.js";
export { useKeyedState, type KeyedState } from "./state.js";
export {
  chartSeries,
  control,
  densityVars,
  font,
  given,
  hairline,
  microLabel,
  numeric,
  popup,
  popupMotion,
  resolveTone,
  seriesColor,
  t,
  toneColor,
  toneStyle,
  transitionFor,
  type KitDensity,
  type KitEngine,
  type KitRendered,
  type KitStyled,
  type KitTone,
} from "./tokens.js";

// Schema + registry + generated prompt
export {
  config,
  copy,
  data,
  propsSchema,
  validateProps,
  type KitComponentSpec,
  type KitSlotSpec,
  type PropClass,
  type PropSpec,
} from "./schema.js";
export {
  KIT_COMPONENTS,
  KIT_SPECS,
  kitComponentNames,
  kitSpec,
} from "./registry.js";
export { kitPrompt, type KitPromptOptions } from "./kit-prompt.js";

// Components
export {
  Card,
  Divider,
  Grid,
  Row,
  Stack,
  Surface,
  type CardProps,
  type DividerProps,
  type GridProps,
  type RowProps,
  type StackProps,
  type SurfaceProps,
} from "./layout.js";
export {
  EnumBadge,
  Text,
  humanizeEnum,
  type EnumBadgeProps,
  type EnumTone,
  type TextProps,
} from "./values.js";
export { Icon, type IconProps } from "./icon.js";
export { DataTable, type DataTableColumn, type DataTableProps } from "./data/data-table.js";
export { TableRow, type TableRowProps } from "./data/table-row.js";
export { CardList, type CardField, type CardListProps } from "./data/card-list.js";
export { Calendar, type CalendarProps } from "./data/calendar.js";
export { Stat, type StatProps } from "./data/stat.js";
export { Badge, type BadgeProps } from "./data/badge.js";
export { KeyValue, type KeyValueItem, type KeyValueProps } from "./data/key-value.js";
export { Timeline, type TimelineProps } from "./data/timeline.js";
export { Avatar, type AvatarProps } from "./data/avatar.js";
export { CodeBlock, type CodeBlockProps } from "./data/code-block.js";
export { LineChart, type LineChartProps, type SeriesInput } from "./charts/line.js";
export { BarChart, type BarChartProps } from "./charts/bar.js";
export { DonutChart, type DonutChartProps } from "./charts/donut.js";
export { Sparkline, type SparklineProps } from "./charts/sparkline.js";
export { Progress, type ProgressProps } from "./charts/progress.js";
export {
  ChartFrame,
  ChartEmpty,
  sanitizeSeries,
  sanitizeNumbers,
  seriesIsEmpty,
} from "./charts/sanitize.js";
export { Button, type ButtonProps } from "./forms/button.js";
export { Link, type LinkProps } from "./link.js";
export { Input, type InputProps } from "./forms/input.js";
export { Select, type SelectProps, type SelectOption } from "./forms/select.js";
export { DatePicker, type DatePickerProps } from "./forms/date-picker.js";
export { Textarea, type TextareaProps } from "./forms/textarea.js";
export { Checkbox, type CheckboxProps } from "./forms/checkbox.js";
export { Switch, type SwitchProps } from "./forms/switch.js";
export { Radio, type RadioProps } from "./forms/radio.js";
export { Slider, type SliderProps } from "./forms/slider.js";
export { SegmentedControl, type SegmentedControlProps, type SegmentItem } from "./forms/segmented-control.js";
export { Combobox, type ComboboxProps } from "./forms/combobox.js";
export { DateRange, type DateRangeProps } from "./forms/date-range.js";
export { choices, type KitChoice, type KitOption } from "./forms/options.js";
export { Form, type FormProps } from "./forms/form.js";
export { Disclaimer, type DisclaimerProps } from "./forms/disclaimer.js";
export { Tabs, type TabsProps, type TabItem } from "./feedback/tabs.js";
export { Callout, type CalloutProps, type CalloutTone } from "./feedback/callout.js";
export { Accordion, type AccordionProps, type AccordionItem } from "./feedback/accordion.js";
export { EmptyState, type EmptyStateProps } from "./feedback/empty-state.js";
export { Steps, type StepsProps, type StepItem } from "./feedback/steps.js";
export { Menu, type MenuProps, type MenuItem } from "./feedback/menu.js";
export { Tooltip, type TooltipProps } from "./feedback/tooltip.js";
export { Modal, type ModalProps } from "./overlay/modal.js";
export { Sheet, type SheetProps, type SheetSide } from "./overlay/sheet.js";
export { Toast, type ToastProps } from "./overlay/toast.js";
export { KIT_CSS, ensureKitStyles } from "./kit-css.js";

// The theme the Kit's tokens read, and the embedded-surface runtime that applies
// it — reachable from a generated app's box, where `@vendoai/ui`'s root barrel
// (the client, the surfaces, the voice stage) is not what an app should import.
export { defaultVendoTheme, resolveTheme, themeCssVariables } from "../theme.js";
export { applyThemeVars, callHost, postToHost, startFrameProtocol } from "../embedded-runtime.js";

// ---------------------------------------------------------------------------
// The code-land runtime (blueprint §5.4) — what a generated app imports inside
// its own box. It ships HERE, in the bundle the box already loads, so a
// generated app and a `.vendo` screen render the same components with the same
// formatters and share one `$state` store. There is no second Kit, no second
// `sum`, no second query path, no second action door.
// ---------------------------------------------------------------------------

/**
 * The TOTAL forms, re-exported from core so an app that wants the REASON a
 * value did not fit can read it. Every wrapper below answers with the value or
 * `undefined`; these two answer with `{ ok, reason }` / `{ ok, issue }`. Same
 * functions, one implementation — this is the second shape, and the only one.
 */
export {
  applyReshape,
} from "@vendoai/core";
export {
  evaluateExpr,
} from "@vendoai/apps/contract";
export type { Json, ReshapeOp, ReshapeResult, ReshapeStep, ToolOutcome } from "@vendoai/core";

// The projection vocabulary: nine live reshape ops.
export { reshape } from "./reshape.js";

// The aggregates — the reductions an island reaches for by name, over core's
// one numeric reduce. A `{...}` gap is JavaScript, so these are a convenience,
// not a dialect.
export {
  average,
  count,
  daysUntil,
  difference,
  groupBy,
  max,
  min,
  sum,
  type GroupByAggregate,
  type GroupByBucket,
  type GroupedPoint,
} from "./aggregates.js";

// The one provider, and the app address it derives from the served URL.
export {
  appAddressFromPath,
  useVendoApp,
  VendoAppProvider,
  type QueryRefetch,
  type VendoAppContextValue,
  type VendoAppProviderProps,
} from "./app-context.js";

// The guarded read, the write, and the `$state` binding.
export { useToolQuery, type ToolQuery } from "./query.js";
export { useToolAction, type ToolAction } from "./action.js";
export { useVendoState } from "./vendo-state.js";
