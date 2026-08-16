import { describe, expect, it } from "vitest";
import {
  CONFIG_SURFACES,
  isConfigSurface,
  selectConfigSurface,
} from "../src/config-surface.js";

// The per-surface resolution seam: a value passed in code → the local
// `.vendo/<name>` file → unset. The file's EXISTENCE is the switch; one source
// of truth per surface, no bidirectional sync and no remote layer. Sync — the
// design-rules thunk resolves synchronously per generation.

describe("selectConfigSurface", () => {
  it("explicit programmatic value wins over the file", () => {
    const resolved = selectConfigSurface("design-rules.md", {
      explicit: "inline rules",
      readFile: () => "file rules",
    });
    expect(resolved).toEqual({ value: "inline rules", owner: "explicit" });
  });

  it("a blank/whitespace explicit value does not win (falls through)", () => {
    const resolved = selectConfigSurface("design-rules.md", {
      explicit: "   ",
      readFile: () => "file rules",
    });
    expect(resolved).toEqual({ value: "file rules", owner: "file" });
  });

  it("an EMPTY file still counts as file-owned (existence is the switch)", () => {
    const resolved = selectConfigSurface("brief.md", { readFile: () => "" });
    expect(resolved).toEqual({ value: "", owner: "file" });
  });

  it("is unset when nothing resolves (no explicit value, no file)", () => {
    expect(selectConfigSurface("policy.json", { readFile: () => undefined }))
      .toEqual({ value: undefined, owner: "unset" });
  });

  it("re-reads the file each time, so an edit lands on the NEXT resolution", () => {
    // The design-rules thunk re-runs selectConfigSurface each generation, so an
    // edited file is observed without recomposing.
    let body = "v1 rules";
    const resolve = () => selectConfigSurface("design-rules.md", { readFile: () => body }).value;

    expect(resolve()).toBe("v1 rules");
    body = "v2 rules";
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
