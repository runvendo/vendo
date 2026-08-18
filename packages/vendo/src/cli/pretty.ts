import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { vendoStyle } from "@vendoai/core";
import { BANNER_COMPACT, BANNER_CONCEPT, BANNER_TAGLINE, bannerColorMode, bannerFrames, playBanner } from "./banner.js";
import type { Output } from "./shared.js";

/**
 * The vendo CLI's TTY visual system (init first; doctor/sync can adopt the
 * same primitives later). Clack-style vertical-bar layout: the banner, one
 * `┌ vendo init` header, `◇`/`◆` section markers on a dim `│` rail, colored
 * diff markers, a braille spinner for the slow phases, and ONE deliberately
 * emphasized block — Vendo Cloud. The accent is the brand purple family;
 * green, yellow and red keep their meanings: added, changed, broken.
 *
 * Degradation contract: this module is only selected when stdout is a real
 * TTY and none of NO_COLOR / CI / TERM=dumb opt out (see usePrettyOutput).
 * Every other run — tests, pipes, CI — keeps today's exact plain strings,
 * because runInit's emissions are unchanged: this is a renderer over the
 * existing Output seam, not a second copy of the copy. The collapse rules
 * below are pure string rules over those exact plain strings; the renderer
 * restyles and groups. The copy it owns is the block TITLES and the one docs
 * pointer (MOUNT_DOCS) that cannot live in the caller without changing the
 * receipt's pinned `pasteEdits`; every fact on screen is still the caller's.
 */

const ESC = "\u001b";
/** The palette is core's — ONE set of colours for the CLI rail and the boot
    summary `createVendo` prints (@vendoai/core's style.ts). These five are
    env-independent, so they are read once here; the accent is not (which purple
    it is depends on the terminal), so it rides the env its renderer was built
    with — the same probe `bannerColorMode` makes for the ramp above it. */
const { bold, dim, ok: green, warn: yellow, bad: red } = vendoStyle();
const accentFor = (env: Record<string, string | undefined>): ((text: string) => string) =>
  vendoStyle(undefined, env).accent;
/** Re-arm sequences for the two colors that can wrap a whole line. */
const REOPEN_YELLOW = `${ESC}[33m`;
const REOPEN_RED = `${ESC}[31m`;

/** TTY + no opt-outs → the pretty renderer; anything else keeps plain output.
    NO_COLOR and CI follow the "present and non-empty" convention. ONE copy of
    that law, in core, because the boot summary degrades by the same rule. */
export function usePrettyOutput(
  stream: { isTTY?: boolean } = stdout,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return vendoStyle(stream, env).pretty;
}

export interface SelectOption {
  value: string;
  label: string;
  /** Dim parenthetical after the label (e.g. what detection found). */
  hint?: string;
}

/** The slice of a readable TTY stream the select loop needs (injectable for
    tests — a plain emitter drives the keypress parser without a PTY). */
