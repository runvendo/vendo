/**
 * Raw tool output as choices — the one shape Select, Radio and Combobox share.
 * The model passes a tool's array straight in and names the two fields; nothing
 * reshapes on the way.
 */
export type KitOption = string | number | Record<string, unknown>;

export interface KitChoice {
  value: string;
  label: string;
}

/** W3 — fail SOFT on missing data: a failed query resolves to undefined. */
export function choices(options: KitOption[] | undefined, labelField?: string, valueField?: string): KitChoice[] {
  return (Array.isArray(options) ? options : []).map((option) => {
    if (option === null || typeof option !== "object") return { value: String(option), label: String(option) };
    const value = String(valueField ? option[valueField] : JSON.stringify(option));
    return { value, label: labelField ? String(option[labelField]) : value };
  });
}
