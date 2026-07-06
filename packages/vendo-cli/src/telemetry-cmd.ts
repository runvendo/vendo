import { loadConfig, saveConfig, configPath } from "@vendoai/telemetry";
import { homedir } from "node:os";
import { createUi } from "./ui.js";

export interface TelemetryCmdIO {
  home?: string;
  log: (msg: string) => void;
}

export function runTelemetryCmd(sub: string | undefined, io: TelemetryCmdIO): number {
  const home = io.home ?? homedir();
  const config = loadConfig(home);
  // Route through the shared renderer, but keep io.log as the sink so tests
  // stay hermetic and the caller owns the transport. The Ui appends a newline
  // per line; strip it because io.log (console.log in production) adds its own.
  const ui = createUi({ sink: (chunk) => io.log(chunk.replace(/\n$/, "")) });
  switch (sub) {
    case "status":
      ui.header("vendo telemetry");
      // "ok" for both states — a user opt-out is a valid choice, not a problem.
      ui.step("ok", `telemetry ${config.optedOut ? "disabled" : "enabled"}`);
      ui.note(`  anonymous id: ${config.anonymousId}`);
      ui.note(`  config: ${configPath(home)}`);
      ui.note("  details: TELEMETRY.md");
      return 0;
    case "disable":
      saveConfig(home, { ...config, optedOut: true });
      ui.step("ok", "telemetry disabled");
      return 0;
    case "enable":
      saveConfig(home, { ...config, optedOut: false });
      ui.step("ok", "telemetry enabled");
      ui.note("  it is anonymous — see TELEMETRY.md");
      return 0;
    default:
      ui.note("Usage: vendo telemetry <status|enable|disable>");
      return 1;
  }
}
