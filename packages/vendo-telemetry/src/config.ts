import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface TelemetryConfig {
  anonymousId: string;
  optedOut: boolean;
  noticeShown: boolean;
}

export function configDir(home = homedir()): string {
  return join(home, ".vendo");
}

export function configPath(home = homedir()): string {
  return join(configDir(home), "telemetry.json");
}

export function loadConfig(home = homedir()): TelemetryConfig {
  const path = configPath(home);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryConfig>;
      if (typeof raw.anonymousId === "string" && raw.anonymousId.length > 0) {
        return {
          anonymousId: raw.anonymousId,
          optedOut: raw.optedOut === true,
          noticeShown: raw.noticeShown === true,
        };
      }
    } catch {
      // Fall through to regenerate on unreadable/corrupt file.
    }
  }
  const fresh: TelemetryConfig = { anonymousId: randomUUID(), optedOut: false, noticeShown: false };
  saveConfig(home, fresh);
  return fresh;
}

export function saveConfig(home: string, config: TelemetryConfig): void {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", "utf8");
}
