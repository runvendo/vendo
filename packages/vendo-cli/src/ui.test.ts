import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUi } from "./ui.js";

function capture() {
  const lines: string[] = [];
  const sink = (chunk: string) => lines.push(chunk);
  return { lines, sink };
}

describe("createUi — plain mode (non-tty, no color)", () => {
  it("renders a header line, with and without detail", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.header("vendo init", "app-name");
    ui.header("vendo sync");
    expect(lines).toEqual(["vendo init · app-name\n", "vendo sync\n"]);
  });

  it("renders ok/warn/fail step lines with dim detail", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.step("ok", "wrote .vendo/theme.json");
    ui.step("warn", "theme partially matched", "5/7 slots");
    ui.step("fail", "route scan failed", "ENOENT");
    expect(lines).toEqual([
      "✓ wrote .vendo/theme.json\n",
      "! theme partially matched (5/7 slots)\n",
      "× route scan failed (ENOENT)\n",
    ]);
  });

  it("renders an indented warning line under a step", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.warn("3 routes skipped (dynamic segments)");
    expect(lines).toEqual(["  ! 3 routes skipped (dynamic segments)\n"]);
  });

  it("renders a next-steps block", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.nextSteps(["set ANTHROPIC_API_KEY in .env.local", "run `pnpm dev`"]);
    expect(lines).toEqual([
      "Next steps:\n",
      "  - set ANTHROPIC_API_KEY in .env.local\n",
      "  - run `pnpm dev`\n",
    ]);
  });

  it("writes nothing for an empty next-steps block", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.nextSteps([]);
    expect(lines).toEqual([]);
  });

  it("renders an error line plus one fix line", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false });
    ui.error("failed to scan routes: ENOENT", "check the project directory exists");
    expect(lines).toEqual([
      "× failed to scan routes: ENOENT\n",
      "  fix: check the project directory exists\n",
    ]);
  });
});

describe("createUi — spinner degrade path (non-interactive)", () => {
  it("prints a start line then a result line with elapsed time appended", () => {
    let t = 1000;
    const now = () => t;
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false, now });

    const spin = ui.spinner("scanning routes");
    expect(lines).toEqual(["… scanning routes\n"]);

    t += 2345;
    spin.stop("ok", "scanned routes");
    expect(lines).toEqual(["… scanning routes\n", "✓ scanned routes (2.3s)\n"]);
  });

  it("appends elapsed time alongside an existing detail", () => {
    let t = 0;
    const now = () => t;
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: false, colors: false, now });

    const spin = ui.spinner("thinking");
    t += 500;
    spin.stop("warn", "thinking done", "partial");
    expect(lines).toEqual(["… thinking\n", "! thinking done (partial, 0.5s)\n"]);
  });

  it("degrades even when tty is forced true, if colors are unavailable (NO_COLOR)", () => {
    vi.stubEnv("NO_COLOR", "1");
    let t = 1000;
    const now = () => t;
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: true, now });

    const spin = ui.spinner("scanning");
    t += 1200;
    spin.stop("ok", "scanned");
    expect(lines).toEqual(["… scanning\n", "✓ scanned (1.2s)\n"]);
  });
});

describe("createUi — NO_COLOR handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("auto-detects colors off when NO_COLOR is set, even if tty is forced on", () => {
    vi.stubEnv("NO_COLOR", "1");
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: true });
    ui.step("ok", "wrote file");
    ui.header("vendo init", "app-name");
    expect(lines).toEqual(["✓ wrote file\n", "vendo init · app-name\n"]);
  });

  it("an explicit colors override still wins over NO_COLOR", () => {
    vi.stubEnv("NO_COLOR", "1");
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: true, colors: true });
    ui.step("ok", "wrote file");
    expect(lines[0]).toContain("[");
  });
});

describe("createUi — interactive mode (tty + colors)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("colorizes header, step, warn, and error output", () => {
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: true, colors: true });
    ui.header("vendo init", "app-name");
    ui.step("ok", "wrote .vendo/theme.json");
    ui.warn("something to note");
    ui.error("boom", "try again");
    for (const line of lines) {
      expect(line).toContain("[");
    }
  });

  it("live-updates the spinner line and collapses it into a result line", () => {
    let t = 0;
    const now = () => t;
    const { lines, sink } = capture();
    const ui = createUi({ sink, tty: true, colors: true, now });

    const spin = ui.spinner("scanning routes");
    const framesBeforeStop = lines.length;
    expect(framesBeforeStop).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("scanning routes");
    expect(lines[0]!.endsWith("\n")).toBe(false);

    t += 300;
    vi.advanceTimersByTime(300);
    expect(lines.length).toBeGreaterThan(framesBeforeStop);

    t += 100;
    spin.stop("ok", "scanned routes");
    const last = lines[lines.length - 1]!;
    expect(last).toContain("scanned routes");
    expect(last).toContain("0.4s");
    expect(last.endsWith("\n")).toBe(true);
  });
});
