import type { Output } from "../shared.js";
import { CAPABILITY_KEYS, METER_KEYS, type ContractV2, type MeterUsage } from "./entitlements.js";
import type { EntitlementState } from "./entitlements-cache.js";

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

function capabilityLine(contract: ContractV2, offset: number): string {
  const entries = CAPABILITY_KEYS.slice(offset, offset + 3).map((key) => {
    return `${contract.capabilities[key] ? "✓" : "✗"} ${key}`;
  });
  // The final row may be partial (CAPABILITY_KEYS need not be a multiple of 3).
  return `  ${entries.map((entry, index) => (index < entries.length - 1 ? entry.padEnd(17) : entry)).join("")}`;
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function meterLine(key: string, meter: MeterUsage): string {
  const filled = meter.included === 0
    ? 0
    : Math.max(0, Math.min(20, Math.round((meter.used / meter.included) * 20)));
  const bar = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
  const usage = meter.included === 0
    ? "      —"
    : `  ${number(meter.used).padStart(5)} / ${number(meter.included).padEnd(6)} (${number(meter.remaining)} left)`;
  return `  ${key.padEnd(17)}${bar}${usage}${meter.exhausted ? " EXHAUSTED" : ""}`;
}

export function renderContract(
  contract: ContractV2,
  meta?: { state: EntitlementState; fetchedAt?: number },
): string {
  const lines: string[] = [];
  if (meta?.state === "stale" && meta.fetchedAt !== undefined) {
    lines.push(`stale since ${new Date(meta.fetchedAt * 1_000).toISOString()} (console unreachable)`);
  } else if (meta?.state === "degraded") {
    lines.push("degraded to free entitlements (console unreachable > 24h)");
  }
  lines.push(meta?.state === "degraded"
    ? "Vendo Cloud key: unverified (offline)"
    : "Vendo Cloud key: valid");
  if (contract.org.name && contract.org.slug) lines.push(`Org:  ${contract.org.name} (${contract.org.slug})`);
  lines.push(`Plan: ${contract.plan.name} (${contract.plan.status})`);
  lines.push("", "Capabilities");
  for (let index = 0; index < CAPABILITY_KEYS.length; index += 3) {
    lines.push(capabilityLine(contract, index));
  }
  lines.push("", "Quota (this billing period)");
  for (const key of METER_KEYS) lines.push(meterLine(key, contract.limits[key]));
  return lines.join("\n");
}
