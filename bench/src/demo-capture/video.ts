import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code ?? "without a code"}: ${stderr.slice(-4_000)}`));
    });
  });
}

export async function videoToGif(input: string, output: string, options: { fps?: number; width?: number } = {}): Promise<void> {
  const fps = options.fps ?? 10;
  const width = options.width ?? 960;
  await mkdir(path.dirname(output), { recursive: true });
  // The split branches require a filter-complex graph; keeping this as one
  // invocation avoids a temporary palette artifact in the output directory.
  await run("ffmpeg", [
    "-y", "-i", input,
    "-filter_complex",
    `[0:v]fps=${fps},scale=${width}:-2:flags=lanczos,split[gifsrc][palettesrc];[palettesrc]palettegen=max_colors=160:stats_mode=diff[palette];[gifsrc][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]`,
    "-map", "[out]", "-loop", "0", output,
  ]);
}

async function durationSeconds(file: string): Promise<number> {
  const stdout = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
}

export async function combineGifsSideBySide(inputs: string[], output: string): Promise<void> {
  if (inputs.length < 2) throw new Error("At least two GIFs are required for a side-by-side capture");
  const durations = await Promise.all(inputs.map(durationSeconds));
  const duration = Math.max(...durations);
  await mkdir(path.dirname(output), { recursive: true });
  const args: string[] = ["-y"];
  for (const input of inputs) args.push("-i", input);
  const panels = inputs.map((_, index) => `[${index}:v]fps=10,trim=duration=${duration},setpts=PTS-STARTPTS,scale=600:375:force_original_aspect_ratio=decrease,pad=600:375:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12[panel${index}]`);
  const labels = inputs.map((_, index) => `[panel${index}]`).join("");
  const graph = [
    ...panels,
    `${labels}hstack=inputs=${inputs.length}:shortest=0[grid]`,
  ].join(";");
  args.push("-filter_complex", graph, "-map", "[grid]", "-t", String(duration), "-loop", "0", output);
  await run("ffmpeg", args);
}
