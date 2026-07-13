import type { Output } from "../shared.js";

export const cloudConsoleOutput: Output = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export function printJson(output: Output, value: unknown): void {
  output.log(JSON.stringify(value, null, 2));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Vendo Cloud request failed";
}
