/**
 * Shared output renderer for every `vendo` command: header line, step lines
 * (ok/warn/fail), indented warning lines, a next-steps block, an error line
 * plus one fix line, and a spinner for long steps that collapses into a
 * result line with elapsed time.
 *
 * This module owns ALL environment detection (TTY, CI, NO_COLOR). Callers
 * never branch on TTY themselves — construct one `Ui` per command and call
 * its methods; in production, construct it with no options.
 *
 * TTY + color support → full styling and a live-updating spinner.
 * Non-TTY, CI, or NO_COLOR → plain sequential lines; the spinner degrades to
 * a start line followed by a result line (no in-place redraw).
 */
import pc from "picocolors";

export type StepMark = "ok" | "warn" | "fail";

export interface UiOptions {
  /** Injectable output sink. Defaults to `process.stdout.write`. */
  sink?: (chunk: string) => void;
  /** Override TTY detection (tests only; production callers pass nothing). */
  tty?: boolean;
  /** Override color-support detection (tests only). */
  colors?: boolean;
  /** Override the elapsed-time clock, in ms (tests only). */
  now?: () => number;
}

export interface SpinnerHandle {
  /** Stop the spinner and print the final step line; elapsed time is appended to `detail`. */
  stop(mark: StepMark, label: string, detail?: string): void;
}

export interface Ui {
  /** `vendo init · app-name` */
  header(command: string, detail?: string): void;
  /** `✓ wrote .vendo/theme.json` / `! partial match (5/7 slots)` / `× route scan failed (ENOENT)` */
  step(mark: StepMark, label: string, detail?: string): void;
  /** An indented warning line hanging under the preceding step. */
  warn(text: string): void;
  /** A raw line through the sink: no mark, no indent, no styling; multi-line text passed as-is. */
  note(text: string): void;
  /** A `Next steps:` block with one indented bullet per item. No-op if empty. */
  nextSteps(items: string[]): void;
  /** One error line plus one actionable fix line. */
  error(message: string, fix: string): void;
  /**
   * Starts a spinner for a long-running step.
   *
   * Caller contract: call `.stop(...)` in a try/finally so a throwing step
   * cannot leave the spinner drawing over subsequent output, and keep at
   * most one spinner active at a time (two live spinners fight over the same
   * line). `stop()` is idempotent, and the interval is unref'd so a leaked
   * spinner cannot keep the process alive.
   */
  spinner(label: string): SpinnerHandle;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
const CLEAR_LINE = "\r\x1b[K";

function markSymbol(mark: StepMark): string {
  return mark === "ok" ? "✓" : mark === "warn" ? "!" : "×";
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function joinDetail(detail: string | undefined, elapsed: string): string {
  return detail ? `${detail}, ${elapsed}` : elapsed;
}

export function createUi(options: UiOptions = {}): Ui {
  const sink = options.sink ?? ((chunk: string) => process.stdout.write(chunk));
  const now = options.now ?? (() => Date.now());

  const ciEnv = !!process.env.CI;
  const noColorEnv = !!process.env.NO_COLOR;
  const tty = options.tty ?? (!!process.stdout.isTTY && !ciEnv);
  const colors = options.colors ?? (tty && !noColorEnv);
  const interactive = tty && colors;

  // picocolors auto-detects color support from the real process env, which
  // would ignore our own `colors` decision (e.g. a forced `{ colors: true }`
  // override in a non-TTY test process). Force it explicitly instead.
  const pcolor = pc.createColors(colors);
  const c = {
    ok: pcolor.green,
    warn: pcolor.yellow,
    fail: pcolor.red,
    dim: pcolor.dim,
    bold: pcolor.bold,
    cyan: pcolor.cyan,
  };

  function markColor(mark: StepMark, s: string): string {
    return mark === "ok" ? c.ok(s) : mark === "warn" ? c.warn(s) : c.fail(s);
  }

  function write(line: string): void {
    sink(`${line}\n`);
  }

  function stepLine(mark: StepMark, label: string, detail?: string): string {
    const symbol = markColor(mark, markSymbol(mark));
    const detailPart = detail ? ` ${c.dim(`(${detail})`)}` : "";
    return `${symbol} ${label}${detailPart}`;
  }

  function header(command: string, detail?: string): void {
    const text = detail ? `${c.bold(command)} ${c.dim("·")} ${c.dim(detail)}` : c.bold(command);
    write(text);
  }

  function step(mark: StepMark, label: string, detail?: string): void {
    write(stepLine(mark, label, detail));
  }

  function warn(text: string): void {
    write(`  ${c.warn("!")} ${text}`);
  }

  function note(text: string): void {
    write(text);
  }

  function nextSteps(items: string[]): void {
    if (items.length === 0) return;
    write(c.bold("Next steps:"));
    for (const item of items) write(`  - ${item}`);
  }

  function error(message: string, fix: string): void {
    write(`${c.fail("×")} ${message}`);
    write(`  ${c.dim("fix:")} ${fix}`);
  }

  function spinner(label: string): SpinnerHandle {
    const start = now();
    let stopped = false;

    if (!interactive) {
      write(`… ${label}`);
      return {
        stop(mark, resultLabel, detail) {
          if (stopped) return;
          stopped = true;
          const elapsed = formatElapsed(now() - start);
          write(stepLine(mark, resultLabel, joinDetail(detail, elapsed)));
        },
      };
    }

    let frame = 0;
    const render = () => {
      const elapsed = formatElapsed(now() - start);
      const glyph = c.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!);
      sink(`${CLEAR_LINE}${glyph} ${label} ${c.dim(`(${elapsed})`)}`);
      frame++;
    };
    render();
    const timer = setInterval(render, SPINNER_INTERVAL_MS);
    // Never let a leaked spinner (caller threw before stop()) keep the
    // process alive on its own.
    timer.unref?.();

    return {
      stop(mark, resultLabel, detail) {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        sink(CLEAR_LINE);
        const elapsed = formatElapsed(now() - start);
        write(stepLine(mark, resultLabel, joinDetail(detail, elapsed)));
      },
    };
  }

  return { header, step, warn, note, nextSteps, error, spinner };
}
