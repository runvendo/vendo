import { describe, it, expect, vi } from "vitest";
import { maybeShowNotice } from "./notice.js";

describe("maybeShowNotice", () => {
  it("prints once and marks the config", () => {
    const log = vi.fn();
    const save = vi.fn();
    const shown = maybeShowNotice(
      { anonymousId: "x", optedOut: false, noticeShown: false },
      { log, save },
    );
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("TELEMETRY.md");
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
