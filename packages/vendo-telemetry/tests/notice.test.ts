import { describe, it, expect, vi } from "vitest";
import { envOptOut } from "../src/consent.js";
import { maybeShowNotice } from "../src/notice.js";

describe("maybeShowNotice", () => {
  it("advertises only opt-outs this package actually honors", () => {
    const log = vi.fn();
    maybeShowNotice({ anonymousId: "x", optedOut: false, noticeShown: false }, { log, save: vi.fn() });
    const notice = log.mock.calls[0]![0] as string;

    const named = [...notice.matchAll(/\b([A-Z][A-Z_]+)=1\b/g)].map(([, name]) => name!);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(envOptOut({ [name]: "1" })).toBe(true);

    // This package deliberately depends on no @vendoai package, so it can never
    // check that a `vendo …` command exists. Naming one is how the notice came
    // to advertise `vendo telemetry disable`, which the CLI has never had.
    expect(notice).not.toMatch(/`vendo /);
  });

  it("prints once and marks the config", () => {
    const log = vi.fn();
    const save = vi.fn();
    const shown = maybeShowNotice(
      { anonymousId: "x", optedOut: false, noticeShown: false },
      { log, save },
    );
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain("TELEMETRY.md");
    expect(save).toHaveBeenCalledOnce();
    expect(shown.noticeShown).toBe(true);
  });

  it("does nothing when already shown", () => {
    const log = vi.fn();
    const save = vi.fn();
    maybeShowNotice({ anonymousId: "x", optedOut: false, noticeShown: true }, { log, save });
    expect(log).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does nothing when opted out", () => {
    const log = vi.fn();
    const save = vi.fn();
    maybeShowNotice({ anonymousId: "x", optedOut: true, noticeShown: false }, { log, save });
    expect(log).not.toHaveBeenCalled();
  });
});
