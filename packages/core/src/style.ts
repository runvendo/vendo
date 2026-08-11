/**
 * The ONE ANSI palette Vendo paints with, and the one rule for whether it
 * paints at all.
 *
 * Two surfaces need it — the CLI's rail renderer (`cli/pretty.ts`) and the boot
 * summary `createVendo` prints — and core is the only package both may import:
 * a block may not import `@vendoai/vendo` (scripts/dependency-guard.mjs), so a
 * palette living in the umbrella could never be shared downward.
 *
 * The MARKERS (◆ ◇ │ ✓ ⚠ ✖) are deliberately not here. They are layout, not
 * colour: each call site owns the ones its own block draws.
 */

const ESC = "\u001b";
const sgr = (open: string, close: string) => (text: string): string =>
  `${ESC}[${open}m${text}${ESC}[${close}m`;

const bold = sgr("1", "22");
const dim = sgr("2", "22");
const ok = sgr("32", "39");
const warn = sgr("33", "39");
const bad = sgr("31", "39");
/** The accent — brand lilac, the colour the CLI banner's ramp ends on. A
    truecolor terminal gets the real `#a78bfa` so a rail matches the mark above
    it instead of sitting a shade off in ANSI magenta (#1166); everything else
    keeps bright magenta, which is what the fallback was always for. */
const lilacTruecolor = sgr("38;2;167;139;250", "39");
const lilacAnsi = sgr("95", "39");

export interface VendoStyle {
  /** Whether this run should be styled AT ALL: stdout is a real TTY and none of
      NO_COLOR / CI / TERM=dumb opts out. ASK THIS FIRST — the helpers below
      always paint, because the renderer that owns most of them is only ever
      selected for a terminal and has to paint identically under an injected
      test writer. A caller composing a styled block gates on `pretty` and
      emits plain text when it is false. */
  readonly pretty: boolean;
  bold(text: string): string;
  dim(text: string): string;
  /** Added, healthy, done. */
  ok(text: string): string;
  /** Changed, degraded, worth a second look. */
  warn(text: string): string;
  /** Broken. */
  bad(text: string): string;
  accent(text: string): string;
  /** An inline `code span`: the accent, emphasized. */
  code(text: string): string;
}

/** Worker targets have no `process`; the guarded read keeps them clean (the
    same shape `defaultFetch`'s neighbours in fetch.ts use). */
const globalProcess = (): {
  env?: Record<string, string | undefined>;
  stdout?: { isTTY?: boolean };
} | undefined =>
  (globalThis as {
    process?: { env?: Record<string, string | undefined>; stdout?: { isTTY?: boolean } };
  }).process;

/** TTY + no opt-outs. NO_COLOR and CI follow the "present and non-empty"
    convention, so `CI=` (a shell that exports it empty) is not an opt-out. */
function prettyRun(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): boolean {
  if (stream.isTTY !== true) return false;
  if ((env.NO_COLOR ?? "") !== "") return false;
  if ((env.CI ?? "") !== "") return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/** Truecolor capability, by the same two variables every terminal advertises it
    on — and the same test the CLI banner's ramp makes (`bannerColorMode`), so
    the rail and the mark above it are the same purple on the same terminal. */
const truecolor = (env: Record<string, string | undefined>): boolean => {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return true;
  return /truecolor|24bit|direct/i.test(env.TERM ?? "");
};

export function vendoStyle(
  stream: { isTTY?: boolean } = globalProcess()?.stdout ?? {},
  env: Record<string, string | undefined> = globalProcess()?.env ?? {},
): VendoStyle {
  const accent = truecolor(env) ? lilacTruecolor : lilacAnsi;
  return {
    pretty: prettyRun(stream, env),
    bold,
    dim,
    ok,
    warn,
    bad,
    accent,
    code: (text) => bold(accent(text)),
  };
}
