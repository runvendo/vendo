import { loadConfig, saveConfig, configPath } from "@vendoai/telemetry";
import { homedir } from "node:os";

export interface TelemetryCmdIO {
  home?: string;
  log: (msg: string) => void;
}

export function runTelemetryCmd(sub: string | undefined, io: TelemetryCmdIO): number {
  const home = io.home ?? homedir();
  const config = loadConfig(home);
  switch (sub) {
    case "status":
      io.log(
        `Vendo telemetry: ${config.optedOut ? "disabled" : "enabled"}\n` +
          `anonymous id: ${config.anonymousId}\n` +
          `config: ${configPath(home)}\n` +
          `details: TELEMETRY.md`,
      );
      return 0;
    case "disable":
      saveConfig(home, { ...config, optedOut: true });
      io.log("Vendo telemetry disabled.");
      return 0;
    case "enable":
      saveConfig(home, { ...config, optedOut: false });
      io.log("Vendo telemetry enabled. It is anonymous (see TELEMETRY.md).");
      return 0;
    default:
      io.log("Usage: vendo telemetry <status|enable|disable>");
      return 1;
  }
}