export interface SelectInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface PrettyOutput extends Output {
  /** Braille spinner for a slow phase; any log/error line clears the frame. */
  spin(label: string): void;
  stopSpin(): void;
  /** The styled [Y/n] confirm — Enter accepts the default, answer echoed. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** The styled select — arrows move, Enter accepts, number keys pick
      directly; collapses to the chosen answer. Number keys cover options
      1-9 only: keep lists at nine options or fewer (a longer list stays
      arrow-navigable, but two-digit entry is deliberately not built). */
  select(question: string, options: SelectOption[], defaultIndex?: number): Promise<string>;
  /** A free-text answer; Enter returns `defaultValue` where one is given, else
      "" and the caller decides what a skip means. The echoed receipt shows what
      the answer actually WAS, so an accepted default never reads as "skipped".
      Non-TTY stdin never prompts — "" stands. */
  text(question: string, hint?: string, defaultValue?: string): Promise<string>;
  /** A secret: the typing is not echoed and only a masked receipt reaches the
      transcript. The value itself is NEVER written to the terminal. */
  secret(question: string, hint?: string): Promise<string>;
  /** A pretty-only result block. It has no plain sibling on purpose: callers
      keep emitting their plain lines, and this restyles nothing — it is for
      blocks the pretty run composes itself. */
  block(title: string, lines: string[], marker?: "◆" | "◇"): void;
  /** The staggered sibling of block(): waits for the banner arrival, plays an
      optional spinner beat (the detection narration), then lands the lines
      ~stepMs apart so the section arrives as a rhythm instead of a burst.
      A line carrying its own beat gets a labeled spinner moment first — the
      scan finds things one at a time. Pretty-only, like block(). */
  revealBlock(
    title: string,
    lines: Array<string | { beat?: string; text: string }>,
    options?: { stepMs?: number; beat?: string },
  ): Promise<void>;
  /** The `└ Done in Xs` footer (red `Failed` when the command exits non-zero);
      `stats` is the dim tail that says what the run actually achieved, and a
      dim star line closes the run. */
  done(durationMs: number, ok: boolean, stats?: string): void;
  /** Settles when the banner has finished arriving. Printing never waits on it
      and nothing cuts it short: the tagline, the header and the scan all print
      BELOW the art while the frames repaint above them, so the run keeps
      talking through the wave. This is for the one caller that wants the
      arrival SEEN — it awaits whatever is left after its own work, and pays
      nothing it did not already spend. A cancel still settles it instantly:
      Ctrl-C aborts, which paints the finished mark before the run ends. */
  arrived: Promise<void>;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR = dim("│");
const CLEAR_LINE = `\r${ESC}[2K`;
/** Splits a chunk into text, CSI sequences (none of which costs a cell) and the
    two control characters that move the cursor on their own. Captured, so
    `split` keeps them. */
const SPLIT_CSI = new RegExp(`(${ESC}\\[[0-9;?]*[A-Za-z]|[\\n\\r])`);
const RESET = `${ESC}[0m`;
const SHOW_CURSOR = `${ESC}[?25h`;
/** Columns the rail costs a continuation row: `│` plus the two-space body gap. */
const RAIL_WIDTH = 3;
/** The star ask, demoted from an interactive question to a dim last line —
    pretty-only, so a piped or NO_COLOR run never sees it. */
const STAR_FOOTER = "Star us: vendo.run/star · docs.vendo.run";

/** The five always-printed catalog lines, collapsed into one block. */
const CATALOG_PREFIXES = ["tools: ", "tool schemas: ", "pins: ", "catalog.json: ", "components: "];
const CATALOG_COMPONENTS = "components: ";
const JUDGMENT_HEAD = /^judgment \(.+\): (.+)$/;
const JUDGMENT_QUEUED = "loosenings queued";
/** EVERY tally `reportJudgment` prints under the head line, verbatim and in
    its order — packages/vendo/src/cli/judge/pass.ts:1034-1075. Only these join
    the counts summary.

    An allowlist and not a shape, because the pass emits the model's free-text
    at the SAME indent as its tallies, and prose can wear any shape: `The
    proposal adds (2): examples` matches `<words> (N):` perfectly, so a shape
    test lifts it into the summary and eats its tail. Prose cannot be on this
    list, so it cannot impersonate a tally.

    THE FAILURE THIS TRADES FOR: add a tally to pass.ts and not here, and it
    renders as prose on its own body line instead of joining the summary —
    visibly demoted, never garbled or truncated. Keep the two in step. */
const JUDGMENT_TALLIES = [
  "hardened fields",
  "schemas inferred",
  "schema proposals refused",
  "loosenings approved",
  "loosenings declined and dropped",
  "rejected by the skeptic",
  "unexamined after one re-ask, rejected",
  "no evidence → rejected",
  "malformed proposals ignored",
  "risk grade contradicted its own reason, dropped",
  "wholly rejected, left unjudged",
  "proposals for unknown tools ignored",
];
/** `<allowed label> (12)` → that segment; anything else → null. The count must
    close the label, so a tally's name list never reaches the summary. */
function judgmentTally(text: string): string | null {
  const label = JUDGMENT_TALLIES.find((entry) => text.startsWith(`${entry} (`));
  if (label === undefined) return null;
  const count = /^ \((\d+)\)(?::|$)/.exec(text.slice(label.length));
  return count === null ? null : `${label} (${count[1]!})`;
}
/** The paste block's ASCII frame — dropped; the block rides the rail instead. */
const PASTE_RULE = "─".repeat(64);
const PASTE_HEAD = /^(ONE|\d+) STEPS? LEFT — paste th(?:is|ese) yourself \((.+)\)$/;
const PASTE_FILE = /^ {2}File: (.+)$/;
/** The caller's one-line wrap instruction — `… then wrap: <VendoProvider …>
    {children}</VendoProvider>` — destructured so the block can print the real
    JSX instead of the prose: the open tag, a dim `…` for the app tree that is
    already there, the close tag. The children capture is deliberately dropped;
    the child expression genuinely differs by router (`{children}` in an
    app-router layout, `<Component {...pageProps} />` in a pages `_app`), so one
    literal in the terminal would be wrong for half of hosts and the docs
    pointer below carries the exact per-router wording instead. */
const MOUNT_WRAP = /^… then wrap: (<VendoProvider\b[^>]*>).*<\/VendoProvider>$/;
/** This pointer is the renderer's and not the caller's: the mount's `lines` are
    pinned byte-for-byte by the receipt's `pasteEdits`, and a line added there
    would change that JSON. Emitted here, the --agent path never sees it (the
    rail is off in agent mode). */
const MOUNT_DOCS = "docs.vendo.run/quickstart#the-client-mount — exact wording for layout.tsx and _app.tsx";
const WIRED = /^(Wired \(\d+ files?\)):$/;
const DIFF_MARKER = /^ {2}([+~]) (.+)$/;
const THEME = /^Theme: (.*)$/;
/** The four slots the brand block shows. The caller keeps emitting all seven:
    that same line is what drives init's "No host evidence for…" report, so
    narrowing it would silently stop reporting surface/mutedText/border. */
const BRAND_SLOTS = ["accent", "background", "text", "danger"] as const;
const PALETTE_ENTRY = /(\w+) (#[0-9a-fA-F]{6})$/;
/** Any SGR the caller already wrote — stripped before the hexes are parsed. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SYNC_THEME = /^theme: (.+)$/;
/** One `impact:` line per changed tool at the end of a sync — one block. */
const IMPACT_LINE = "impact: ";
/** Weight on the references, because that count is what the answer turns on. */
const IMPACT_BREAKS = /^(.+ breaks )(.+)$/;
const CLOUD_ABSENT = /^Vendo Cloud \(optional\): not configured\. A key unlocks (.+)\.$/;
const CLOUD_PRESENT = /^Vendo Cloud: (.+)$/;
const CTA = /`?vendo (cloud )?login`?/;
const CTA_ALL = /`?vendo (cloud )?login`?/g;

/** Inline `code spans` in the accent color. The span's close resets the
    foreground to default, so a span inside a colored line bleaches everything
    after it — `reopen` re-arms the enclosing color (error() passes it). */
function styleInline(text: string, accent: (text: string) => string, reopen = ""): string {
  return text.replace(/`([^`]+)`/g, (_match, code: string) => `${bold(accent(code))}${reopen}`);
}

/** Invisible code points: combining marks (Mn/Me — the accent in a decomposed
    `é`) and format characters (Cf — the zero-width joiner, variation
    selectors' friends). A terminal draws them into the PREVIOUS cell. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
/** Emoji are two cells wherever they live, and the ones that are two cells by
    DEFAULT are exactly `Emoji_Presentation` — which is why this is a property
    and not a list: a hand-kept emoji range table silently under-measures every
    block Unicode adds next (it did: U+1FA70 `🩰` fell through as one cell), and
    under-measuring is the direction that overflows a row. It also correctly
    leaves `™`, `☀` and `✔` at one cell, since a terminal draws those as text
    unless a variation selector says otherwise. */
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u;
/** The East Asian Wide and Fullwidth blocks, which are not an emoji property:
    CJK, Kana, Hangul, fullwidth forms, CJK extensions. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

/** What forces emoji presentation, whatever the base's own width would be: the
    emoji variation selector, a skin tone modifier, or a ZWJ join. */
const EMOJI_PRESENTATION = /[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/u;
/** One GRAPHEME CLUSTER is one glyph on screen, however many code points it
    took — `👍🏽` is two, a ZWJ family is four, a decomposed `é` is two, and each
    is drawn as a single glyph. Measuring code points instead over-counts the
    composed ones and under-counts `✔️` (a one-cell base that the variation
    selector promotes to two), which is the direction that overflows a row. */
function cellWidth(cluster: string): number {
  if (EMOJI_PRESENTATION.test(cluster)) return 2;
  const base = String.fromCodePoint(cluster.codePointAt(0) ?? 0);
  if (ZERO_WIDTH.test(base)) return 0;
  if (EMOJI_WIDE.test(base)) return 2;
  const point = base.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([from, to]) => point >= from && point <= to) ? 2 : 1;
}

/** Grapheme segmentation is a built-in (ES2022 / Node 16+) — no dependency. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clusters = (text: string): string[] =>
  [...GRAPHEMES.segment(text)].map((entry) => entry.segment);

/** The one measurement in this file: terminal CELLS a string occupies, with
    SGR sequences taking none. Every width, wrap point and row count derives
    from this — a miscount here puts the select's cursor-up on the wrong row. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(text.replace(SGR, ""))) width += cellWidth(cluster);
  return width;
}

/** What each closing SGR closes, matched on a sequence's FIRST code so the
    truecolor swatch (`48;2;r;g;b`, closed by 49) is tracked like any other. */
const CLOSED_BY: Record<string, RegExp> = {
  "22": /^[12]$/,
  "23": /^3$/,
  "24": /^4$/,
  "27": /^7$/,
  "29": /^9$/,
  "39": /^(3[0-8]|9[0-7])$/,
  "49": /^(4[0-8]|10[0-7])$/,
};

const sgrCode = (sequence: string): string => sequence.slice(2, -1).split(";")[0] ?? "";

/** Track the styles still in force, so a wrapped row can re-open them. Every
    style this file writes nests, so a close pops the innermost match. */
function trackStyle(open: string[], sequence: string): void {
  const code = sgrCode(sequence);
  if (code === "" || code === "0") {
    open.length = 0;
    return;
  }
  const closes = CLOSED_BY[code];
  if (closes === undefined) {
    open.push(sequence);
    return;
  }
  for (let at = open.length - 1; at >= 0; at -= 1) {
    if (closes.test(sgrCode(open[at]!))) {
      open.splice(at, 1);
      return;
    }
  }
}

/** The two things the wrapper moves: SGR sequences (no cells) and grapheme
    clusters (one glyph each). Splitting on the sequences first keeps an ESC
    from being folded into the cluster beside it. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  for (const match of text.matchAll(/\u001b\[[0-9;]*m/g)) {
    tokens.push(...clusters(text.slice(at, match.index)), match[0]);
    at = match.index + match[0].length;
  }
  tokens.push(...clusters(text.slice(at)));
  return tokens;
}

/** Wrap one composed line to the terminal, ANSI-aware: every continuation row
    carries the rail, so a long line still reads as one rail body line, and no
    emitted row is wider than the terminal — which is what makes the select's
    cursor-up redraw (it counts ROWS) land on the rows it printed. Unknown
    width (a pipe, a test writer) means no wrapping at all. */
function wrapRail(text: string, columns: number): string[] {
  if (!Number.isFinite(columns) || columns <= RAIL_WIDTH + 1) return [text];
  if (displayWidth(text) <= columns) return [text];
  const rows: string[] = [];
  const open: string[] = [];
  let atWord: string[] = [];
  let row = "";
  let used = 0;
  let gap = "";
  let word = "";
  let width = 0;
  const breakRow = (): void => {
    rows.push(atWord.length === 0 ? row : `${row}${RESET}`);
    row = `${BAR}  ${atWord.join("")}`;
    used = RAIL_WIDTH;
    gap = "";
  };
  /** Commit the pending word, breaking first when it no longer fits. */
  const place = (): void => {
    if (word === "") return;
    if (used > 0 && used + gap.length + width > columns) breakRow();
    row += `${gap}${word}`;
    used += gap.length + width;
    gap = "";
    word = "";
    width = 0;
  };
  for (const token of tokenize(text)) {
    if (word === "") atWord = [...open];
    if (token.startsWith(ESC)) {
      word += token;
      trackStyle(open, token);
      continue;
    }
    if (token === " ") {
      place();
      gap += " ";
      continue;
    }
    // A word too long for a row of its own (a URL, an unspaced CJK run) has to
    // be broken somewhere: break it BEFORE the glyph that would overflow a row,
    // so a combining mark is never orphaned from the glyph it decorates.
    const cell = cellWidth(token);
    if (cell > 0 && width + cell > columns - RAIL_WIDTH) place();
    word += token;
    width += cell;
  }
  place();
  if (row !== "") rows.push(row);
  return rows;
}

/** The plain-terminal select for non-pretty interactive runs: numbered list +
    readline. Non-TTY runs never prompt — the default option stands; an
    empty, garbage, or out-of-range answer also settles on the default.
    Streams are injectable for tests only; call sites use the defaults. */
export async function plainSelect(
  question: string,
  options: SelectOption[],
  defaultIndex = 0,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = stdout,
): Promise<string> {
  const fallback = (options[defaultIndex] ?? options[0])!.value;
  if (input.isTTY !== true || output.isTTY !== true) return fallback;
  output.write(`${question}\n`);
  options.forEach((option, index) => {
    output.write(`  ${index + 1}. ${option.label}${option.hint === undefined ? "" : ` (${option.hint})`}\n`);
  });
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(`Choose [${defaultIndex + 1}]: `)).trim();
    const number = /^\d+$/.test(answer) ? Number(answer) : NaN;
    if (Number.isInteger(number) && number >= 1 && number <= options.length) {
      return options[number - 1]!.value;
    }
    return fallback;
  } finally {
    prompt.close();
  }
}

/** The plain-terminal free-text prompt — plainSelect's sibling, same non-TTY
    guard: a piped run never prompts and answers "". Enter takes `defaultValue`
    where one is given, so "" always means "nobody was asked", never "the person
    accepted the default". */
export async function plainText(
  question: string,
  hint?: string,
  defaultValue?: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = stdout,
): Promise<string> {
  if (input.isTTY !== true || output.isTTY !== true) return "";
  output.write(`${question}\n`);
  if (hint !== undefined) output.write(`  ${hint}\n`);
  const prompt = createInterface({ input, output });
  try {
    const typed = (await prompt.question("> ")).trim();
    return typed === "" ? defaultValue ?? "" : typed;
  } finally {
    prompt.close();
  }
}

/** Readline's echo goes here so a typed secret never reaches the terminal. */
const MUTED = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

/** What is safe to put in a transcript: proof the value arrived, never the
    value. Anything short enough for the tail to BE the secret shows dots only. */
function maskedReceipt(value: string): string {
  if (value === "") return "skipped";
  return value.length > 8 ? `•••••••• (…${value.slice(-4)})` : "•".repeat(value.length);
}

/** The plain-terminal secret prompt — same non-TTY guard as plainSelect; the
    typing is swallowed and only the masked receipt is echoed. */
export async function plainSecret(
  question: string,
  hint?: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = stdout,
): Promise<string> {
  if (input.isTTY !== true || output.isTTY !== true) return "";
  output.write(`${question}\n`);
  if (hint !== undefined) output.write(`  ${hint}\n`);
  output.write("> ");
  const prompt = createInterface({ input, output: MUTED, terminal: true });
  try {
    const answer = (await prompt.question("")).trim();
    output.write(`${maskedReceipt(answer)}\n`);
    return answer;
  } finally {
    prompt.close();
  }
}

/** What the string rules below are allowed to draw on. The accent rides the
    rail rather than sitting in a module constant, because which purple it is
    depends on the terminal this renderer was built for. */
interface Rail {
  bar(): void;
  body(text: string, reopen?: string): void;
  section(marker: string, title: string): void;
  accent(text: string): string;
}

/** What a collapse rule is still holding, and how much leading indent the rail
    is currently absorbing. */
interface RenderState {
  /** Leading spaces the rail swallows: the first level inside a section, and
      nothing at all under a plain narrative line (whose sub-lines are its
      hierarchy, not the rail's). */
  absorb: number;
  catalog: string[];
  impact: string[];
  judgment: { summary: string; details: string[] } | null;
  paste: { count: number; why: string; titled: boolean } | null;
}

function flushCatalog(state: RenderState, rail: Rail): void {
  if (state.catalog.length === 0) return;
  const lines = state.catalog;
  state.catalog = [];
  rail.section(rail.accent("◆"), bold("Catalog"));
  const counts = lines.filter((entry) => !entry.startsWith(CATALOG_COMPONENTS));
  if (counts.length > 0) rail.body(counts.join(" · "));
  for (const entry of lines.filter((line) => line.startsWith(CATALOG_COMPONENTS))) rail.body(entry);
}

function flushImpact(state: RenderState, rail: Rail): void {
  if (state.impact.length === 0) return;
  const lines = state.impact;
  state.impact = [];
  rail.section(rail.accent("◇"), bold("Impact"));
  for (const entry of lines) {
    const breaks = IMPACT_BREAKS.exec(entry);
    rail.body(breaks === null ? entry : `${breaks[1]!}${bold(breaks[2]!)}`);
  }
}

function flushJudgment(state: RenderState, rail: Rail): void {
  if (state.judgment === null) return;
  const { summary, details } = state.judgment;
  state.judgment = null;
  rail.section(rail.accent("◆"), bold("Judgment"));
  // Three populations at one indent: the tallies, the one line that needs the
  // user, and the model's prose. Only tallies join the summary — splitting a
  // sentence on ": " both put free-text in a counts line and cut it mid-token.
  // A blank line is dropped rather than joined, so no `·  ·` can appear.
  const queued: string[] = [];
  const counted: string[] = [];
  const narrative: string[] = [];
  for (const detail of details) {
    const text = detail.trim();
    if (text === "") continue;
    const tally = judgmentTally(text);
    if (text.includes(JUDGMENT_QUEUED)) queued.push(text);
    // The long name lists behind the colon are what --json and `vendo sync`
    // are for; the count clause in front of it is the summary's share.
    else if (tally !== null) counted.push(tally);
    else narrative.push(text);
  }
  rail.body([summary, ...counted].join(" · "));
  for (const entry of queued) rail.body(entry);
  for (const entry of narrative) rail.body(dim(entry));
}

/** A block of the extracted colour. The truecolor escape lives HERE, never in
    a caller: this renderer is only built when usePrettyOutput() is true, so a
    NO_COLOR / CI / TERM=dumb / piped run can never reach it. */
function swatch(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `${ESC}[48;2;${r};${g};${b}m  ${ESC}[49m`;
}

/** Swatch first, four slots, from the hexes already in the caller's line. */
function brandLine(palette: string): string {
  const slots = new Map<string, string>();
  for (const entry of palette.replace(SGR, "").split(" · ")) {
    const pair = PALETTE_ENTRY.exec(entry.trim());
    if (pair !== null) slots.set(pair[1]!, pair[2]!);
  }
  const shown = BRAND_SLOTS
    .filter((slot) => slots.has(slot))
    .map((slot) => `${swatch(slots.get(slot)!)} ${slots.get(slot)!} ${slot}`);
  return shown.length === 0 ? palette : shown.join("   ");
}

/** The exact-shape rules: one plain string in, one styled section out. */
function renderNamed(raw: string, rail: Rail): boolean {
  const wired = WIRED.exec(raw);
  if (wired !== null) {
    rail.section(rail.accent("◆"), bold(wired[1]!));
    return true;
  }
  if (raw === "Already wired — nothing to change.") {
    rail.section(rail.accent("◇"), `${bold("Already wired")} — nothing to change`);
    return true;
  }
  const marker = DIFF_MARKER.exec(raw);
  if (marker !== null) {
    rail.body(`${marker[1] === "+" ? green("+") : yellow("~")} ${dim(rail.accent(marker[2]!))}`);
    return true;
  }
  const theme = THEME.exec(raw);
  if (theme !== null) {
    rail.section(rail.accent("◆"), bold("Your brand, captured"));
    rail.body(brandLine(theme[1]!));
    return true;
  }
  const syncTheme = SYNC_THEME.exec(raw);
  if (syncTheme !== null) {
    rail.section(rail.accent("◇"), bold("Theme"));
    rail.body(syncTheme[1]!);
    return true;
  }
  if (raw.startsWith("Theme lives in ")) {
    rail.body(dim(raw));
    return true;
  }
  if (raw === "Last steps are yours:") {
    rail.section(rail.accent("◇"), bold("Last steps are yours"));
    return true;
  }
  return renderCloud(raw, rail);
}

/** The one emphasized block: brand header + ✦ bullets + the → CTA. */
function renderCloud(raw: string, rail: Rail): boolean {
  const absent = CLOUD_ABSENT.exec(raw);
  if (absent !== null) {
    rail.section(rail.accent("◆"), bold(rail.accent("Vendo Cloud")));
    for (const bullet of absent[1]!.split("; ")) rail.body(`${rail.accent("✦")} ${rail.accent(bullet)}`);
    return true;
  }
  const present = CLOUD_PRESENT.exec(raw);
  if (present !== null) {
    rail.section(rail.accent("◆"), bold(rail.accent("Vendo Cloud")));
    rail.body(`${rail.accent("✦")} ${rail.accent(present[1]!)}`);
    return true;
  }
  return false;
}

/** Generic detail lines. The rail absorbs the first indent level only, so the
    narrative keeps its hierarchy; the CTA decorates the TRIMMED text and the
    kept indent goes back in front, so the arrow never pushes a line right of
    its siblings. */
function renderIndented(raw: string, state: RenderState, rail: Rail): void {
  const indent = raw.length - raw.trimStart().length;
  const rest = raw.slice(indent);
  const keep = " ".repeat(Math.max(0, indent - state.absorb));
  if (indent === 0) state.absorb = 0;
  if (CTA.test(rest)) {
    const cta = rest.replace(CTA_ALL, (match) => bold(rail.accent(match.replaceAll("`", ""))));
    rail.body(`${keep}${bold(rail.accent("→"))} ${cta}`);
    return;
  }
  rail.body(`${keep}${rest}`);
}

/** The 64-dash paste frame becomes a ◇ section on the rail. */
function renderPaste(raw: string, state: RenderState, rail: Rail): void {
  const open = state.paste;
  if (raw === PASTE_RULE) {
    if (open === null) state.paste = { count: 0, why: "", titled: false };
    else {
      if (open.why !== "") rail.body(dim(open.why));
      state.paste = null;
    }
    return;
  }
  const head = PASTE_HEAD.exec(raw);
  if (head !== null) {
    state.paste = { count: head[1] === "ONE" ? 1 : Number(head[1]), why: head[2]!, titled: false };
    return;
  }
  const file = open === null ? null : PASTE_FILE.exec(raw);
  if (file !== null && open !== null) {
    if (open.titled) rail.bar();
    else {
      open.titled = true;
      rail.section(rail.accent("◇"), bold(open.count === 1 ? `One paste left — ${file[1]}` : `${open.count} pastes left`));
      if (open.count === 1) return;
    }
    rail.body(bold(file[1]!));
    return;
  }
  const wrap = MOUNT_WRAP.exec(raw.trimStart());
  if (wrap !== null) {
    // The snippet's own indent, with the docs pointer under the JSX it explains.
    const keep = " ".repeat(Math.max(0, raw.length - raw.trimStart().length - state.absorb));
    rail.bar();
    rail.body(`${keep}${wrap[1]!}`);
    rail.body(`${keep}  ${dim("…")}`);
    rail.body(`${keep}</VendoProvider>`);
    rail.body(`${keep}${dim(MOUNT_DOCS)}`);
    return;
  }
  renderIndented(raw, state, rail);
}

function renderRaw(raw: string, state: RenderState, rail: Rail): void {
  if (raw === "") {
    flushCatalog(state, rail);
    flushJudgment(state, rail);
    flushImpact(state, rail);
    rail.bar();
    return;
  }
  if (state.paste !== null || raw === PASTE_RULE) {
    renderPaste(raw, state, rail);
    return;
  }
  if (raw.startsWith(IMPACT_LINE)) {
    flushCatalog(state, rail);
    flushJudgment(state, rail);
    state.impact.push(raw.slice(IMPACT_LINE.length));
    return;
  }
  flushImpact(state, rail);
  if (CATALOG_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
    flushJudgment(state, rail);
    state.catalog.push(raw);
    return;
  }
  flushCatalog(state, rail);
  const judged = JUDGMENT_HEAD.exec(raw);
  if (judged !== null) {
    state.judgment = { summary: judged[1]!, details: [] };
    return;
  }
  if (state.judgment !== null) {
    if (raw.startsWith("  ")) {
      state.judgment.details.push(raw);
      return;
    }
    flushJudgment(state, rail);
  }
  if (renderNamed(raw, rail)) return;
  renderIndented(raw, state, rail);
}

export interface PrettyOptions {
  /** The header command — `┌  vendo init`. */
  command?: string;
  write?: (chunk: string) => void;
  input?: SelectInput;
  promptOutput?: NodeJS.WritableStream & { isTTY?: boolean };
  /** The banner above the header — it arrives as an animation and settles. */
  banner?: boolean;
  env?: Record<string, string | undefined>;
  /** Terminal width to wrap to. Unset follows the real stdout, and an unknown
      width (a pipe, an injected test writer) never wraps. */
  columns?: number;
}

export function createPrettyOutput(options: PrettyOptions = {}): PrettyOutput {
  const {
    command = "vendo init",
    input = stdin as SelectInput,
    promptOutput = stdout,
    banner = true,
    env = process.env,
  } = options;
  // `write` is a mutable binding: once the arrival starts, it is swapped for a
  // row-counting wrapper so the paint loop knows how much content sits below
  // the animating art. Everything in this closure writes through it.
  let write = options.write ?? ((chunk: string): void => { stdout.write(chunk); });
  let headerPrinted = false;
  let lastWasBar = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  const state: RenderState = { absorb: 0, catalog: [], impact: [], judgment: null, paste: null };
  /** Same capability probe the banner uses, so the rail and the mark above it
      are the same purple on the same terminal. */
  const lilac = accentFor(env);

  /** True when this renderer draws on the real terminal. Only then does it
      follow stdout's width and answer the interrupt signal; an injected
      writer (tests, embedders) stays deterministic. */
  const ownsTerminal = options.write === undefined;
  /** Read per line, so a resize mid-run wraps to the new width. */
  const columns = (): number => {
    if (options.columns !== undefined) return options.columns;
    if (!ownsTerminal) return Number.POSITIVE_INFINITY;
    return stdout.columns ?? Number.POSITIVE_INFINITY;
  };
  /** One logical line — and the number of terminal ROWS it took, which is what
      a cursor-up redraw has to rewind. */
  const line = (text: string): number => {
    const rows = wrapRail(text, columns());
    for (const row of rows) write(`${row}\n`);
    lastWasBar = text === BAR;
    return rows.length;
  };
  const rail: Rail = {
    bar: (): void => {
      if (!lastWasBar) line(BAR);
    },
    body: (text: string, reopen = ""): void => {
      line(`${BAR}  ${styleInline(text, lilac, reopen)}`);
    },
    section: (marker: string, title: string): void => {
      rail.bar();
      line(`${marker}  ${title}`);
      state.absorb = 2;
    },
    accent: lilac,
  };
  /** The arrival, started at construction — so the frames play over the stack
      detection the run does before its first line, and cost nothing. The
      signal is the interrupt path only (cancel settles the mark); ordinary
      lines print below the art and let the wave finish. */
  const arrival = banner ? new AbortController() : null;
  /** Content rows printed below the art while the wave still plays — the art
      repaints in place above them each frame. Counted by wrapping the writer,
      which is the ONLY thing that models the cursor: everything in this closure
      writes through it, and the art's own paint (which saves and restores the
      cursor) is the one thing that does not. */
  const below = { rows: 0 };
  const rawWrite = write;
  let arrivalLive = arrival !== null;
  /** Column the cursor sits in, carried across chunks: a write that does not
      end in a newline leaves the next one mid-row. */
  let column = 0;
  /** ROWS a chunk moves the cursor down, which is NOT its newline count: a line
      wider than the window wraps onto rows of its own, and an art repaint that
      rewound by the newline count would land inside the content — the desync
      #1152 fixed for the rail, measured with the same `displayWidth`. */
  const rowsWritten = (chunk: string): number => {
    const limit = columns();
    let rows = 0;
    for (const token of chunk.split(SPLIT_CSI)) {
      if (token === "") continue;
      if (token === "\n") {
        rows += 1;
        column = 0;
        continue;
      }
      if (token === "\r") {
        column = 0;
        continue;
      }
      if (token.startsWith(ESC)) {
        // A cursor-up (the select's rewind, the scan's tick) gives rows back:
        // what gets repainted under it is counted again as it is written.
        const up = /^\[(\d*)A$/.exec(token.slice(1));
        if (up !== null) rows -= Math.max(1, Number(up[1] === "" ? "1" : up[1]));
        continue;
      }
      const width = displayWidth(token);
      if (width === 0) continue;
      if (!Number.isFinite(limit)) {
        column += width;
        continue;
      }
      rows += Math.floor((column + width - 1) / limit);
      column = (column + width - 1) % limit + 1;
    }
    return rows;
  };
  write = (chunk: string): void => {
    if (arrivalLive) below.rows += rowsWritten(chunk);
    rawWrite(chunk);
  };
  const arrived = arrival === null
    ? Promise.resolve()
    : playBanner(
      rawWrite,
      bannerFrames(BANNER_COMPACT, bannerColorMode(env), BANNER_CONCEPT),
      // 90ms/frame ≈ 1.3s wave — it no longer holds anything hostage: the
      // header, the scan and its checkmarks all land BELOW the art while it
      // plays, so a longer wave is spectacle over work, not before it.
      90,
      arrival.signal,
      below,
    ).finally(() => { arrivalLive = false; });
  const ensureHeader = (): void => {
    if (headerPrinted) return;
    headerPrinted = true;
    // The wave keeps playing ABOVE this — content builds below the art and
    // the paint loop clears over it each frame. Nothing aborts the arrival
    // anymore; it finishes on its own while the run talks.
    if (arrival !== null) {
      write(`\n${dim(BANNER_TAGLINE)}\n\n`);
    }
    line(`${dim("┌")}  ${bold(command)}`);
    line(BAR);
  };
  /** Nothing may be printed on top of a half-collapsed block. */
  const flush = (): void => {
    flushCatalog(state, rail);
    flushJudgment(state, rail);
    flushImpact(state, rail);
  };

  const clearFrame = (): void => {
    if (timer !== null) write(CLEAR_LINE);
  };
  const stopSpin = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    write(CLEAR_LINE);
  };
  /** Every prompt interrupts the transcript: settle what is buffered first. */
  const settle = (): void => {
    stopSpin();
    ensureHeader();
    flush();
  };
  /** Ctrl-C: give the cursor back and CLOSE the rail, so an interrupted run
      still ends in a `└` instead of a bare `^C` under an open block. The exit
      code is the caller's — this only draws. */
  const cancel = (): void => {
    stopSpin();
    // The one path that still cuts the wave: an interrupted run must not leave
    // a half-drawn mark in the scrollback, and abort() paints the settled frame
    // synchronously, before the `└ Cancelled` line lands under it.
    arrival?.abort();
    write(SHOW_CURSOR);
    ensureHeader();
    rail.bar();
    line(`${dim("└")}  ${yellow("Cancelled")}`);
  };
  if (ownsTerminal) {
    process.once("SIGINT", () => {
      cancel();
      process.exit(130);
    });
  }

  return {
    arrived,
    log(message) {
      clearFrame();
      ensureHeader();
      if (message.startsWith("\n")) {
        flush();
        rail.bar();
      }
      for (const raw of message.replace(/^\n+/, "").split("\n")) renderRaw(raw, state, rail);
    },
    error(message) {
      clearFrame();
      ensureHeader();
      flush();
      if (message.startsWith("\n")) rail.bar();
      for (const raw of message.replace(/^\n+/, "").split("\n")) {
        const warning = raw.match(/^\s*warning: (.*)$/);
        if (warning !== null) rail.body(yellow(`⚠ ${warning[1]!}`), REOPEN_YELLOW);
        else if (raw.startsWith("Vendo Cloud: ")) {
          rail.section(lilac("◆"), bold(lilac("Vendo Cloud")));
          rail.body(yellow(`⚠ ${raw.slice("Vendo Cloud: ".length)}`), REOPEN_YELLOW);
        } else rail.body(red(`✖ ${raw}`), REOPEN_RED);
      }
    },
    spin(label) {
      stopSpin();
      ensureHeader();
      flush();
      const draw = (): void => {
        frame = (frame + 1) % FRAMES.length;
        write(`${CLEAR_LINE}${lilac(FRAMES[frame]!)}  ${dim(label)}`);
      };
      timer = setInterval(draw, 80);
      timer.unref?.();
      draw();
    },
    stopSpin,
    block(title, lines, marker = "◆") {
      settle();
      rail.section(lilac(marker), bold(title));
      for (const text of lines) rail.body(text);
    },
    async confirm(question, defaultYes = false) {
      // usePrettyOutput gates on stdout only; a piped/closed stdin can still
      // reach here (vendo init < file). Never block readline on a non-TTY —
      // the default stands, mirroring the plain askYesNo guard.
      if (input.isTTY !== true) return defaultYes;
      settle();
      rail.section(lilac("◇"), bold(question));
      // SelectInput is the raw-key slice of the same real stream readline
      // needs; the default (stdin) satisfies both.
      const prompt = createInterface({
        input: input as unknown as NodeJS.ReadableStream,
        output: promptOutput,
      });
      try {
        const answer = (await prompt.question(
          `${BAR}  ${dim(defaultYes ? "Y/n" : "y/N")} ${dim("›")} `,
        )).trim().toLowerCase();
        const accepted = answer === "" ? defaultYes : ["y", "yes"].includes(answer);
        line(`${BAR}  ${lilac("●")} ${accepted ? "Yes" : "No"}`);
        return accepted;
      } finally {
        prompt.close();
      }
    },
    async text(question, hint, defaultValue) {
      // Same stdin guard as confirm: no keypress source → no question, and ""
      // is the skip the caller already has to handle.
      if (input.isTTY !== true) return "";
      settle();
      rail.section(lilac("◇"), bold(question));
      if (hint !== undefined) line(`${BAR}  ${dim(hint)}`);
      const prompt = createInterface({
        input: input as unknown as NodeJS.ReadableStream,
        output: promptOutput,
      });
      try {
        const typed = (await prompt.question(`${BAR}  ${dim("›")} `)).trim();
        const answer = typed === "" ? defaultValue ?? "" : typed;
        line(`${BAR}  ${lilac("●")} ${answer === "" ? dim("skipped") : answer}`);
        return answer;
      } finally {
        prompt.close();
      }
    },
    async secret(question, hint) {
      if (input.isTTY !== true) return "";
      settle();
      rail.section(lilac("◇"), bold(question));
      if (hint !== undefined) line(`${BAR}  ${dim(hint)}`);
      write(`${BAR}  ${dim("›")} `);
      // The echo goes to a sink, so the secret is never drawn; the receipt
      // below is the only trace it leaves.
      const prompt = createInterface({
        input: input as unknown as NodeJS.ReadableStream,
        output: MUTED,
        terminal: true,
      });
      try {
        const answer = (await prompt.question("")).trim();
        write("\n");
        line(`${BAR}  ${lilac("●")} ${dim(maskedReceipt(answer))}`);
        return answer;
      } finally {
        prompt.close();
      }
    },
    async select(question, options, defaultIndex = 0) {
      // Same stdin guard as confirm: no keypress source → the default option.
      if (input.isTTY !== true) return (options[defaultIndex] ?? options[0])!.value;
      settle();
      rail.section(lilac("◇"), bold(question));
      let index = defaultIndex;
      const optionLine = (option: SelectOption, at: number): string => {
        const marker = at === index ? lilac("●") : dim("○");
        const label = at === index ? option.label : dim(option.label);
        const hint = option.hint === undefined ? "" : ` ${dim(`(${option.hint})`)}`;
        return `${BAR}  ${marker} ${label}${hint}`;
      };
      // ROWS, not options: a wrapped option owns more than one terminal row,
      // and rewinding by the option COUNT redraws on top of the wrong rows.
      let drawn = 0;
      const draw = (): void => {
        drawn = 0;
        for (const [at, option] of options.entries()) drawn += line(optionLine(option, at));
      };
      draw();
      const rewind = (): void => { write(`${ESC}[${drawn}A${ESC}[0J`); };
      const redraw = (): void => {
        rewind();
        draw();
      };
      const chosen = await new Promise<number>((resolveChoice) => {
        const cleanup = (): void => {
          input.off("data", onData);
          input.setRawMode?.(false);
          input.pause?.();
        };
        // Raw input arrives as arbitrary chunks - a paste ("2\r"), fast
        // typing, or an escape sequence split across reads. Buffer and
        // consume COMPLETE key sequences, handling several keys per chunk;
        // an incomplete escape sequence waits for the next chunk.
        let pending = "";
        const move = (delta: number): void => {
          index = (index + options.length + delta) % options.length;
          redraw();
        };
        const onData = (chunk: Buffer | string): void => {
          pending += String(chunk);
          while (pending.length > 0) {
            // A full CSI (ESC [ ... final byte) or SS3 (ESC O A-D) sequence.
            const sequence = /^\u001b(?:\[[0-9;]*[@-~]|O[A-D])/.exec(pending)?.[0];
            if (sequence !== undefined) {
              pending = pending.slice(sequence.length);
              const final = sequence[sequence.length - 1]!;
              if (final === "A" || final === "D") move(-1);
              else if (final === "B" || final === "C") move(1);
              continue;
            }
            if (pending.startsWith(ESC)) {
              // A prefix of a sequence still in flight waits for more bytes;
              // any other escape is dropped.
              if (/^\u001b(?:\[[0-9;]*|O)?$/.test(pending)) return;
              pending = pending.slice(1);
              continue;
            }
            const key = pending[0]!;
            pending = pending.slice(1);
            if (key === "\u0003") { // Ctrl+C
              cleanup();
              rewind();
              cancel();
              process.exit(130);
            }
            if (key === "\r" || key === "\n") {
              cleanup();
              resolveChoice(index);
              return;
            }
            // Number keys pick directly (the arrows-free fallback).
            if (/^[1-9]$/.test(key) && Number(key) <= options.length) {
              index = Number(key) - 1;
              cleanup();
              resolveChoice(index);
              return;
            }
            // Other printable bytes are ignored.
          }
        };
        input.setRawMode?.(true);
        input.resume?.();
        input.on("data", onData);
      });
      // Collapse the option list to the chosen answer.
      rewind();
      line(`${BAR}  ${lilac("●")} ${options[chosen]!.label}`);
      return options[chosen]!.value;
    },
    done(durationMs, ok, stats) {
      settle();
      rail.bar();
      const seconds = `${(durationMs / 1000).toFixed(1)}s`;
      const tail = stats === undefined ? "" : ` ${dim(`— ${stats}`)}`;
      line(`${dim("└")}  ${ok ? green(`Done in ${seconds}`) : red(`Failed after ${seconds}`)}${tail}`);
      line(`   ${dim(STAR_FOOTER)}`);
    },
    async revealBlock(title, lines, options = {}) {
      const { stepMs = 120, beat } = options;
      const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const items = lines.map((entry) => (typeof entry === "string" ? { text: entry } : entry));
      // The scan builds BELOW the art while the wave still plays: header, then
      // per-fact spinner lines that flip to a green ✓ when "found". The facts
      // were computed before any of this — the beats are pacing that spends
      // the wave's time on the user's app, not on the logo. Each tick rewinds
      // the ROWS the last one took (a wrapped line is more than one) and erases
      // to the end of the screen; the writer counts the rewind, so the art's
      // repaint above stays exactly as far up as the content really reaches.
      const scanLine = async (label: string, ms: number, resolveTo?: string): Promise<void> => {
        let rows = line(`${BAR}  ${FRAMES[0]!} ${dim(label)}`);
        const rewind = (): void => { write(`${ESC}[${rows}A${ESC}[0J`); };
        const ticks = Math.max(1, Math.round(ms / 80));
        for (let i = 1; i <= ticks; i += 1) {
          await pause(80);
          rewind();
          rows = line(`${BAR}  ${lilac(FRAMES[i % FRAMES.length]!)} ${dim(label)}`);
        }
        rewind();
        if (resolveTo !== undefined) line(`${BAR}  ${green("✓")} ${resolveTo}`);
      };
      settle();
      rail.section(lilac("◆"), bold(title));
      if (beat !== undefined) await scanLine(beat, 380);
      for (const item of items) {
        if (item.beat !== undefined) await scanLine(item.beat, 480, item.text);
        else {
          await pause(stepMs);
          rail.body(`${green("✓")} ${item.text}`);
        }
      }
      await arrived;
    },
  };
}
