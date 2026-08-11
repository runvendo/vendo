/**
 * The vendo banner — the real logo at terminal resolution.
 *
 * The art is DATA, not drawing code: the Vendo mark (four stepped squares and
 * the flowing ribbon) and the lowercase wordmark, rasterized from the logo to
 * half-block cells (`█ ▀ ▄`) at two pixel rows per text row. Colour is one
 * left-to-right #6c3bff → #a78bfa ramp mapped across the art's COLUMNS, so the
 * gradient runs through the whole mark instead of restarting on every row;
 * terminals without truecolor get the ANSI magenta pair.
 *
 * Three arrival concepts ship (the CLI plays BANNER_CONCEPT). Whichever plays,
 * the last frame is the settled frame — a terminal that drops every frame in
 * between still lands on the finished mark. It plays once and never loops, and
 * only a TTY with colour ever sees it: the gate is pretty.ts's usePrettyOutput.
 */

const ESC = "\u001b";
const RESET = `${ESC}[39m`;

/** Brand ramp endpoints — vendo purple → lilac. */
const RAMP_FROM = [0x6c, 0x3b, 0xff] as const;
const RAMP_TO = [0xa7, 0x8b, 0xfa] as const;
/** The bright band that leads the flow and shimmer passes. */
const BAND: Record<BannerColorMode, string> = {
  truecolor: `${ESC}[38;2;246;241;255m`,
  ansi: `${ESC}[97m`,
};

export type BannerColorMode = "truecolor" | "ansi";
export type BannerConcept = "assembly" | "flow" | "shimmer";

/** 12 rows × 72 columns — wordmark beside the mark; fits an 80-column window
    and costs less than half the scrollback of the large art. */
export const BANNER_COMPACT: readonly string[] = [
  "                                                                        ",
  "                ▄▄█████▄                                                ",
  "   ████   ██████████████▄                                               ",
  "   ████▄▄▄██▀▀▀▀█████████                                               ",
  "       ███     ▄████████                                     ██         ",
  " ▄▄▄▄  ▀▀▀ ▄▄▄█████████     ██    ██ ▄██████▄ ██▄████▄ ▄████▄██ ▄██████▄",
  " ████      ███████████      ▀█▄  ▄█▀ ██▄▄▄▄██ ██    ██ ██    ██ ██    ██",
  "       ███    ▀████████▄     ██  ██  ██▀▀▀▀▀▀ ██    ██ ██    ██ ██    ██",
  "       ███  ▄▄▄█████████▄     ▀██▀    ▀████▀  ██    ██ ▀██████▀ ▀██████▀",
  "           ██████████████                                               ",
  "           ▀▀▀▀████████▀                                                ",
  "                 ▀▀▀▀                                                   ",
];

/** 25 rows × 44 columns — wordmark stacked under the mark. */
export const BANNER_LARGE: readonly string[] = [
  "                                            ",
  "                                 ▄▄▄        ",
  "                            ▄▄█████████▄    ",
  "      ▄▄▄▄▄▄      ▄▄██▄▄▄▄▄██████████████   ",
  "      ██████     ████████████████████████▄  ",
  "      ██████     ██████▀▀▀████████████████  ",
  "      ▀▀▀▀▀██████          ██████████████▀  ",
  "           ██████          █████████████▀   ",
  "           ██████       ▄▄█████████████     ",
  "  ██████          ▄███████████████████      ",
  "  ██████          ████████████████████      ",
  "  ██████          ▀███████████████████      ",
  "           ██████       ▀▀█████████████▄    ",
  "           ██████        ▄███████████████   ",
  "           ▀▀▀▀▀▀  ▄▄▄▄▄▄████████████████▄  ",
  "                  ████████████████████████  ",
  "                  ▀██████████████████████▀  ",
  "                    ▀▀▀▀▀▀██████████████▀   ",
  "                            ▀████████▀▀     ",
  "                                            ",
  "                                 ██         ",
  "██    ██ ▄██████▄ ██▄████▄ ▄████▄██ ▄██████▄",
  "▀█▄  ▄█▀ ██▄▄▄▄██ ██    ██ ██    ██ ██    ██",
  " ██  ██  ██▀▀▀▀▀▀ ██    ██ ██    ██ ██    ██",
  "  ▀██▀    ▀████▀  ██    ██ ▀██████▀ ▀██████▀",
];

/** The dim line under the banner: what the product is, and where the docs are. */
export const BANNER_TAGLINE = " Customize your product with an embedded agent — docs.vendo.run";

/** The arrival the CLI plays. Decided: the flow. */
export const BANNER_CONCEPT: BannerConcept = "flow";

/** Frames per concept — ~1.0-1.4s at the default 90ms cadence. */
const FRAME_COUNT: Record<BannerConcept, number> = { assembly: 14, flow: 15, shimmer: 11 };
/** How many columns the shimmer band covers. */
const SHIMMER_BAND = 6;
/** How many columns the flow's leading edge burns bright. */
const FLOW_BAND = 2;

/** Which part of the art a frame shows: rows/cols past the reveal are blank,
    columns inside the band burn bright instead of taking the ramp. */
