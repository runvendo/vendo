import {
  useId,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";

type PrimitiveAction = () => unknown;
type PrimitiveValue = string | number | boolean | null | undefined;

const font: CSSProperties = {
  color: "var(--vendo-color-text, #1a1a1e)",
  fontFamily: "var(--vendo-font-family, system-ui, sans-serif)",
  fontSize: "var(--vendo-font-size, 15px)",
};

const field: CSSProperties = {
  ...font,
  width: "100%",
  minWidth: 0,
  minHeight: "var(--vendo-density-control-height, 38px)",
  border: "1px solid var(--vendo-color-border, #e3e3e8)",
  borderRadius: "var(--vendo-radius-small, 6px)",
  background: "var(--vendo-color-surface, #ffffff)",
  padding: "var(--vendo-density-control-padding, 9px 12px)",
  transition: `border-color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
    box-shadow var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease)`,
};

function content(value: PrimitiveValue, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function run(action: PrimitiveAction | undefined): void {
  void action?.();
}

export interface CardProps {
  title?: PrimitiveValue;
  description?: PrimitiveValue;
  tone?: "default" | "accent" | "danger";
}

/** Branded content container; remains in the host realm as a prewired primitive. */
export function Card({ title, description, tone = "default", children }: PropsWithChildren<CardProps>) {
  const toneColor = tone === "accent"
    ? "var(--vendo-color-accent, #2f5af5)"
    : tone === "danger"
      ? "var(--vendo-color-danger, #c62f2f)"
      : "var(--vendo-color-border, #e3e3e8)";
  return (
    <article
      data-primitive="Card"
      data-tone={tone}
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-content-gap, 10px)",
        border: `1px solid ${toneColor}`,
        borderRadius: "var(--vendo-radius-large, 16px)",
        background: "var(--vendo-color-surface, #ffffff)",
        boxShadow: "0 8px 24px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 7%, transparent)",
        padding: "var(--vendo-density-card-padding, 16px)",
        transition: `border-color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
          box-shadow var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease)`,
      }}
    >
      {title !== undefined && title !== null ? (
        <div
          data-card-title
          style={{
            color: "var(--vendo-color-text, #1a1a1e)",
            fontFamily: "var(--vendo-heading-family, var(--vendo-font-family, system-ui, sans-serif))",
            fontSize: "calc(var(--vendo-font-size, 15px) * 1.08)",
            fontWeight: 650,
            letterSpacing: "-0.015em",
            lineHeight: 1.3,
          }}
        >
          {content(title)}
        </div>
      ) : null}
      {description !== undefined && description !== null ? (
        <div style={{ color: "var(--vendo-color-muted, #6b6b76)", fontSize: "0.9em", lineHeight: 1.45 }}>
          {content(description)}
        </div>
      ) : null}
      {children}
    </article>
  );
}

export interface ButtonProps {
  label?: PrimitiveValue;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onClick?: PrimitiveAction;
}

/** Action props are callbacks already bound by the host tree renderer. */
export function Button({ label, variant = "primary", disabled = false, onClick, children }: PropsWithChildren<ButtonProps>) {
  const primary = variant === "primary";
  const danger = variant === "danger";
  const background = primary
    ? "var(--vendo-color-accent, #2f5af5)"
    : danger
      ? "var(--vendo-color-danger, #c62f2f)"
      : "var(--vendo-color-surface, #ffffff)";
  const color = primary || danger
    ? "var(--vendo-color-accent-text, #ffffff)"
    : "var(--vendo-color-text, #1a1a1e)";
  return (
    <button
      type="button"
      data-primitive="Button"
      data-variant={variant}
      disabled={disabled}
      onClick={() => run(onClick)}
      style={{
        ...font,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--vendo-density-inline-gap, 7px)",
        minHeight: "var(--vendo-density-control-height, 38px)",
        border: primary || danger ? "1px solid transparent" : "1px solid var(--vendo-color-border, #e3e3e8)",
        borderRadius: "var(--vendo-radius-small, 6px)",
        color,
        background,
        boxShadow: primary || danger
          ? "0 2px 8px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 14%, transparent)"
          : "0 1px 2px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 7%, transparent)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 650,
        lineHeight: 1.2,
        opacity: disabled ? 0.55 : 1,
        padding: "var(--vendo-density-control-padding, 9px 12px)",
        transition: `background-color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
          border-color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
          box-shadow var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
          opacity var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease)`,
      }}
    >
      {label === undefined ? children : content(label)}
    </button>
  );
}

export interface InputProps {
  label?: PrimitiveValue;
  value?: PrimitiveValue;
  placeholder?: string;
  type?: "text" | "email" | "number" | "password" | "search" | "tel" | "url";
  name?: string;
  hint?: PrimitiveValue;
  error?: PrimitiveValue;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: PrimitiveAction;
}

