import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Output } from "./shared.js";

/**
 * The vendo CLI's TTY visual system (init first; doctor/sync can adopt the
 * same primitives later). Clack-style vertical-bar layout: one `┌ vendo init`
 * header, `◇`/`◆` section markers on a dim `│` rail, colored diff markers,
 * a dots spinner for the slow phases, and ONE deliberately emphasized block —
 * Vendo Cloud — in the brand accent (blue/cyan family, calm not neon).
 *
 * Degradation contract: this module is only selected when stdout is a real
 * TTY and none of NO_COLOR / CI / TERM=dumb opt out (see usePrettyOutput).
 * Every other run — tests, pipes, CI — keeps today's exact plain strings,
 * because runInit's emissions are unchanged: this is a renderer over the
 * existing Output seam, not a second copy of the copy.
 */

const ESC = "\u001b";
const style = (open: string, close: string) => (text: string): string =>
  `${ESC}[${open}m${text}${ESC}[${close}m`;

export const bold = style("1", "22");
export const dim = style("2", "22");
export const red = style("31", "39");
export const green = style("32", "39");
export const yellow = style("33", "39");
export const blue = style("34", "39");
export const cyan = style("36", "39");
export const brightCyan = style("96", "39");

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
  /** Dots spinner for a slow phase; any log/error line clears the frame. */
  spin(label: string): void;
  stopSpin(): void;
  /** The styled [Y/n] confirm — Enter accepts the default, answer echoed. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** The styled select — arrows move, Enter accepts, number keys pick
      directly; collapses to the chosen answer. Number keys cover options
      1-9 only: keep lists at nine options or fewer (a longer list stays
      arrow-navigable, but two-digit entry is deliberately not built). */
  select(question: string, options: SelectOption[], defaultIndex?: number): Promise<string>;
  /** The `└ Done in Xs` footer (red `Failed` when init exits non-zero). */
  done(durationMs: number, ok: boolean): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR = dim("│");
const CLEAR_LINE = `\r${ESC}[2K`;

/** Inline `code spans` in the calm command color. */
function styleInline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_match, code: string) => bold(cyan(code)));
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

