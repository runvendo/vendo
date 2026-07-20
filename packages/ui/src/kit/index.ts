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
 * This is a NEW module. The existing prewired set (`../tree`) stays intact;
 * retirement is a later wave.
 */

// Semantics
export * from "./format.js";
export * from "./tokens.js";

// Schema + registry + generated prompt
export * from "./schema.js";
export {
  KIT_COMPONENTS,
  KIT_SPECS,
  kitComponentNames,
  kitSpec,
} from "./registry.js";
export { kitPrompt, type KitPromptOptions } from "./kit-prompt.js";

// Components
export * from "./layout.js";
export * from "./values.js";
export { DataTable, type DataTableColumn, type DataTableProps } from "./data/data-table.js";
export { CardList, type CardField, type CardListProps } from "./data/card-list.js";
export { Stat, type StatProps } from "./data/stat.js";
export { Badge, type BadgeProps } from "./data/badge.js";
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
export { Input, type InputProps } from "./forms/input.js";
export { Select, type SelectProps, type SelectOption } from "./forms/select.js";
export { DatePicker, type DatePickerProps } from "./forms/date-picker.js";
export { Textarea, type TextareaProps } from "./forms/textarea.js";
export { Checkbox, type CheckboxProps } from "./forms/checkbox.js";
export { Form, type FormProps } from "./forms/form.js";
export { Disclaimer, type DisclaimerProps } from "./forms/disclaimer.js";
export { Tabs, type TabsProps, type TabItem } from "./feedback/tabs.js";
export { Callout, type CalloutProps, type CalloutTone } from "./feedback/callout.js";
export { Accordion, type AccordionProps, type AccordionItem } from "./feedback/accordion.js";
