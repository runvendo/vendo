import type { TelemetryConfig } from "./config.js";

const NOTICE = [
  "Flowlet collects anonymous, opt-out usage telemetry to guide development.",
  "No code, prompts, file contents, or keys are ever collected.",
  "Details and opt-out: TELEMETRY.md; disable now: `flowlet telemetry disable`",
  "(also honored: FLOWLET_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1, CI)",
].join("\n");

export interface NoticeIO {
  log: (msg: string) => void;
  save: (config: TelemetryConfig) => void;
}

export function maybeShowNotice(config: TelemetryConfig, io: NoticeIO): TelemetryConfig {
  if (config.optedOut || config.noticeShown) return config;
  io.log(NOTICE);
  const updated = { ...config, noticeShown: true };
  io.save(updated);
  return updated;
}
