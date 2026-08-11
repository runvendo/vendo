import { describe, expect, it } from "vitest";
import { vendoStyle } from "../src/style.js";

const ESC = "\u001b";
const TTY = { isTTY: true };

describe("vendoStyle().pretty (the one degradation law)", () => {
  it("says yes to a real TTY with nothing opting out", () => {
    expect(vendoStyle(TTY, {}).pretty).toBe(true);
  });

  it("says no to anything that is not a TTY", () => {
    expect(vendoStyle({}, {}).pretty).toBe(false);
    expect(vendoStyle({ isTTY: false }, {}).pretty).toBe(false);
  });

  it("says no when NO_COLOR, CI or TERM=dumb opts out", () => {
    for (const env of [{ NO_COLOR: "1" }, { CI: "true" }, { TERM: "dumb" }]) {
      expect(vendoStyle(TTY, env).pretty).toBe(false);
    }
  });

  // The convention the CLI has always used: a shell that exports the variable
  // empty has not asked for anything.
  it("treats an empty NO_COLOR or CI as absent", () => {
    expect(vendoStyle(TTY, { NO_COLOR: "", CI: "" }).pretty).toBe(true);
  });

  it("costs a non-TTY nothing: TERM=dumb and no TTY are both no", () => {
    expect(vendoStyle({}, { TERM: "dumb" }).pretty).toBe(false);
  });
});

describe("the palette", () => {
  const style = vendoStyle(TTY, {});

  it("wraps text in the SGR pair each meaning has always used", () => {
    expect(style.bold("x")).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(style.dim("x")).toBe(`${ESC}[2mx${ESC}[22m`);
    expect(style.ok("x")).toBe(`${ESC}[32mx${ESC}[39m`);
    expect(style.warn("x")).toBe(`${ESC}[33mx${ESC}[39m`);
    expect(style.bad("x")).toBe(`${ESC}[31mx${ESC}[39m`);
  });

  it("paints regardless of `pretty` — the gate is the caller's to ask", () => {
    // pretty.ts is only SELECTED for a terminal but is also constructed
    // directly by tests with an injected writer, and its output is pinned with
    // the escapes in it. A palette that went silent off-TTY would empty those.
    expect(vendoStyle({}, { CI: "1" }).bold("x")).toBe(`${ESC}[1mx${ESC}[22m`);
  });

  it("gives a truecolor terminal the real lilac and everything else magenta", () => {
    const hex = `${ESC}[38;2;167;139;250mx${ESC}[39m`;
    const magenta = `${ESC}[95mx${ESC}[39m`;
    expect(vendoStyle(TTY, { COLORTERM: "truecolor" }).accent("x")).toBe(hex);
    expect(vendoStyle(TTY, { COLORTERM: "24BIT" }).accent("x")).toBe(hex);
    expect(vendoStyle(TTY, { TERM: "xterm-direct" }).accent("x")).toBe(hex);
    expect(vendoStyle(TTY, {}).accent("x")).toBe(magenta);
    expect(vendoStyle(TTY, { TERM: "xterm-256color" }).accent("x")).toBe(magenta);
  });

  it("makes `code` the accent, emphasized", () => {
    const truecolor = vendoStyle(TTY, { COLORTERM: "truecolor" });
    expect(truecolor.code("vendo")).toBe(truecolor.bold(truecolor.accent("vendo")));
  });
});

describe("the defaults", () => {
  // A Worker has no `process`; the guarded read must answer, not throw.
  it("answers without a process, stdout or env", () => {
    const saved = (globalThis as { process?: unknown }).process;
    try {
      delete (globalThis as { process?: unknown }).process;
      expect(vendoStyle().pretty).toBe(false);
      expect(vendoStyle().accent("x")).toBe(`${ESC}[95mx${ESC}[39m`);
    } finally {
      (globalThis as { process?: unknown }).process = saved;
    }
  });
});
