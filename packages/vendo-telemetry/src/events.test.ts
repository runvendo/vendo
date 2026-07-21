import { describe, it, expect } from "vitest";
import { BASE_PROP_KEYS, CLOUD_PROP_KEYS, EVENT_ALLOWLIST, type EventName } from "./events.js";

describe("event allowlist", () => {
  it("permits every base prop key on every event", () => {
    expect([...BASE_PROP_KEYS]).toEqual([
      "vendoVersion",
      "osPlatform",
      "nodeVersion",
      "projectIdHash",
      "packageManager",
    ]);
    for (const name of Object.keys(EVENT_ALLOWLIST) as EventName[]) {
      for (const key of BASE_PROP_KEYS) {
        expect(EVENT_ALLOWLIST[name].has(key)).toBe(true);
      }
    }
  });

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

describe("cloud prop keys", () => {
  it("is exactly the documented closed set", () => {
    expect([...CLOUD_PROP_KEYS].sort()).toEqual(
      [
        "projectName",
        "errorDetail",
        "repoHost",
        "connectionsConfigured",
        "toolkitsEnabled",
        "servedApps",
        "experimentalFlags",
        "detectMs",
        "engineMs",
        "themeMs",
        "wiringMs",
        "componentsMs",
      ].sort(),
    );
  });

  it("never leaks a cloud-only key into an anonymous event allowlist", () => {
    for (const name of Object.keys(EVENT_ALLOWLIST) as EventName[]) {
      for (const key of CLOUD_PROP_KEYS) {
        expect(EVENT_ALLOWLIST[name].has(key)).toBe(false);
      }
    }
  });

  it("does not include the producer-set lane markers", () => {
    // `cloud` and `cloudKeyHash` are set by the client itself, never
    // accepted from callers — so they must not be in any allowed set.
    expect(CLOUD_PROP_KEYS.has("cloud")).toBe(false);
    expect(CLOUD_PROP_KEYS.has("cloudKeyHash")).toBe(false);
  });
});