/** State bindings seed an uncontrolled value; change actions remain opaque bound callbacks. */
export function Input(props: InputProps) {
  const id = useId();
  const inputId = `vendo-input-${id.replace(/:/g, "")}`;
  const helpId = `${inputId}-help`;
  const initialValue = content(props.value);
  const hasHelp = props.error !== undefined && props.error !== null
    || props.hint !== undefined && props.hint !== null;
  return (
    <label
      data-primitive="Input"
      htmlFor={inputId}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-field-gap, 6px)" }}
    >
      {props.label !== undefined && props.label !== null ? (
        <span style={{ color: "var(--vendo-color-text, #1a1a1e)", fontSize: "0.88em", fontWeight: 600 }}>
          {content(props.label)}
        </span>
      ) : null}
      <input
        key={initialValue}
        id={inputId}
        name={props.name}
        type={props.type ?? "text"}
        defaultValue={initialValue}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        disabled={props.disabled}
        required={props.required}
        aria-invalid={props.error === undefined || props.error === null ? undefined : true}
        aria-describedby={hasHelp ? helpId : undefined}
        onChange={() => run(props.onChange)}
        style={{
          ...field,
          borderColor: props.error === undefined || props.error === null
            ? "var(--vendo-color-border, #e3e3e8)"
            : "var(--vendo-color-danger, #c62f2f)",
          opacity: props.disabled ? 0.55 : 1,
        }}
      />
      {hasHelp ? (
        <span
          id={helpId}
          style={{
            color: props.error === undefined || props.error === null
              ? "var(--vendo-color-muted, #6b6b76)"
              : "var(--vendo-color-danger, #c62f2f)",
            fontSize: "0.82em",
            lineHeight: 1.35,
          }}
        >
          {content(props.error ?? props.hint)}
        </span>
      ) : null}
    </label>
  );
}

export type SelectOption = PrimitiveValue | {
  value: PrimitiveValue;
  label?: PrimitiveValue;
  disabled?: boolean;
};

export interface SelectProps {
  label?: PrimitiveValue;
  value?: PrimitiveValue;
  options?: SelectOption[];
  placeholder?: string;
  name?: string;
  hint?: PrimitiveValue;
  disabled?: boolean;
  required?: boolean;
  onChange?: PrimitiveAction;
}

