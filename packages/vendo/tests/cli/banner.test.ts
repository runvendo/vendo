import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BANNER_COMPACT,
  BANNER_CONCEPT,
  BANNER_LARGE,
  BANNER_TAGLINE,
  bannerColorMode,
  bannerFrames,
  playBanner,
  renderBanner,
  type BannerConcept,
} from "../../src/cli/banner.js";

const ESC = "\u001b";
const CONCEPTS: BannerConcept[] = ["assembly", "flow", "shimmer"];

afterEach(() => {
  vi.useRealTimers();
});

/** Drop SGR/cursor sequences so the art itself can be asserted. */
function stripAnsi(text: string): string {
  return text.split(ESC).map((chunk, index) => {
    if (index === 0) return chunk;
    return chunk.replace(/^\[[0-9;]*[A-Za-z]/, "");
  }).join("");
}

describe("banner art", () => {
  it("is the approved art: 12 rows × 72 columns compact, 25 × 44 large", () => {
    expect(BANNER_COMPACT).toHaveLength(12);
    expect([...new Set(BANNER_COMPACT.map((row) => row.length))]).toEqual([72]);
    expect(BANNER_LARGE).toHaveLength(25);
    expect([...new Set(BANNER_LARGE.map((row) => row.length))]).toEqual([44]);
    // Half-blocks, never figlet letters.
    expect(BANNER_COMPACT.join("")).toMatch(/[█▀▄]/);
    expect(BANNER_TAGLINE).toContain("docs.vendo.run");
  });

  it("the CLI plays the flow", () => {
    expect(BANNER_CONCEPT).toBe("flow");
  });

  it("colours the art without changing a single glyph", () => {
    for (const mode of ["truecolor", "ansi"] as const) {
      expect(stripAnsi(renderBanner(BANNER_COMPACT, mode))).toBe(BANNER_COMPACT.join("\n"));
      expect(stripAnsi(renderBanner(BANNER_LARGE, mode))).toBe(BANNER_LARGE.join("\n"));
    }
  });

  it("ramps brand purple → lilac across the columns in truecolor, and falls back to ANSI magenta", () => {
    // The large art inks both edges of the grid, so both ends of the ramp show.
    const truecolor = renderBanner(BANNER_LARGE, "truecolor");
    expect(truecolor).toContain(`${ESC}[38;2;108;59;255m`); // #6c3bff, column 0
    expect(truecolor).toContain(`${ESC}[38;2;167;139;250m`); // #a78bfa, last column

    const ansi = renderBanner(BANNER_COMPACT, "ansi");
    expect(ansi).not.toContain("38;2;");
    expect(ansi).toContain(`${ESC}[35m`);
    expect(ansi).toContain(`${ESC}[95m`);
  });
});

describe("bannerColorMode", () => {
  it.each([
    ["COLORTERM=truecolor", { COLORTERM: "truecolor" }, "truecolor"],
    ["COLORTERM=24bit", { COLORTERM: "24bit" }, "truecolor"],
    ["TERM says direct", { TERM: "xterm-direct" }, "truecolor"],
    ["plain xterm", { TERM: "xterm" }, "ansi"],
    ["256 colours only", { TERM: "xterm-256color" }, "ansi"],
    ["nothing declared", {}, "ansi"],
  ] as const)("%s → %s", (_name, env, expected) => {
    expect(bannerColorMode(env)).toBe(expected);
  });
});

describe("bannerFrames", () => {
  it.each(CONCEPTS)("%s: the last frame IS the settled frame", (concept) => {
    const frames = bannerFrames(BANNER_COMPACT, "truecolor", concept);
    expect(frames.at(-1)).toBe(renderBanner(BANNER_COMPACT, "truecolor"));
    // …and it is an arrival, not a still: something happens before it.
    expect(frames[0]).not.toBe(frames.at(-1));
    expect(frames.length).toBeGreaterThan(8);
  });

  it.each(CONCEPTS)("%s: every frame is the same height, so the cursor-up redraw lands", (concept) => {
    for (const frame of bannerFrames(BANNER_COMPACT, "ansi", concept)) {
      expect(frame.split("\n")).toHaveLength(BANNER_COMPACT.length);
    }
  });

  it("flow: the mark crystallizes behind a band moving left to right", () => {
    const frames = bannerFrames(BANNER_COMPACT, "ansi", "flow");
    const inked = (frame: string): number => stripAnsi(frame).replace(/[^█▀▄]/g, "").length;
    // More of the mark is drawn on every frame, and nothing ever moves: what
    // is drawn is exactly a left prefix of the settled art.
    let previous = -1;
    for (const frame of frames) {
      expect(inked(frame)).toBeGreaterThanOrEqual(previous);
      previous = inked(frame);
      stripAnsi(frame).split("\n").forEach((row, index) => {
        expect(row).toHaveLength(BANNER_COMPACT[index]!.length);
        expect(BANNER_COMPACT[index]!.startsWith(row.trimEnd())).toBe(true);
      });
    }
    expect(inked(frames.at(-1)!)).toBe(inked(renderBanner(BANNER_COMPACT, "ansi")));
  });

  it("assembly: the mark lands top-down", () => {
    const frames = bannerFrames(BANNER_COMPACT, "ansi", "assembly");
    const drawnRows = (frame: string): number =>
      stripAnsi(frame).split("\n").filter((row) => row.trim() !== "").length;
    expect(drawnRows(frames[0]!)).toBeLessThan(drawnRows(frames.at(-1)!));
    for (const [index, frame] of frames.entries()) {
      if (index === 0) continue;
      expect(drawnRows(frame)).toBeGreaterThanOrEqual(drawnRows(frames[index - 1]!));
    }
  });

  it("shimmer: the whole mark is there on frame one — a dropped frame costs nothing", () => {
    const frames = bannerFrames(BANNER_COMPACT, "ansi", "shimmer");
    expect(stripAnsi(frames[0]!)).toBe(BANNER_COMPACT.join("\n"));
    // Only the highlight moves: the band is bright white, and it is gone by
    // the settled frame.
    expect(frames[0]).toContain(`${ESC}[97m`);
    expect(frames.at(-1)).not.toContain(`${ESC}[97m`);
  });
});

/** One in-place frame repaint, exactly as playBanner writes it: save the
    cursor, rewind over the content below plus the art, paint, restore. */
function redraw(frame: string, below = 0): string {
  return `${ESC}7${ESC}[${BANNER_COMPACT.length + below}A`
    + `${frame.split("\n").map((row) => `${ESC}[2K${row}`).join("\n")}${ESC}8`;
}

describe("playBanner", () => {
  it("repaints in place, plays once, and ends on the settled frame", async () => {
    const chunks: string[] = [];
    const frames = bannerFrames(BANNER_COMPACT, "ansi", BANNER_CONCEPT);
    await playBanner((chunk) => { chunks.push(chunk); }, frames, 0);
    const written = chunks.join("");
    // Cursor-up over the block for every frame after the first — and no
    // alternate screen buffer, ever.
    expect(written.split(`${ESC}[${BANNER_COMPACT.length}A`)).toHaveLength(frames.length);
    expect(written).not.toContain("?1049h");
    // Every repaint is bracketed: the cursor ends where the caller left it, so
    // a run printing below the art is never moved by a frame.
    expect(written.split(`${ESC}7`)).toHaveLength(frames.length);
    expect(written.split(`${ESC}8`)).toHaveLength(frames.length);
    expect(written.endsWith(redraw(frames.at(-1)!))).toBe(true);

    // Played once: nothing is written after it resolves.
    const settled = chunks.length;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(chunks).toHaveLength(settled);
  });

  it("writes nothing when there are no frames", async () => {
    const chunks: string[] = [];
    await playBanner((chunk) => { chunks.push(chunk); }, [], 0);
    expect(chunks).toHaveLength(0);
  });

  it("an abort mid-arrival settles INSIDE abort(), then stops", async () => {
    const chunks: string[] = [];
    const frames = bannerFrames(BANNER_COMPACT, "ansi", BANNER_CONCEPT);
    const arrival = new AbortController();
    const played = playBanner((chunk) => { chunks.push(chunk); }, frames, 5, arrival.signal);
    expect(chunks.join("")).toBe(`${frames[0]!}\n`);

    arrival.abort();
    // Synchronously, before abort() returned: an interrupted run leaves the
    // FINISHED mark on screen, never a half-drawn one.
    expect(chunks.join("")).toBe(`${frames[0]!}\n${redraw(frames.at(-1)!)}`);

    const settled = chunks.length;
    await played;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(chunks).toHaveLength(settled);
  });

  it("below mode: every frame rewinds over the caller's content as it grows", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const frames = bannerFrames(BANNER_COMPACT, "ansi", BANNER_CONCEPT);
    // The caller prints two more rows between every frame, exactly as a run
    // that keeps talking under the wave does.
    const below = { rows: 0 };
    const played = playBanner((chunk) => { chunks.push(chunk); }, frames, 10, undefined, below);
    const growth: number[] = [];
    for (let at = 1; at < frames.length; at += 1) {
      below.rows += 2;
      growth.push(below.rows);
      await vi.advanceTimersByTimeAsync(10);
    }
    await played;

    // One rewind per frame after the first, each over art + the content that
    // existed when it painted — the arithmetic the art depends on.
    const offsets = [...chunks.join("").matchAll(new RegExp(`${ESC}7${ESC}\\[(\\d+)A`, "g"))]
      .map((match) => Number(match[1]));
    expect(offsets).toEqual(growth.map((rows) => BANNER_COMPACT.length + rows));
    // And the paint still ends on the settled frame, still bracketed.
    expect(chunks.join("").endsWith(redraw(frames.at(-1)!, below.rows))).toBe(true);
  });

  it("below mode: an abort settles the mark above the content, not over it", () => {
    const chunks: string[] = [];
    const frames = bannerFrames(BANNER_COMPACT, "ansi", BANNER_CONCEPT);
    const arrival = new AbortController();
    const below = { rows: 5 };
    void playBanner((chunk) => { chunks.push(chunk); }, frames, 5, arrival.signal, below);
    arrival.abort();
    expect(chunks.join("")).toBe(`${frames[0]!}\n${redraw(frames.at(-1)!, 5)}`);
  });

  it("an abort after it already settled redraws nothing", async () => {
    const chunks: string[] = [];
    const frames = bannerFrames(BANNER_COMPACT, "ansi", BANNER_CONCEPT);
    const arrival = new AbortController();
    await playBanner((chunk) => { chunks.push(chunk); }, frames, 0, arrival.signal);
    const settled = chunks.join("");
    arrival.abort();
    expect(chunks.join("")).toBe(settled);
  });
});
