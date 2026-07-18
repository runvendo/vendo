// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { hasSeen, markSeen } from "../../src/chrome/discoverability.js";

describe("discoverability fire-once store", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("reports unseen before marking, seen after, persisting across simulated reloads", () => {
    expect(hasSeen("whisper")).toBe(false);
    markSeen("whisper");
    expect(hasSeen("whisper")).toBe(true);
    // A reload keeps localStorage but resets all module/react state — the
    // stored flag alone must carry the fire-once rule.
    expect(hasSeen("whisper")).toBe(true);
  });

  it("namespaces flags under vendo-prefixed keys, independently per element", () => {
    markSeen("whisper");
    expect(hasSeen("greeting")).toBe(false);
    const keys = Object.keys(window.localStorage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^vendo:/);
    expect(keys[0]).toContain("whisper");
  });

  it("treats an unavailable storage as already-seen and never throws", () => {
    // Some embeds (sandboxed iframes, blocked third-party storage) throw on
    // the localStorage ACCESS itself — degraded environments must never nag.
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("denied"); },
    });
    try {
      expect(hasSeen("whisper")).toBe(true);
      expect(() => markSeen("whisper")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", descriptor!);
    }
  });

  it("treats a storage that throws on read/write as already-seen and never throws", () => {
    // Quota-full / partitioned storage: the object exists but operations fail.
    const broken = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("quota"); },
    };
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, value: broken });
    try {
      expect(hasSeen("whisper")).toBe(true);
      expect(() => markSeen("whisper")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", descriptor!);
    }
  });
});
