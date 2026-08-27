import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendoLogEvent } from "../src/log.js";

/** The warn is once PER PROCESS, so each case that inspects it needs its own
 *  module instance — otherwise only the first test in the file ever sees one. */
async function freshModule() {
  vi.resetModules();
  const events: VendoLogEvent[] = [];
  const { setLogger } = await import("../src/log.js");
  setLogger((event) => events.push(event));
  const { consoleUrlFromEnv } = await import("../src/console-url.js");
  return { consoleUrlFromEnv, events };
}

afterEach(async () => {
  const { setLogger } = await import("../src/log.js");
  setLogger(undefined);
});

describe("consoleUrlFromEnv", () => {
  it("reads the current name", async () => {
    const { consoleUrlFromEnv } = await freshModule();
    expect(consoleUrlFromEnv({ VENDO_CONSOLE_URL: "https://console.example" }))
      .toBe("https://console.example");
  });

  /** The whole point of the rename: a deployment that already exports the old
   *  name keeps booting, unchanged. */
  it("still reads the retired VENDO_CLOUD_URL", async () => {
    const { consoleUrlFromEnv } = await freshModule();
    expect(consoleUrlFromEnv({ VENDO_CLOUD_URL: "https://old.example" }))
      .toBe("https://old.example");
  });

  it("lets the new name win when both are set", async () => {
    const { consoleUrlFromEnv } = await freshModule();
    expect(consoleUrlFromEnv({
      VENDO_CONSOLE_URL: "https://new.example",
      VENDO_CLOUD_URL: "https://old.example",
    })).toBe("https://new.example");
  });

  it("is undefined when neither is set, so callers keep their own default", async () => {
    const { consoleUrlFromEnv } = await freshModule();
    expect(consoleUrlFromEnv({})).toBeUndefined();
  });

  it("treats a blank value as unset", async () => {
    const { consoleUrlFromEnv } = await freshModule();
    expect(consoleUrlFromEnv({ VENDO_CONSOLE_URL: "   ", VENDO_CLOUD_URL: "https://old.example" }))
      .toBe("https://old.example");
    expect(consoleUrlFromEnv({ VENDO_CLOUD_URL: "" })).toBeUndefined();
  });

  it("points at the new name when the retired one is read", async () => {
    const { consoleUrlFromEnv, events } = await freshModule();
    consoleUrlFromEnv({ VENDO_CLOUD_URL: "https://old.example" });
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.message).toContain("VENDO_CLOUD_URL");
    expect(events[0]!.message).toContain("VENDO_CONSOLE_URL");
  });

  /** Several callers run per turn; a per-call warn would be a log flood. */
  it("warns once per process, not per read", async () => {
    const { consoleUrlFromEnv, events } = await freshModule();
    for (let i = 0; i < 5; i += 1) consoleUrlFromEnv({ VENDO_CLOUD_URL: "https://old.example" });
    expect(events).toHaveLength(1);
  });

  it("stays silent when the current name is used", async () => {
    const { consoleUrlFromEnv, events } = await freshModule();
    consoleUrlFromEnv({ VENDO_CONSOLE_URL: "https://new.example" });
    consoleUrlFromEnv({});
    expect(events).toEqual([]);
  });
});