interface FrameView {
  rows?: number;
  cols?: number;
  band?: readonly [number, number];
}

function rampColor(column: number, width: number, mode: BannerColorMode): string {
  if (mode === "ansi") return column * 2 < width ? `${ESC}[35m` : `${ESC}[95m`;
  const position = width <= 1 ? 0 : column / (width - 1);
  const mix = (channel: number): number =>
    Math.round(RAMP_FROM[channel]! + (RAMP_TO[channel]! - RAMP_FROM[channel]!) * position);
  return `${ESC}[38;2;${mix(0)};${mix(1)};${mix(2)}m`;
}

function paintRow(row: string, width: number, mode: BannerColorMode, view: FrameView): string {
  let painted = "";
  let open = "";
  for (let column = 0; column < row.length; column += 1) {
    const glyph = view.cols !== undefined && column >= view.cols ? " " : row[column]!;
    if (glyph === " ") {
      painted += " ";
      continue;
    }
    const banded = view.band !== undefined && column >= view.band[0] && column < view.band[1];
    const color = banded ? BAND[mode] : rampColor(column, width, mode);
    if (color !== open) {
      painted += color;
      open = color;
    }
    painted += glyph;
  }
  return open === "" ? painted : `${painted}${RESET}`;
}

function paintFrame(art: readonly string[], mode: BannerColorMode, view: FrameView = {}): string {
  const width = Math.max(...art.map((row) => row.length));
  return art
    .map((row, index) =>
      view.rows !== undefined && index >= view.rows ? " ".repeat(row.length) : paintRow(row, width, mode, view))
    .join("\n");
}

/** The settled banner — every concept's last frame, and what a run that never
    animates prints. */
export function renderBanner(art: readonly string[], mode: BannerColorMode): string {
  return paintFrame(art, mode);
}

/**
 * The arrival, as ANSI frames. LAW: the last frame ALWAYS equals the settled
 * frame, for every concept — the animation can only ever be a faster way to
 * arrive at `renderBanner`, never a different picture.
 */
export function bannerFrames(
  art: readonly string[],
  mode: BannerColorMode,
  concept: BannerConcept,
): string[] {
  const count = FRAME_COUNT[concept];
  const width = Math.max(...art.map((row) => row.length));
  const frames: string[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const progress = (index + 1) / count;
    if (concept === "assembly") {
      // The mark lands top-down; nothing below the edge is drawn yet.
      frames.push(paintFrame(art, mode, { rows: Math.ceil(progress * art.length) }));
    } else if (concept === "flow") {
      // A band passes and the mark crystallizes behind it.
      const edge = Math.round(progress * width);
      frames.push(paintFrame(art, mode, { cols: edge, band: [edge - FLOW_BAND, edge] }));
    } else {
      // Complete on frame one; one bright band walks across it.
      const edge = Math.round(progress * (width + SHIMMER_BAND));
      frames.push(paintFrame(art, mode, { band: [edge - SHIMMER_BAND, edge] }));
    }
  }
  frames.push(renderBanner(art, mode));
  return frames;
}

/** Truecolor when the terminal says so; ANSI magenta otherwise. */
export function bannerColorMode(
  env: Record<string, string | undefined> = process.env,
): BannerColorMode {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  return /truecolor|24bit|direct/i.test(env.TERM ?? "") ? "truecolor" : "ansi";
}

/**
 * Play the frames in place: cursor-up over the block and redraw, once. No
 * alternate screen buffer — the settled banner stays in the scrollback as the
 * top of the transcript. A resize mid-play costs one ragged frame, then the
 * settled one.
 *
 * `signal` cuts it short, and the settled frame is drawn INSIDE abort() —
 * synchronously, before abort() returns — so a run that has to end mid-arrival
 * (an interrupt) leaves the finished mark behind, never a half-drawn one.
 * Ordinary printing needs no abort: it goes BELOW the art (see `below`).
 */
export async function playBanner(
  write: (chunk: string) => void,
  frames: readonly string[],
  frameMs = 90,
  signal?: AbortSignal,
  /** SCREEN rows of content the caller has printed BELOW the art since it
      started. When provided, each frame repaints the art in place above that
      content (save cursor → up over content+art → paint → restore), so the run
      keeps talking while the wave still plays. The caller maintains the count
      and owes screen rows, not lines — a line that wraps is more than one. */
  below?: { rows: number },
): Promise<void> {
  const [first, ...rest] = frames;
  if (first === undefined) return;
  const rows = first.split("\n").length;
  const paint = (frame: string): void => {
    const offset = rows + (below?.rows ?? 0);
    write(`${ESC}7${ESC}[${offset}A`);
    write(frame.split("\n").map((row) => `${ESC}[2K${row}`).join("\n"));
    write(`${ESC}8`);
  };
  write(`${first}\n`);
  let playing = true;
  const settleFrame = (): void => { paint(frames.at(-1)!); };
  signal?.addEventListener("abort", () => {
    if (playing) settleFrame();
  }, { once: true });
  for (const frame of rest) {
    await new Promise<void>((settle) => { setTimeout(settle, frameMs); });
    if (signal?.aborted === true) return;
    paint(frame);
  }
  playing = false;
}
