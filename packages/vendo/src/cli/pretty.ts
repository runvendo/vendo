import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { BANNER_COMPACT, BANNER_TAGLINE, bannerColorMode, renderBanner } from "./banner.js";
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
 * --agent plan's pinned JSON; every fact on screen is still the caller's.
 */

const ESC = "\u001b";
const style = (open: string, close: string) => (text: string): string =>
  `${ESC}[${open}m${text}${ESC}[${close}m`;

const bold = style("1", "22");
const dim = style("2", "22");
const red = style("31", "39");
const green = style("32", "39");
const yellow = style("33", "39");
/** The accent — brand lilac. Truecolor terminals get the real ramp in the
    banner; the rail's markers stay ANSI so they follow the user's theme. */
const lilac = style("95", "39");
/** Re-arm sequences for the two colors that can wrap a whole line. */
const REOPEN_YELLOW = `${ESC}[33m`;
const REOPEN_RED = `${ESC}[31m`;

/** TTY + no opt-outs → the pretty renderer; anything else keeps plain output.
    NO_COLOR and CI follow the "present and non-empty" convention. */
export function usePrettyOutput(
  stream: { isTTY?: boolean } = stdout,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (stream.isTTY !== true) return false;
  if ((env.NO_COLOR ?? "") !== "") return false;
  if ((env.CI ?? "") !== "") return false;
  if (env.TERM === "dumb") return false;
  return true;
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
  /** A free-text answer; Enter returns "" and the caller decides what a skip
      means. Non-TTY stdin never prompts — "" stands. */
  text(question: string, hint?: string): Promise<string>;
  /** A secret: the typing is not echoed and only a masked receipt reaches the
      transcript. The value itself is NEVER written to the terminal. */
  secret(question: string, hint?: string): Promise<string>;
  /** A pretty-only result block. It has no plain sibling on purpose: callers
      keep emitting their plain lines, and this restyles nothing — it is for
      blocks the pretty run composes itself. */
  block(title: string, lines: string[], marker?: "◆" | "◇"): void;
  /** The `└ Done in Xs` footer (red `Failed` when the command exits non-zero);
      `stats` is the dim tail that says what the run actually achieved, and a
      dim star line closes the run. */
  done(durationMs: number, ok: boolean, stats?: string): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR = dim("│");
const CLEAR_LINE = `\r${ESC}[2K`;
/** The star ask, demoted from an interactive question to a dim last line —
    pretty-only, so a piped or NO_COLOR run never sees it. */
const STAR_FOOTER = "Star us: vendo.run/star · docs.vendo.run";

/** The five always-printed catalog lines, collapsed into one block. */
const CATALOG_PREFIXES = ["tools: ", "tool schemas: ", "pins: ", "catalog.json: ", "components: "];
const CATALOG_COMPONENTS = "components: ";
const JUDGMENT_HEAD = /^judgment \(.+\): (.+)$/;
const JUDGMENT_QUEUED = "loosenings queued";
/** The paste block's ASCII frame — dropped; the block rides the rail instead. */
const PASTE_RULE = "─".repeat(64);
const PASTE_HEAD = /^(ONE|\d+) STEPS? LEFT — paste th(?:is|ese) yourself \((.+)\)$/;
const PASTE_FILE = /^ {2}File: (.+)$/;
/** The mount snippet elides the child expression, and it genuinely differs by
    router — `{children}` in an app-router layout, `<Component {...pageProps} />`
    in a pages `_app` — so the block owes the exact per-router wording. This
    pointer is the renderer's and not the caller's: init's `mount.lines` is
    pinned byte-for-byte by the --agent plan, and a line added there would
    change that JSON. Emitted here, the --agent path never sees it. */
const MOUNT_WRAP = "… then wrap: <VendoProvider";
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
function styleInline(text: string, reopen = ""): string {
  return text.replace(/`([^`]+)`/g, (_match, code: string) => `${bold(lilac(code))}${reopen}`);
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
    guard: a piped run never prompts and answers "". */
export async function plainText(
  question: string,
  hint?: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = stdout,
): Promise<string> {
  if (input.isTTY !== true || output.isTTY !== true) return "";
  output.write(`${question}\n`);
  if (hint !== undefined) output.write(`  ${hint}\n`);
  const prompt = createInterface({ input, output });
  try {
    return (await prompt.question("> ")).trim();
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

/** What the string rules below are allowed to draw on. */
interface Rail {
  bar(): void;
  body(text: string, reopen?: string): void;
  section(marker: string, title: string): void;
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
  rail.section(lilac("◆"), bold("Catalog"));
  const counts = lines.filter((entry) => !entry.startsWith(CATALOG_COMPONENTS));
  if (counts.length > 0) rail.body(counts.join(" · "));
  for (const entry of lines.filter((line) => line.startsWith(CATALOG_COMPONENTS))) rail.body(entry);
}

function flushImpact(state: RenderState, rail: Rail): void {
  if (state.impact.length === 0) return;
  const lines = state.impact;
  state.impact = [];
  rail.section(lilac("◇"), bold("Impact"));
  for (const entry of lines) {
    const breaks = IMPACT_BREAKS.exec(entry);
    rail.body(breaks === null ? entry : `${breaks[1]!}${bold(breaks[2]!)}`);
  }
}

function flushJudgment(state: RenderState, rail: Rail): void {
  if (state.judgment === null) return;
  const { summary, details } = state.judgment;
  state.judgment = null;
  rail.section(lilac("◆"), bold("Judgment"));
  const queued = details.filter((detail) => detail.includes(JUDGMENT_QUEUED));
  // Every detail line keeps its own count clause; the long name lists behind
  // the colon are what --json and `vendo sync` are for.
  const counted = details
    .filter((detail) => !detail.includes(JUDGMENT_QUEUED))
    .map((detail) => detail.trim().split(": ")[0]!);
  rail.body([summary, ...counted].join(" · "));
  for (const entry of queued) rail.body(entry.trim());
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
    rail.section(lilac("◆"), bold(wired[1]!));
    return true;
  }
  if (raw === "Already wired — nothing to change.") {
    rail.section(lilac("◇"), `${bold("Already wired")} — nothing to change`);
    return true;
  }
  const marker = DIFF_MARKER.exec(raw);
  if (marker !== null) {
    rail.body(`${marker[1] === "+" ? green("+") : yellow("~")} ${dim(lilac(marker[2]!))}`);
    return true;
  }
  const theme = THEME.exec(raw);
  if (theme !== null) {
    rail.section(lilac("◆"), bold("Your brand, captured"));
    rail.body(brandLine(theme[1]!));
    return true;
  }
  const syncTheme = SYNC_THEME.exec(raw);
  if (syncTheme !== null) {
    rail.section(lilac("◇"), bold("Theme"));
    rail.body(syncTheme[1]!);
    return true;
  }
  if (raw.startsWith("Theme lives in ")) {
    rail.body(dim(raw));
    return true;
  }
  if (raw === "Last steps are yours:") {
    rail.section(lilac("◇"), bold("Last steps are yours"));
    return true;
  }
  return renderCloud(raw, rail);
}

/** The one emphasized block: brand header + ✦ bullets + the → CTA. */
function renderCloud(raw: string, rail: Rail): boolean {
  const absent = CLOUD_ABSENT.exec(raw);
  if (absent !== null) {
    rail.section(lilac("◆"), bold(lilac("Vendo Cloud")));
    for (const bullet of absent[1]!.split("; ")) rail.body(`${lilac("✦")} ${lilac(bullet)}`);
    return true;
  }
  const present = CLOUD_PRESENT.exec(raw);
  if (present !== null) {
    rail.section(lilac("◆"), bold(lilac("Vendo Cloud")));
    rail.body(`${lilac("✦")} ${lilac(present[1]!)}`);
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
    const cta = rest.replace(CTA_ALL, (match) => bold(lilac(match.replaceAll("`", ""))));
    rail.body(`${keep}${bold(lilac("→"))} ${cta}`);
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
      rail.section(lilac("◇"), bold(open.count === 1 ? `One paste left — ${file[1]}` : `${open.count} pastes left`));
      if (open.count === 1) return;
    }
    rail.body(bold(file[1]!));
    return;
  }
  renderIndented(raw, state, rail);
  // Under the snippet it explains, at the snippet's own indent.
  if (raw.trimStart().startsWith(MOUNT_WRAP)) {
    const indent = raw.length - raw.trimStart().length;
    rail.body(`${" ".repeat(Math.max(0, indent - state.absorb))}${dim(MOUNT_DOCS)}`);
  }
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
  /** The settled banner above the header. */
  banner?: boolean;
  env?: Record<string, string | undefined>;
}

