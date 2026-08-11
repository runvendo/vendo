import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger, log, setLogger } from "../src/log.js";

// The migration these tests protect is mechanical:
//   console.error("[vendo] x:", err)
//     → log({ code, level: "error", message: "[vendo] x:", data: { err } })
// so the default sink's output must be byte-identical to the bare console line
// it replaces — same method, same argument list, argument for argument.

const spies = () => ({
  debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogger(undefined);
});

describe("the default sink", () => {
  it("routes each level to the console method its bare call used", () => {
    const cases = [
      { level: "debug", method: "debug" },
      { level: "info", method: "log" },
      { level: "warn", method: "warn" },
      { level: "error", method: "error" },
    ] as const;
    for (const { level, method } of cases) {
      const console_ = spies();
      log({ code: "core.log", level, message: "[vendo] plain" });
      expect(console_[method].mock.calls).toEqual([["[vendo] plain"]]);
      for (const other of ["debug", "log", "warn", "error"] as const) {
        if (other !== method) expect(console_[other]).not.toHaveBeenCalled();
      }
      vi.restoreAllMocks();
    }
  });

  it("reproduces `console.error(\"[vendo] x:\", err)` argument for argument", () => {
    const console_ = spies();
    const err = new Error("boom");
    log({ code: "core.log", level: "error", message: "[vendo] x:", data: { err } });
    expect(console_.error.mock.calls).toEqual([["[vendo] x:", err]]);
  });

  it("keeps data key insertion order as the original argument order", () => {
    const console_ = spies();
    const err = new Error("boom");
    log({
      code: "core.log",
      level: "warn",
      message: "[vendo] three:",
      data: { path: "app.vendo", count: 2, err },
    });
    expect(console_.warn.mock.calls).toEqual([["[vendo] three:", "app.vendo", 2, err]]);
  });
});

describe("the sink slot", () => {
  it("routes events to an installed logger and prints nothing", () => {
    const console_ = spies();
    const seen: unknown[] = [];
    setLogger((event) => seen.push(event));
    log({ code: "core.log", level: "error", message: "[vendo] x:", data: { err: "e" } });
    expect(seen).toEqual([
      { code: "core.log", level: "error", message: "[vendo] x:", data: { err: "e" } },
    ]);
    for (const method of ["debug", "log", "warn", "error"] as const) {
      expect(console_[method]).not.toHaveBeenCalled();
    }
  });

  it("restores the console sink when cleared", () => {
    const console_ = spies();
    setLogger(() => {});
    setLogger(undefined);
    log({ code: "core.log", level: "info", message: "[vendo] back" });
    expect(console_.log.mock.calls).toEqual([["[vendo] back"]]);
  });

  it("exports the default sink itself, which writes the same line", () => {
    const console_ = spies();
    consoleLogger({ code: "core.log", level: "info", message: "[vendo] direct", data: { a: 1 } });
    expect(console_.log.mock.calls).toEqual([["[vendo] direct", 1]]);
  });
});
