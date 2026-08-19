/**
 * Raw tool output as choices — the one shape Select, Radio and Combobox share.
 * The model passes a tool's array straight in and names the two fields; nothing
 * reshapes on the way.
 */
export type KitOption = string | number | Record<string, unknown>;

export interface KitChoice {
  value: string;
  label: string;
  /** Shown but not selectable. */
  disabled?: boolean;
  /** The heading this choice sits under. */
  group?: string;
}

/** A run of choices under one heading — the unnamed run is the ungrouped ones. */
export interface KitRun<T> {
  group?: string;
  items: T[];
}

/** W3 — fail SOFT on missing data: a failed query resolves to undefined. */
export function choices(options: KitOption[] | undefined, labelField?: string, valueField?: string): KitChoice[] {
  return (Array.isArray(options) ? options : []).map((option) => {
    // A primitive choice is its own label and value, and can carry neither a
    // `disabled` nor a `group`: there is nowhere on a bare string to put one.
    if (option === null || typeof option !== "object") return { value: String(option), label: String(option) };
    const value = String(valueField ? option[valueField] : JSON.stringify(option));
    // Off the item's OWN two keys — no prop names them, because the item that
    // is unselectable is the one the tool said so about. `Object.hasOwn` and a
    // type check because these keys are model-written: "constructor" is a
    // string too, and a `disabled: "no"` means nothing.
    const disabled = Object.hasOwn(option, "disabled") ? option.disabled : undefined;
    const group = Object.hasOwn(option, "group") ? option.group : undefined;
    return {
      value,
      label: labelField ? String(option[labelField]) : value,
      disabled: typeof disabled === "boolean" ? disabled : undefined,
      group: typeof group === "string" ? group : undefined,
    };
  });
}

/** Choices bucketed by their own `group`, each run where its first member stood.
 *  An ungrouped list comes back as ONE unnamed run, so every component renders
 *  it exactly as it did before groups existed. */
export function grouped<T extends { group?: string }>(items: T[]): KitRun<T>[] {
  const runs: KitRun<T>[] = [];
  for (const item of items) {
    const run = runs.find((candidate) => candidate.group === item.group);
    if (run === undefined) runs.push({ group: item.group, items: [item] });
    else run.items.push(item);
  }
  return runs;
}
