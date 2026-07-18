import type { Output } from "../shared.js";

export const cloudConsoleOutput: Output = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export function printJson(output: Output, value: unknown): void {
  output.log(JSON.stringify(value, null, 2));
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column]?.length ?? 0),
  ));
  return [headers, ...rows]
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd())
    .join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Vendo Cloud request failed";
}
