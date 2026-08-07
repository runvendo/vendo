import { afterEach, describe, expect, it } from "vitest";
import {
  APP_BUILD_UI_DEADLINE_MS,
  BUILD_WATCHDOG_MS,
  effectiveAppBuildUiDeadlineMs,
  effectiveBuildWatchdogMs,
} from "./build-deadlines.js";

// speed-core lane — criterion 4: the UI polling cutoff and the server build
// watchdog derive from ONE shared constant, and the cutoff strictly exceeds
// the watchdog (so a watchdog-persisted failed record always lands BEFORE the
// client gives up and shows the generic deadline beat).

describe("build deadlines", () => {
  afterEach(() => {
    delete process.env["VENDO_APP_BUILD_WATCHDOG_MS"];
  });

  it("the UI cutoff strictly exceeds the watchdog and derives from it", () => {
    expect(BUILD_WATCHDOG_MS).toBe(4 * 60_000);
    expect(APP_BUILD_UI_DEADLINE_MS).toBeGreaterThan(BUILD_WATCHDOG_MS);
    expect(APP_BUILD_UI_DEADLINE_MS).toBe(BUILD_WATCHDOG_MS + 60_000);
  });

  it("the effective watchdog honors the VENDO_APP_BUILD_WATCHDOG_MS override", () => {
    expect(effectiveBuildWatchdogMs()).toBe(BUILD_WATCHDOG_MS);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "1234";
    expect(effectiveBuildWatchdogMs()).toBe(1234);
  });

  it("a garbage or non-positive override falls back to the constant", () => {
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "not-a-number";
    expect(effectiveBuildWatchdogMs()).toBe(BUILD_WATCHDOG_MS);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "0";
    expect(effectiveBuildWatchdogMs()).toBe(BUILD_WATCHDOG_MS);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "-5";
    expect(effectiveBuildWatchdogMs()).toBe(BUILD_WATCHDOG_MS);
  });

  it("the effective UI deadline tracks the effective watchdog and always strictly exceeds it", () => {
    expect(effectiveAppBuildUiDeadlineMs()).toBe(APP_BUILD_UI_DEADLINE_MS);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "5000";
    expect(effectiveAppBuildUiDeadlineMs()).toBe(5000 + 60_000);
    expect(effectiveAppBuildUiDeadlineMs()).toBeGreaterThan(effectiveBuildWatchdogMs());
  });
});
