import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { envOptOut } from "./consent.js";

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

export function loadConfig(
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  const path = configPath(home);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryConfig>;
      const hasId = typeof raw.anonymousId === "string" && raw.anonymousId.length > 0;
      const optedOut = raw.optedOut === true;
      // Honor the file when it carries EITHER an id or an explicit decision. A
      // hand-written {optedOut:true} with no id must never be silently
      // overwritten back to opted-in; synthesize an (unsent) id and keep it.
      if (hasId || optedOut) {
        return {
          anonymousId: hasId ? (raw.anonymousId as string) : randomUUID(),
          optedOut,
          noticeShown: raw.noticeShown === true,
        };
      }
    } catch {
      // Fall through to regenerate on unreadable/corrupt file.
    }
  }
  const fresh: TelemetryConfig = { anonymousId: randomUUID(), optedOut: false, noticeShown: false };
  // No usable config on disk. If an env opt-out is in effect, return an
  // ephemeral opted-out config — never persist a tracking id the user asked us
  // not to keep. Only a genuine opted-in first run gets written.
  if (envOptOut(env)) return { ...fresh, optedOut: true };
  try {
    saveConfig(home, fresh);
  } catch {
    // Read-only home / ENOSPC etc.: degrade to an in-memory config rather than
    // crashing callers like `vendo telemetry`. The id just won't persist.
  }
  return fresh;
}

export function saveConfig(home: string, config: TelemetryConfig): void {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", "utf8");
}