export function createPrettyOutput(options: PrettyOptions = {}): PrettyOutput {
  const {
    command = "vendo init",
    write = (chunk: string): void => { stdout.write(chunk); },
    input = stdin as SelectInput,
    promptOutput = stdout,
    banner = true,
    env = process.env,
  } = options;
  let headerPrinted = false;
  let lastWasBar = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  const state: RenderState = { absorb: 0, catalog: [], impact: [], judgment: null, paste: null };

  const line = (text: string): void => {
    write(`${text}\n`);
    lastWasBar = text === BAR;
  };
  const rail: Rail = {
    bar: (): void => {
      if (!lastWasBar) line(BAR);
    },
    body: (text: string, reopen = ""): void => line(`${BAR}  ${styleInline(text, reopen)}`),
    section: (marker: string, title: string): void => {
      rail.bar();
      line(`${marker}  ${title}`);
      state.absorb = 2;
    },
  };
  const ensureHeader = (): void => {
    if (headerPrinted) return;
    headerPrinted = true;
    if (banner) {
      write(`${renderBanner(BANNER_COMPACT, bannerColorMode(env))}\n\n${dim(BANNER_TAGLINE)}\n\n`);
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

  return {
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
    async text(question, hint) {
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
        const answer = (await prompt.question(`${BAR}  ${dim("›")} `)).trim();
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
      for (const [at, option] of options.entries()) line(optionLine(option, at));
      const redraw = (): void => {
        write(`${ESC}[${options.length}A`);
        for (const [at, option] of options.entries()) write(`${ESC}[2K${optionLine(option, at)}\n`);
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
              write("\n");
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
      write(`${ESC}[${options.length}A${ESC}[0J`);
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
  };
}