/** Native select semantics with JSON-serializable option descriptions. */
export function Select(props: SelectProps) {
  const id = useId();
  const selectId = `vendo-select-${id.replace(/:/g, "")}`;
  const hintId = `${selectId}-hint`;
  const initialValue = content(props.value);
  const options = (props.options ?? []).map((option) => (
    typeof option === "object" && option !== null
      ? { value: content(option.value), label: content(option.label ?? option.value), disabled: option.disabled }
      : { value: content(option), label: content(option), disabled: false }
  ));
  return (
    <label
      data-primitive="Select"
      htmlFor={selectId}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-field-gap, 6px)" }}
    >
      {props.label !== undefined && props.label !== null ? (
        <span style={{ color: "var(--vendo-color-text, #1a1a1e)", fontSize: "0.88em", fontWeight: 600 }}>
          {content(props.label)}
        </span>
      ) : null}
      <select
        key={initialValue}
        id={selectId}
        name={props.name}
        defaultValue={initialValue}
        disabled={props.disabled}
        required={props.required}
        aria-describedby={props.hint === undefined || props.hint === null ? undefined : hintId}
        onChange={() => run(props.onChange)}
        style={{ ...field, cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.55 : 1 }}
      >
        {props.placeholder !== undefined ? <option value="">{props.placeholder}</option> : null}
        {options.map((option, index) => (
          <option key={`${option.value}-${index}`} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint !== undefined && props.hint !== null ? (
        <span id={hintId} style={{ color: "var(--vendo-color-muted, #6b6b76)", fontSize: "0.82em", lineHeight: 1.35 }}>
          {content(props.hint)}
        </span>
      ) : null}
    </label>
  );
}

export interface TableColumn {
  key: string;
  label?: PrimitiveValue;
  align?: "start" | "center" | "end";
}

export interface TableProps {
  caption?: PrimitiveValue;
  columns?: Array<string | TableColumn>;
  rows?: Array<Record<string, unknown>>;
  emptyLabel?: PrimitiveValue;
  rowKey?: string;
}

function cell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

/** Compact data table accepting only JSON rows and column descriptions. */
export function Table({ caption, columns, rows = [], emptyLabel = "No data", rowKey = "id" }: TableProps) {
  const normalized = (columns ?? Object.keys(rows[0] ?? {})).map((column) => (
    typeof column === "string" ? { key: column, label: column, align: "start" as const } : {
      key: column.key,
      label: content(column.label, column.key),
      align: column.align ?? "start",
    }
  ));
  const align = (value: TableColumn["align"]): CSSProperties["textAlign"] => (
    value === "end" ? "right" : value === "center" ? "center" : "left"
  );
  return (
    <div
      data-primitive="Table"
      style={{
        ...font,
        width: "100%",
        overflowX: "auto",
        border: "1px solid var(--vendo-color-border, #e3e3e8)",
        borderRadius: "var(--vendo-radius-medium, 10px)",
        background: "var(--vendo-color-surface, #ffffff)",
      }}
    >
      <table aria-label={caption === undefined || caption === null ? undefined : content(caption)} style={{ width: "100%", borderCollapse: "collapse" }}>
        {caption !== undefined && caption !== null ? (
          <caption style={{ padding: "var(--vendo-density-table-padding, 10px 12px)", textAlign: "left", fontWeight: 650 }}>
            {content(caption)}
          </caption>
        ) : null}
        <thead>
          <tr style={{ background: "color-mix(in srgb, var(--vendo-color-background, #ffffff) 72%, var(--vendo-color-surface, #f7f7f8))" }}>
            {normalized.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  color: "var(--vendo-color-muted, #6b6b76)",
                  borderTop: caption === undefined || caption === null ? 0 : "1px solid var(--vendo-color-border, #e3e3e8)",
                  borderBottom: "1px solid var(--vendo-color-border, #e3e3e8)",
                  fontSize: "0.78em",
                  fontWeight: 700,
                  letterSpacing: "0.045em",
                  padding: "var(--vendo-density-table-padding, 10px 12px)",
                  textAlign: align(column.align),
                  textTransform: "uppercase",
                }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(1, normalized.length)} style={{ color: "var(--vendo-color-muted, #6b6b76)", padding: "var(--vendo-density-table-padding, 10px 12px)", textAlign: "center" }}>
                {content(emptyLabel)}
              </td>
            </tr>
          ) : rows.map((row, rowIndex) => (
            <tr key={content(row[rowKey] as PrimitiveValue, String(rowIndex))}>
              {normalized.map((column) => (
                <td
                  key={column.key}
                  style={{
                    borderBottom: rowIndex === rows.length - 1 ? 0 : "1px solid var(--vendo-color-border, #e3e3e8)",
                    padding: "var(--vendo-density-table-padding, 10px 12px)",
                    textAlign: align(column.align),
                  }}
                >
                  {cell(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface BadgeProps {
  label?: PrimitiveValue;
  tone?: "neutral" | "accent" | "danger";
}

/** Small status label using only neutral, accent, or danger theme colors. */
export function Badge({ label, tone = "neutral", children }: PropsWithChildren<BadgeProps>) {
  const color = tone === "accent"
    ? "var(--vendo-color-accent-text, #ffffff)"
    : tone === "danger"
      ? "var(--vendo-color-danger, #c62f2f)"
      : "var(--vendo-color-text, #1a1a1e)";
  const background = tone === "accent"
    ? "var(--vendo-color-accent, #2f5af5)"
    : tone === "danger"
      ? "color-mix(in srgb, var(--vendo-color-danger, #c62f2f) 11%, var(--vendo-color-surface, #ffffff))"
      : "color-mix(in srgb, var(--vendo-color-muted, #6b6b76) 10%, var(--vendo-color-surface, #ffffff))";
  const border = tone === "danger"
    ? "color-mix(in srgb, var(--vendo-color-danger, #c62f2f) 30%, var(--vendo-color-border, #e3e3e8))"
    : tone === "accent"
      ? "var(--vendo-color-accent, #2f5af5)"
      : "var(--vendo-color-border, #e3e3e8)";
  return (
    <span
      data-primitive="Badge"
      data-tone={tone}
      style={{
        ...font,
        display: "inline-flex",
        alignItems: "center",
        width: "fit-content",
        minHeight: "var(--vendo-density-badge-height, 24px)",
        border: `1px solid ${border}`,
        borderRadius: "999px",
        color,
        background,
        fontSize: "0.78em",
        fontWeight: 700,
        lineHeight: 1,
        padding: "var(--vendo-density-badge-padding, 5px 9px)",
      }}
    >
      {label === undefined ? children : content(label)}
    </span>
  );
}

export interface StatProps {
  label: PrimitiveValue;
  value?: PrimitiveValue;
  trend?: PrimitiveValue;
  prefix?: PrimitiveValue;
  suffix?: PrimitiveValue;
  tone?: "default" | "accent" | "danger";
}

/** Branded metric summary with optional accent or danger emphasis. */
export function Stat({ label, value, trend, prefix, suffix, tone = "default" }: StatProps) {
  const emphasis = tone === "accent"
    ? "var(--vendo-color-accent, #2f5af5)"
    : tone === "danger"
      ? "var(--vendo-color-danger, #c62f2f)"
      : "var(--vendo-color-text, #1a1a1e)";
  return (
    <article
      data-primitive="Stat"
      data-tone={tone}
      aria-label={content(label, "Statistic")}
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
        minWidth: 0,
        borderLeft: `3px solid ${emphasis}`,
        borderRadius: "var(--vendo-radius-small, 6px)",
        background: "color-mix(in srgb, var(--vendo-color-surface, #ffffff) 90%, var(--vendo-color-background, #f7f7f8))",
        padding: "var(--vendo-density-stat-padding, 12px 14px)",
      }}
    >
      <span style={{ color: "var(--vendo-color-muted, #6b6b76)", fontSize: "0.82em", fontWeight: 650 }}>
        {content(label)}
      </span>
      <strong
        style={{
          color: emphasis,
          fontFamily: "var(--vendo-heading-family, var(--vendo-font-family, system-ui, sans-serif))",
          fontSize: "calc(var(--vendo-font-size, 15px) * 1.65)",
          fontWeight: 700,
          letterSpacing: "-0.025em",
          lineHeight: 1.12,
        }}
      >
        {content(prefix)}{content(value, "—")}{content(suffix)}
      </strong>
      {trend !== undefined && trend !== null ? (
        <span style={{ color: "var(--vendo-color-muted, #6b6b76)", fontSize: "0.8em", lineHeight: 1.35 }}>
          {content(trend)}
        </span>
      ) : null}
    </article>
  );
}

export type TabItem = PrimitiveValue | {
  value?: PrimitiveValue;
  id?: PrimitiveValue;
  label: PrimitiveValue;
  disabled?: boolean;
  onSelect?: PrimitiveAction;
};

export interface TabsProps {
  label?: string;
  value?: PrimitiveValue;
  tabs?: TabItem[];
  items?: TabItem[];
  onChange?: PrimitiveAction;
}

/** Bound per-tab actions preserve selected-value payloads without event plumbing. */
export function Tabs({ label = "Tabs", value, tabs, items, onChange }: TabsProps) {
  const normalized = (tabs ?? items ?? []).map((item) => {
    if (typeof item !== "object" || item === null) {
      return { value: content(item), label: content(item), disabled: false, onSelect: undefined };
    }
    return {
      value: content(item.value ?? item.id ?? item.label),
      label: content(item.label),
      disabled: item.disabled ?? false,
      onSelect: item.onSelect,
    };
  });
  const selected = value === undefined || value === null
    ? normalized.find((item) => !item.disabled)?.value
    : content(value);
  const focusTab = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const offsets: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const offset = offsets[event.key];
    if (offset === undefined && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(event.currentTarget));
    const target = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (offset ?? 0) + buttons.length) % buttons.length;
    buttons[target]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      data-primitive="Tabs"
      style={{
        ...font,
        display: "flex",
        alignItems: "center",
        gap: "var(--vendo-density-inline-gap, 7px)",
        width: "fit-content",
        maxWidth: "100%",
        overflowX: "auto",
        border: "1px solid var(--vendo-color-border, #e3e3e8)",
        borderRadius: "var(--vendo-radius-medium, 10px)",
        background: "color-mix(in srgb, var(--vendo-color-background, #ffffff) 72%, var(--vendo-color-surface, #f7f7f8))",
        padding: "var(--vendo-density-tabs-padding, 4px)",
      }}
    >
      {normalized.map((item, index) => {
        const active = item.value === selected;
        return (
          <button
            key={`${item.value}-${index}`}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => run(item.onSelect ?? onChange)}
            onKeyDown={focusTab}
            style={{
              ...font,
              minHeight: "var(--vendo-density-tab-height, 30px)",
              border: active ? "1px solid var(--vendo-color-border, #e3e3e8)" : "1px solid transparent",
              borderRadius: "var(--vendo-radius-small, 6px)",
              color: active ? "var(--vendo-color-text, #1a1a1e)" : "var(--vendo-color-muted, #6b6b76)",
              background: active ? "var(--vendo-color-surface, #ffffff)" : "transparent",
              boxShadow: active ? "0 1px 3px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 10%, transparent)" : "none",
              cursor: item.disabled ? "not-allowed" : "pointer",
              fontSize: "0.88em",
              fontWeight: active ? 650 : 550,
              opacity: item.disabled ? 0.5 : 1,
              padding: "var(--vendo-density-tab-padding, 6px 10px)",
              whiteSpace: "nowrap",
              transition: `background-color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
                box-shadow var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease),
                color var(--vendo-motion-duration, 160ms) var(--vendo-motion-easing, ease)`,
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** The fixed branded primitive addition for ENG-242. */
export const BRANDED_COMPONENTS = {
  Card,
  Button,
  Input,
  Select,
  Table,
  Badge,
  Stat,
  Tabs,
} as const;
