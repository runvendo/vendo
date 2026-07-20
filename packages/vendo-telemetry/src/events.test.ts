import { describe, it, expect } from "vitest";
import { EVENT_ALLOWLIST, type EventName } from "./events.js";

describe("event allowlist", () => {
  it("lists every event with an explicit allowed-key set", () => {
    const names: EventName[] = [
      "init_started",
      "init_completed",
      "init_failed",
      "doctor_run",
      "agent_run",
      "error_class",
    ];
    for (const name of names) {
      expect(EVENT_ALLOWLIST[name]).toBeInstanceOf(Set);
    }
  });

  it("never allows a content-shaped key on any event", () => {
    const banned = ["sourceCode", "prompt", "filePath", "apiKey", "hostAppName", "body"];
    for (const name of Object.keys(EVENT_ALLOWLIST) as EventName[]) {
      for (const key of banned) {
        expect(EVENT_ALLOWLIST[name].has(key)).toBe(false);
      }
    }
  });
});