export function createPrettyOutput(
  write: (chunk: string) => void = (chunk) => { stdout.write(chunk); },
  input: SelectInput = stdin,
  promptOutput: NodeJS.WritableStream & { isTTY?: boolean } = stdout,
): PrettyOutput {
  let headerPrinted = false;
  let lastWasBar = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  const line = (text: string): void => {
    write(`${text}\n`);
    lastWasBar = text === BAR;
  };
  const bar = (): void => {
    if (!lastWasBar) line(BAR);
  };
  const ensureHeader = (): void => {
    if (headerPrinted) return;
    headerPrinted = true;
    line(`${dim("┌")}  ${bold("vendo init")}`);
    line(BAR);
  };
  const body = (text: string): void => line(`${BAR}  ${styleInline(text)}`);
  const section = (marker: string, title: string): void => {
    bar();
    line(`${marker}  ${title}`);
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

  /** The emphasized block: brand-blue header + ✦ bullets. */
  const cloudHeader = (): void => section(blue("◆"), bold(blue("Vendo Cloud")));
  const cloudBullet = (text: string): void => body(`${blue("✦")} ${blue(text)}`);

  const render = (raw: string): void => {
    if (raw === "") {
      bar();
      return;
    }
    const wired = raw.match(/^(Wired \(\d+ files?\)):$/);
    if (wired !== null) {
      section(cyan("◆"), bold(wired[1]!));
      return;
    }
    if (raw === "Already wired — nothing to change.") {
      section(cyan("◇"), `${bold("Already wired")} — nothing to change`);
      return;
    }
    const marker = raw.match(/^ {2}([+~]) (.+)$/);
    if (marker !== null) {
      body(`${marker[1] === "+" ? green("+") : yellow("~")} ${dim(cyan(marker[2]!))}`);
      return;
    }
    const theme = raw.match(/^Theme: (.*)$/);
    if (theme !== null) {
      section(cyan("◇"), bold("Theme captured"));
      body(theme[1]!);
      return;
    }
    if (raw.startsWith("Theme lives in ")) {
      body(dim(raw));
      return;
    }
    const cloudAbsent = raw.match(/^Vendo Cloud \(optional\): not configured\. A key unlocks (.+)\.$/);
    if (cloudAbsent !== null) {
      cloudHeader();
      for (const bullet of cloudAbsent[1]!.split("; ")) cloudBullet(bullet);
      return;
    }
    const cloud = raw.match(/^Vendo Cloud: (.+)$/);
    if (cloud !== null) {
      cloudHeader();
      cloudBullet(cloud[1]!);
      return;
    }
    if (raw.includes("`vendo cloud login`") || raw.includes("vendo cloud login")) {
      // The CTA: bright, factual, pointing at the free dev-mode key.
      body(`${bold(brightCyan("→"))} ${raw.replace(/`?vendo cloud login`?/g, bold(brightCyan("vendo cloud login")))}`);
      return;
    }
    if (raw === "Last steps are yours:") {
      section(cyan("◇"), bold("Last steps are yours"));
      return;
    }
    // Generic indented detail (paste steps, progress lines): the plain
    // two-space indent becomes the rail; deeper nesting is preserved.
    const indented = raw.match(/^ {2}(.*)$/);
    if (indented !== null) {
      body(indented[1]!);
      return;
    }
    body(raw);
  };

  return {
    log(message) {
      clearFrame();
      ensureHeader();
      if (message.startsWith("\n")) bar();
      for (const raw of message.replace(/^\n+/, "").split("\n")) render(raw);
    },
    error(message) {
      clearFrame();
      ensureHeader();
      if (message.startsWith("\n")) bar();
      for (const raw of message.replace(/^\n+/, "").split("\n")) {
        const warning = raw.match(/^\s*warning: (.*)$/);
        if (warning !== null) body(yellow(`⚠ ${warning[1]!}`));
        else if (raw.startsWith("Vendo Cloud: ")) {
          cloudHeader();
          body(yellow(`⚠ ${raw.slice("Vendo Cloud: ".length)}`));
        } else body(red(`✖ ${raw}`));
      }
    },
    spin(label) {
      stopSpin();
      ensureHeader();
      const draw = (): void => {
        frame = (frame + 1) % FRAMES.length;
        write(`${CLEAR_LINE}${cyan(FRAMES[frame]!)}  ${dim(label)}`);
      };
      timer = setInterval(draw, 80);
      timer.unref?.();
      draw();
    },
    stopSpin,
    async confirm(question, defaultYes = false) {
      // usePrettyOutput gates on stdout only; a piped/closed stdin can still
      // reach here (vendo init < file). Never block readline on a non-TTY —
      // the default stands, mirroring the plain askYesNo guard.
      if (input.isTTY !== true) return defaultYes;
      stopSpin();
      ensureHeader();
      section(cyan("◇"), bold(question));
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
        line(`${BAR}  ${cyan("●")} ${accepted ? "Yes" : "No"}`);
        return accepted;
      } finally {
        prompt.close();
      }
    },
    async select(question, options, defaultIndex = 0) {
      // Same stdin guard as confirm: no keypress source → the default option.
      if (input.isTTY !== true) return (options[defaultIndex] ?? options[0])!.value;
      stopSpin();
      ensureHeader();
      section(cyan("◇"), bold(question));
      let index = defaultIndex;
      const optionLine = (option: SelectOption, at: number): string => {
        const marker = at === index ? cyan("●") : dim("○");
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
      line(`${BAR}  ${cyan("●")} ${options[chosen]!.label}`);
      return options[chosen]!.value;
    },
    done(durationMs, ok) {
      stopSpin();
      ensureHeader();
      bar();
      const seconds = `${(durationMs / 1000).toFixed(1)}s`;
      line(`${dim("└")}  ${ok ? green(`Done in ${seconds}`) : red(`Failed after ${seconds}`)}`);
    },
  };
}
