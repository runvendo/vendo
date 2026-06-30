import {
  Card as _Card,
  CardHeader as _CardHeader,
  Tag as _Tag,
  TagBlock as _TagBlock,
  Table as _Table,
  TableHeader as _TableHeader,
  TableBody as _TableBody,
  TableRow as _TableRow,
  TableHead as _TableHead,
  TableCell as _TableCell,
  BarChart as _BarChart,
  LineChart as _LineChart,
  AreaChart as _AreaChart,
  PieChart as _PieChart,
  FormControl as _FormControl,
  Label as _Label,
  Input as _Input,
  TextArea as _TextArea,
  Accordion as _Accordion,
  AccordionItem as _AccordionItem,
  AccordionTrigger as _AccordionTrigger,
  AccordionContent as _AccordionContent,
  Carousel as _Carousel,
  CarouselContent as _CarouselContent,
  CarouselItem as _CarouselItem,
  Callout as _Callout,
  Steps as _Steps,
  StepsItem as _StepsItem,
} from "@openuidev/react-ui";
import type {
  CardProps,
  CardHeaderProps,
  TagProps,
  TagBlockProps,
  TableHeadProps,
  TableCellProps,
  BarChartProps,
  LineChartProps,
  AreaChartProps,
  PieChartProps,
  FormControlProps,
  LabelProps,
  InputProps,
  TextAreaProps,
} from "@openuidev/react-ui";
import type { ComponentType, HTMLAttributes, ReactNode } from "react";

/**
 * OpenUI ships @types/react@19 types (ReactNode includes bigint); this monorepo
 * pins @types/react@18, so every OpenUI component trips TS2786 at JSX call sites.
 * Cast them ONCE here to React-18 ComponentTypes with prop types preserved.
 * All wrappers import OpenUI components from this module, never from the package directly.
 */
const ui = <P,>(component: unknown): ComponentType<P> =>
  component as unknown as ComponentType<P>;

export const Card = ui<CardProps & { children?: ReactNode }>(_Card);
export const CardHeader = ui<CardHeaderProps>(_CardHeader);
export const Tag = ui<TagProps>(_Tag);
export const TagBlock = ui<TagBlockProps & { children?: ReactNode }>(_TagBlock);

export const Table = ui<HTMLAttributes<HTMLTableElement> & { children?: ReactNode }>(_Table);
export const TableHeader = ui<HTMLAttributes<HTMLTableSectionElement> & { children?: ReactNode }>(_TableHeader);
export const TableBody = ui<HTMLAttributes<HTMLTableSectionElement> & { children?: ReactNode }>(_TableBody);
export const TableRow = ui<HTMLAttributes<HTMLTableRowElement> & { children?: ReactNode }>(_TableRow);
export const TableHead = ui<TableHeadProps & { children?: ReactNode }>(_TableHead);
export const TableCell = ui<TableCellProps & { children?: ReactNode }>(_TableCell);

export const FormControl = ui<FormControlProps>(_FormControl);
export const Label = ui<LabelProps>(_Label);
export const Input = ui<InputProps>(_Input);
export const TextArea = ui<TextAreaProps>(_TextArea);

// Chart data type shared across bar/line/area charts
type ChartRecord = Record<string, string | number>;

export const BarChart = ui<BarChartProps<ChartRecord[]>>(_BarChart);
export const LineChart = ui<LineChartProps<ChartRecord[]>>(_LineChart);
export const AreaChart = ui<AreaChartProps<ChartRecord[]>>(_AreaChart);
export const PieChart = ui<PieChartProps<ChartRecord[]>>(_PieChart);

// Accordion
export const Accordion = ui<{
  type: "single" | "multiple";
  variant?: "clear" | "card" | "sunk";
  collapsible?: boolean;
  defaultValue?: string | string[];
  children?: ReactNode;
}>(_Accordion);
export const AccordionItem = ui<{ value: string; className?: string; children?: ReactNode }>(_AccordionItem);
export const AccordionTrigger = ui<{ text: ReactNode; icon?: ReactNode; className?: string }>(_AccordionTrigger);
export const AccordionContent = ui<{ className?: string; children?: ReactNode }>(_AccordionContent);

// Carousel
export const Carousel = ui<{ children?: ReactNode; variant?: "card" | "sunk"; showButtons?: boolean }>(_Carousel);
export const CarouselContent = ui<{ children?: ReactNode; className?: string }>(_CarouselContent);
export const CarouselItem = ui<{ children?: ReactNode; className?: string }>(_CarouselItem);

// Callout
export const Callout = ui<{
  variant?: "info" | "danger" | "warning" | "success" | "neutral";
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
}>(_Callout);

// Steps
export const Steps = ui<{ children: ReactNode }>(_Steps);
export const StepsItem = ui<{ title: ReactNode; details: ReactNode; number?: number }>(_StepsItem);
