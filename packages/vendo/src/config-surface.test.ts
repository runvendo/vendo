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
    snapshot: () => ({ version, config }),
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

describe("two-path resolution (cse lane 3 proof)", () => {
  // One host, one interface: surface A is file-owned, surface B is cloud-owned,
  // and both resolve correctly through the same seam. The cloud doc is shaped
  // exactly like the config-wire published fixture.
  const published = {
    "design-rules.md": "# Design rules\n\nUse the violet brand tokens; never invent new hues.",
    "brief.md": "Maple is a retail bank; the agent acts as the signed-in member.",
    "theme.json": '{"accent":"#5B21B6","radius":"12px"}',
    "policy.json": '{"toolBudget":20}',
    "overrides.json": "{}",
  };

  it("resolves an A-file-owned surface from disk and a B-cloud-owned surface from the published doc", () => {
    // Surface A (brief) lives on local disk; surface B (design-rules) does not,
    // so it falls through to the published cloud value.
    const readFile = (name: string): string | undefined =>
      name === "brief.md" ? "on-disk brief" : undefined;
    const cloud = stubCloud(published);

    expect(selectConfigSurface("brief.md", { readFile, cloud }))
      .toEqual({ value: "on-disk brief", owner: "file" });
    expect(selectConfigSurface("design-rules.md", { readFile, cloud }))
      .toEqual({ value: published["design-rules.md"], owner: "cloud" });
  });

  it("a published-version flip changes the cloud-owned surface on the NEXT resolution (no recomposition)", () => {
    // The design-rules thunk re-runs selectConfigSurface each generation, so a
    // snapshot whose backing doc flips is observed without recomposing.
    let doc: CloudConfigResult["config"] = { "design-rules.md": "v1 rules" };
    const cloud: CloudConfig = {
      fetch: async () => ({ version: "rel_1", config: doc }),
      snapshot: () => ({ version: "rel_1", config: doc }),
    };
    const resolve = () => selectConfigSurface("design-rules.md", { readFile: () => undefined, cloud }).value;

    expect(resolve()).toBe("v1 rules");
    doc = { "design-rules.md": "v2 rules" };
    expect(resolve()).toBe("v2 rules");
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
