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

// Chart data type shared across bar/line/area charts
type ChartRecord = Record<string, string | number>;

export const BarChart = ui<BarChartProps<ChartRecord[]>>(_BarChart);
export const LineChart = ui<LineChartProps<ChartRecord[]>>(_LineChart);
export const AreaChart = ui<AreaChartProps<ChartRecord[]>>(_AreaChart);
export const PieChart = ui<PieChartProps<ChartRecord[]>>(_PieChart);
