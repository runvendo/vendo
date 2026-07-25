import { describe, expect, it } from "vitest";
import type { CloudConfig, CloudConfigResult } from "./cloud-config.js";
import {
  CONFIG_SURFACES,
  isConfigSurface,
  selectConfigSurface,
} from "./config-surface.js";

// The per-surface resolution seam (cse lane 3): explicit programmatic value →
// local `.vendo/<name>` file → cloud PUBLISHED value for that key → unset. The
// file's EXISTENCE is the switch; one source of truth per surface, no
// bidirectional sync. Sync (the design-rules thunk resolves synchronously per
// generation), backed by the cloudConfig stale-while-revalidate snapshot.

function stubCloud(config: CloudConfigResult["config"], version: string | null = "rel_1"): CloudConfig {
  return {
    fetch: async () => ({ version, config }),
    snapshot: () => (config === null && version === null ? { version, config } : { version, config }),
  };
}

describe("selectConfigSurface", () => {
  it("explicit programmatic value wins over file and cloud", () => {
    const resolved = selectConfigSurface("design-rules.md", {
      explicit: "inline rules",
      readFile: () => "file rules",
      cloud: stubCloud({ "design-rules.md": "cloud rules" }),
    });
    expect(resolved).toEqual({ value: "inline rules", owner: "explicit" });
  });

  it("a blank/whitespace explicit value does not win (falls through)", () => {
    const resolved = selectConfigSurface("design-rules.md", {
      explicit: "   ",
      readFile: () => "file rules",
      cloud: undefined,
    });
    expect(resolved).toEqual({ value: "file rules", owner: "file" });
  });

  it("local file wins over cloud when present", () => {
    const resolved = selectConfigSurface("brief.md", {
      readFile: (name) => (name === "brief.md" ? "file brief" : undefined),
      cloud: stubCloud({ "brief.md": "cloud brief" }),
    });
    expect(resolved).toEqual({ value: "file brief", owner: "file" });
  });

  it("an EMPTY file still counts as file-owned (existence is the switch)", () => {
    const resolved = selectConfigSurface("brief.md", {
      readFile: () => "",
      cloud: stubCloud({ "brief.md": "cloud brief" }),
    });
    expect(resolved).toEqual({ value: "", owner: "file" });
  });

  it("falls through to the cloud published value for the key when no file", () => {
    const resolved = selectConfigSurface("theme.json", {
      readFile: () => undefined,
      cloud: stubCloud({ "theme.json": '{"accent":"#5B21B6"}' }),
    });
    expect(resolved).toEqual({ value: '{"accent":"#5B21B6"}', owner: "cloud" });
  });

  it("is unset when nothing resolves (no explicit, no file, cold/absent cloud)", () => {
    expect(selectConfigSurface("policy.json", { readFile: () => undefined, cloud: undefined }))
      .toEqual({ value: undefined, owner: "unset" });
    // Cloud present but the key not in the published doc.
    expect(selectConfigSurface("policy.json", { readFile: () => undefined, cloud: stubCloud({}) }))
      .toEqual({ value: undefined, owner: "unset" });
    // Cloud never published.
    expect(selectConfigSurface("policy.json", { readFile: () => undefined, cloud: stubCloud(null, null) }))
      .toEqual({ value: undefined, owner: "unset" });
  });

  it("reads the cloud value from the SYNC snapshot, not a blocking fetch", () => {
    let fetched = 0;
    const cloud: CloudConfig = {
      fetch: async () => { fetched += 1; return { version: "v", config: { "overrides.json": "{}" } }; },
      snapshot: () => ({ version: "v", config: { "overrides.json": "{}" } }),
    };
    const resolved = selectConfigSurface("overrides.json", { readFile: () => undefined, cloud });
    expect(resolved).toEqual({ value: "{}", owner: "cloud" });
    expect(fetched).toBe(0);
  });
});

describe("isConfigSurface", () => {
  it("recognizes the five known surfaces and rejects the rest", () => {
    for (const name of CONFIG_SURFACES) expect(isConfigSurface(name)).toBe(true);
    expect(isConfigSurface("tools.json")).toBe(false);
    expect(isConfigSurface("catalog.json")).toBe(false);
    expect(isConfigSurface("../secrets")).toBe(false);
  });
});
