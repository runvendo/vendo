import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface GalleryPair {
  repo: string;
  hostImage: string;
  generatedMedia: string;
  firstPaintMs?: number;
  usableMs?: number;
}

export interface MontageLayout {
  fps?: number;
  durationSeconds?: number;
  panelWidth?: number;
  panelHeight?: number;
  labels?: boolean;
}

export interface AssembleCorpusMontageOptions extends MontageLayout {
  galleryRun: string;
  output: string;
  repos?: string[];
}

const hostExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".ppm"]);
const generatedExtensions = new Set([".gif", ".webm", ".mp4", ".png", ".jpg", ".jpeg", ".webp", ".ppm"]);

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  }));
  return files.flat();
}

function scoreHost(file: string): number {
  const name = path.basename(file).toLowerCase();
  return (name.includes("host") ? 10 : 0)
    + (name.includes("native") ? 8 : 0)
    + (name.includes("baseline") ? 6 : 0)
    + (name.includes("home") ? 2 : 0);
}

function scoreGenerated(file: string): number {
  const name = path.basename(file).toLowerCase();
  return (path.extname(file).toLowerCase() === ".gif" ? 10 : 0)
    + (name.includes("generation") ? 8 : 0)
    + (name.includes("generated") ? 6 : 0)
    + (name.includes("settled") ? 2 : 0);
}

function best(files: string[], score: (file: string) => number): string | undefined {
  return [...files].sort((left, right) => score(right) - score(left) || left.localeCompare(right))[0];
}

function numericDeep(value: unknown, names: Set<string>): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (names.has(normalized) && typeof child === "number" && Number.isFinite(child)) return child;
  }
  for (const child of Object.values(value)) {
    const found = numericDeep(child, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function readTimings(file: string | undefined): Promise<Pick<GalleryPair, "firstPaintMs" | "usableMs">> {
  if (file === undefined) return {};
  const json = JSON.parse(await readFile(file, "utf8")) as unknown;
  const firstPaintMs = numericDeep(json, new Set(["firstpaintms", "firstpaint"]));
  const usableMs = numericDeep(json, new Set(["usablems", "usable", "usableviewms"]));
  return {
    ...(firstPaintMs === undefined ? {} : { firstPaintMs }),
    ...(usableMs === undefined ? {} : { usableMs }),
  };
}

export async function discoverGalleryPairs(galleryRun: string): Promise<GalleryPair[]> {
  const entries = await readdir(galleryRun, { withFileTypes: true });
  const pairs: GalleryPair[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const repoDir = path.join(galleryRun, entry.name);
    const files = await walkFiles(repoDir);
    const timingsFile = files.find((file) => path.basename(file) === "timings.json");
    const hostCandidates = files.filter((file) => hostExtensions.has(path.extname(file).toLowerCase()));
    const generatedCandidates = files.filter((file) => generatedExtensions.has(path.extname(file).toLowerCase()))
      .filter((file) => !hostCandidates.includes(file) || scoreGenerated(file) > scoreHost(file));
    const hostImage = best(hostCandidates, scoreHost);
    const generatedMedia = best(generatedCandidates, scoreGenerated);
    if (hostImage === undefined || generatedMedia === undefined) continue;
    pairs.push({
      repo: entry.name,
      hostImage,
      generatedMedia,
      ...await readTimings(timingsFile),
    });
  }
  return pairs;
}

function drawtextEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(":", "\\:");
}

function seconds(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "--" : `${(milliseconds / 1_000).toFixed(2)}s`;
}

export function buildMontageFfmpegArgs(
  pairs: GalleryPair[],
  output: string,
  layout: MontageLayout = {},
): string[] {
  if (pairs.length === 0) throw new Error("At least one gallery pair is required for the corpus montage");
  const fps = layout.fps ?? 10;
  const durationSeconds = layout.durationSeconds ?? 12;
  const panelWidth = layout.panelWidth ?? 320;
  const panelHeight = layout.panelHeight ?? 180;
  const args: string[] = ["-y"];
  for (const pair of pairs) {
    args.push("-loop", "1", "-framerate", String(fps), "-i", pair.hostImage);
    const generatedExtension = path.extname(pair.generatedMedia).toLowerCase();
    if ([".gif", ".webm", ".mp4"].includes(generatedExtension)) {
      args.push("-i", pair.generatedMedia);
    } else {
      args.push("-loop", "1", "-framerate", String(fps), "-i", pair.generatedMedia);
    }
  }

  const filters: string[] = [];
  pairs.forEach((pair, index) => {
    const hostInput = index * 2;
    const generatedInput = hostInput + 1;
    const repo = drawtextEscape(pair.repo.toUpperCase());
    const timing = drawtextEscape(`paint ${seconds(pair.firstPaintMs)} / usable ${seconds(pair.usableMs)}`);
    const fit = `fps=${fps},trim=duration=${durationSeconds},setpts=PTS-STARTPTS,scale=${panelWidth}:${panelHeight}:force_original_aspect_ratio=decrease,pad=${panelWidth}:${panelHeight}:(ow-iw)/2:(oh-ih)/2:color=0x101318`;
    const hostLabel = layout.labels === false
      ? ""
      : `,drawtext=text='${repo} · HOST':x=8:y=8:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=5`;
    const generatedLabel = layout.labels === false
      ? ""
      : `,drawtext=text='GENERATED · ${timing}':x=8:y=8:fontsize=11:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=5`;
    filters.push(`[${hostInput}:v]${fit}${hostLabel}[host${index}]`);
    filters.push(`[${generatedInput}:v]${fit}${generatedLabel}[generated${index}]`);
    filters.push(`[host${index}][generated${index}]vstack=inputs=2:shortest=0[column${index}]`);
  });
  const columns = pairs.map((_, index) => `[column${index}]`).join("");
  if (pairs.length === 1) {
    filters.push(`${columns}null[grid]`);
  } else {
    filters.push(`${columns}hstack=inputs=${pairs.length}:shortest=0[grid]`);
  }
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[grid]",
    "-t", String(durationSeconds),
    "-loop", "0",
    output,
  );
  return args;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? "without a code"}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function ffmpegHasFilter(name: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0 && new RegExp(`\\b${name}\\b`).test(stdout)));
  });
}

export async function assembleCorpusMontage(options: AssembleCorpusMontageOptions): Promise<GalleryPair[]> {
  const discovered = await discoverGalleryPairs(options.galleryRun);
  const byRepo = new Map(discovered.map((pair) => [pair.repo, pair]));
  const pairs = options.repos === undefined
    ? discovered.slice(0, 5)
    : options.repos.map((repo) => {
      const pair = byRepo.get(repo);
      if (pair === undefined) throw new Error(`Gallery run has no complete host/generated pair for ${repo}`);
      return pair;
    });
  if (pairs.length === 0) throw new Error(`No gallery pairs found under ${options.galleryRun}`);
  await mkdir(path.dirname(options.output), { recursive: true });
  const labels = options.labels ?? await ffmpegHasFilter("drawtext");
  await runFfmpeg(buildMontageFfmpegArgs(pairs, options.output, { ...options, labels }));
  return pairs;
}
