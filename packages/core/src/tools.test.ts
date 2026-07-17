import { describe, expect, it } from "vitest";
import { TOOL_NAME_PATTERN, VENDO_APPS_CREATE_TOOL, VENDO_APPS_TOOL_PREFIX } from "./index.js";

describe("§4 — the app runtime's reserved agent-tool namespace (AGENT-4)", () => {
  it("pins the vendo_apps_ prefix every view-capable tool name lives under", () => {
    expect(VENDO_APPS_TOOL_PREFIX).toBe("vendo_apps_");
  });

  it("pins the create tool name (the streaming-view bridge target) under the prefix", () => {
    expect(VENDO_APPS_CREATE_TOOL).toBe("vendo_apps_create");
    expect(VENDO_APPS_CREATE_TOOL.startsWith(VENDO_APPS_TOOL_PREFIX)).toBe(true);
  });

  it("prefixed names remain provider-safe tool names", () => {
    expect(TOOL_NAME_PATTERN.test(`${VENDO_APPS_TOOL_PREFIX}open`)).toBe(true);
  });
});
