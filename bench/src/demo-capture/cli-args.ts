import path from "node:path";

export const demoBeats = [
  "streaming-first-paint",
  "host-component",
  "remix-edit",
  "demo-beats",
  "corpus-montage",
] as const;

export type DemoBeat = typeof demoBeats[number];
export type DemoHost = "maple" | "cadence" | "both";

export interface BrowserCaptureArgs {
  beat: Exclude<DemoBeat, "corpus-montage" | "demo-beats">;
  host: DemoHost;
  prompt?: string;
  editPrompt?: string;
  port: number;
  timeoutMs: number;
  runId?: string;
  headed: boolean;
  boot: boolean;
  url: string | undefined;
  outputDir: string | undefined;
}

/** The generic adapter: one template-derived app directory (demo.config.json
 * + package.json) instead of a concrete maple/cadence host. */
export interface ConfigCaptureArgs {
  beat: "demo-beats";
  hostConfig: string;
  port: number;
  timeoutMs: number;
  runId?: string;
  headed: boolean;
  boot: boolean;
  url: string | undefined;
  outputDir: string | undefined;
}

export interface MontageArgs {
  beat: "corpus-montage";
  galleryRun: string;
  repos?: string[];
  output?: string;
  fps: number;
  durationSeconds: number;
  panelWidth: number;
  panelHeight: number;
}

export type DemoCaptureArgs = BrowserCaptureArgs | ConfigCaptureArgs | MontageArgs;

const valueOptions = new Set([
  "--host",
  "--host-config",
  "--prompt",
  "--edit-prompt",
  "--port",
  "--timeout-ms",
  "--run-id",
  "--url",
  "--output-dir",
  "--gallery-run",
  "--repos",
  "--output",
  "--fps",
  "--duration",
  "--panel-width",
  "--panel-height",
]);

function optionMap(argv: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (option === "--headed" || option === "--no-boot") {
      options.set(option, true);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  return options;
}

function textOption(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function positiveNumber(options: Map<string, string | true>, name: string, fallback: number): number {
  const raw = textOption(options, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function parseHost(raw: string | undefined, fallback: DemoHost): DemoHost {
  const host = raw ?? fallback;
  if (host !== "maple" && host !== "cadence" && host !== "both") {
    throw new Error(`--host must be maple, cadence, or both (received ${host})`);
  }
  return host;
}

export function parseDemoCaptureArgs(argv: string[]): DemoCaptureArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const beat = normalizedArgv[0];
  if (!demoBeats.includes(beat as DemoBeat)) {
    throw new Error(`Unknown demo beat: ${beat ?? "(missing)"}`);
  }
  const options = optionMap(normalizedArgv);

  const hostConfig = textOption(options, "--host-config");
  if (hostConfig !== undefined && options.has("--host")) {
    throw new Error("--host and --host-config are mutually exclusive");
  }
  if (hostConfig !== undefined && beat !== "demo-beats") {
    throw new Error("--host-config is only supported by the demo-beats beat");
  }

  if (beat === "corpus-montage") {
    const galleryRun = textOption(options, "--gallery-run");
    if (galleryRun === undefined) throw new Error("--gallery-run is required for corpus-montage");
    const repos = textOption(options, "--repos")?.split(",").map((repo) => repo.trim()).filter(Boolean);
    return {
      beat,
      galleryRun,
      ...(repos === undefined ? {} : { repos }),
      ...(textOption(options, "--output") === undefined ? {} : { output: textOption(options, "--output") }),
      fps: positiveNumber(options, "--fps", 10),
      durationSeconds: positiveNumber(options, "--duration", 12),
      panelWidth: positiveNumber(options, "--panel-width", 320),
      panelHeight: positiveNumber(options, "--panel-height", 180),
    };
  }

  if (beat === "demo-beats") {
    if (hostConfig === undefined) throw new Error("--host-config is required for demo-beats");
    return {
      beat,
      hostConfig,
      port: positiveNumber(options, "--port", 3000),
      timeoutMs: positiveNumber(options, "--timeout-ms", 180_000),
      ...(textOption(options, "--run-id") === undefined ? {} : { runId: textOption(options, "--run-id") }),
      headed: options.has("--headed"),
      boot: !options.has("--no-boot"),
      url: textOption(options, "--url"),
      outputDir: textOption(options, "--output-dir"),
    } as ConfigCaptureArgs;
  }

  const fallbackHost: DemoHost = beat === "streaming-first-paint" ? "both" : "maple";
  const host = parseHost(textOption(options, "--host"), fallbackHost);
  const boot = !options.has("--no-boot");
  const url = textOption(options, "--url");
  if (!boot && host === "both") {
    throw new Error("--no-boot can target only one host; use --host maple or --host cadence");
  }
  return {
    beat,
    host,
    ...(textOption(options, "--prompt") === undefined ? {} : { prompt: textOption(options, "--prompt") }),
    ...(textOption(options, "--edit-prompt") === undefined ? {} : { editPrompt: textOption(options, "--edit-prompt") }),
    port: positiveNumber(options, "--port", 3000),
    timeoutMs: positiveNumber(options, "--timeout-ms", 180_000),
    ...(textOption(options, "--run-id") === undefined ? {} : { runId: textOption(options, "--run-id") }),
    headed: options.has("--headed"),
    boot,
    url,
    outputDir: textOption(options, "--output-dir")?.split(path.sep).join(path.sep),
  } as BrowserCaptureArgs;
}
