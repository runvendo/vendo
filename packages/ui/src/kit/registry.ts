/**
 * The Kit registry (W2 §The Kit). The SPECS (zod schemas, prop classes,
 * docs, examples) live in `@vendoai/core` since W3 (the engine consumes them
 * there); this module owns the React implementations. The registry drift
 * test asserts `KIT_COMPONENTS` covers exactly `KIT_SPECS`.
 */
import type { ComponentType } from "react";

// Components
import { Divider, Grid, Row, Stack, Surface } from "./layout.js";
import { DateTime, EnumBadge, Money, Num, Percent, Text } from "./values.js";
import { DataTable } from "./data/data-table.js";
import { CardList } from "./data/card-list.js";
import { Stat } from "./data/stat.js";
import { Badge } from "./data/badge.js";
import { LineChart } from "./charts/line.js";
import { BarChart } from "./charts/bar.js";
import { DonutChart } from "./charts/donut.js";
import { Sparkline } from "./charts/sparkline.js";
import { Progress } from "./charts/progress.js";
import { Button } from "./forms/button.js";
import { Input } from "./forms/input.js";
import { Select } from "./forms/select.js";
import { DatePicker } from "./forms/date-picker.js";
import { Textarea } from "./forms/textarea.js";
import { Checkbox } from "./forms/checkbox.js";
import { Form } from "./forms/form.js";
import { Disclaimer } from "./forms/disclaimer.js";
import { Tabs } from "./feedback/tabs.js";
import { Callout } from "./feedback/callout.js";
import { Accordion } from "./feedback/accordion.js";

export { KIT_SPECS, kitComponentNames, kitSpec } from "@vendoai/core";

/** Name → React component, for the tree renderer. */
export const KIT_COMPONENTS: Readonly<Record<string, ComponentType<Record<string, never>>>> = {
  Stack, Row, Grid, Surface, Divider,
  Text, Money, DateTime, Percent, Num, EnumBadge,
  DataTable, CardList, Stat, Badge,
  LineChart, BarChart, DonutChart, Sparkline, Progress,
  Input, Select, DatePicker, Textarea, Checkbox, Button, Form, Disclaimer,
  Tabs, Callout, Accordion,
} as unknown as Record<string, ComponentType<Record<string, never>>>;
