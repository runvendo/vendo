import { describe, expect, it } from "vitest";
import {
  isVendoAppsTool,
  modelToolDescription,
  PRESENCE_ONLY_TOOLS,
  TOOL_NAME_PATTERN,
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_TOOL_PREFIX,
  VENDO_APPS_UNPIN_TOOL,
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
} from "./index.js";

describe("§4 — the app runtime's reserved agent-tool namespace (AGENT-4)", () => {
  it("pins the vendo_apps_ prefix every view-capable tool name lives under", () => {
    expect(VENDO_APPS_TOOL_PREFIX).toBe("vendo_apps_");
  });

  it("pins the make tool name (the streaming-view bridge target) OUTSIDE the prefix", () => {
    // The front door is deliberately not a member of the prefixed family, which
    // is exactly why the family's laws are stated as a predicate below and never
    // as a prefix test: `vendo_make` fails a prefix test.
    expect(VENDO_MAKE_TOOL).toBe("vendo_make");
    expect(VENDO_MAKE_TOOL.startsWith(VENDO_APPS_TOOL_PREFIX)).toBe(false);
  });

  it("prefixed names remain provider-safe tool names", () => {
    expect(TOOL_NAME_PATTERN.test(`${VENDO_APPS_TOOL_PREFIX}open`)).toBe(true);
    expect(TOOL_NAME_PATTERN.test(VENDO_MAKE_TOOL)).toBe(true);
  });
});

describe("isVendoAppsTool — one predicate for the app runtime's family", () => {
  it("covers the front door and the prefixed family alike", () => {
    expect(isVendoAppsTool(VENDO_MAKE_TOOL)).toBe(true);
    expect(isVendoAppsTool("vendo_apps_open")).toBe(true);
    expect(isVendoAppsTool(`${VENDO_APPS_TOOL_PREFIX}anything_later`)).toBe(true);
  });

  it("covers nothing else — a host lookalike stays outside the family (01 §16)", () => {
    // The laws this gates (a tree on the view channel, the build card, the
    // router's menu, what an automation plan may call) all turn on it, so a
    // near-miss name must not inherit any of them.
    expect(isVendoAppsTool("host_vendo_make")).toBe(false);
    expect(isVendoAppsTool("vendo_make_something")).toBe(false);
    expect(isVendoAppsTool("vendo_knowledge_search")).toBe(false);
  });
});

describe("§3 — the shared title table names the front door and nothing it replaced", () => {
  it("titles vendo_make in the consumer voice, and drops the two tools it replaced", () => {
    expect(VENDO_TOOL_TITLES[VENDO_MAKE_TOOL]).toBe("Make you a screen");
    // A stale entry is not inert: the client reads this table with only a wire
    // tool NAME in hand, so a leftover title is a label for a tool that can
    // never be called, and its absence is what proves the rename landed here too.
    expect(VENDO_TOOL_TITLES.vendo_apps_create).toBeUndefined();
    expect(VENDO_TOOL_TITLES.vendo_apps_edit).toBeUndefined();
  });
});

describe("modelToolDescription — the model can only speak a title it was told", () => {
  // Wave-1 live proof E1-5: the refusal that leaked `host_transferMoney` was
  // model-written, and the identifier was the only proper noun the model had —
  // the toolset it thinks with carried `description` and nothing else.
  it("leads with the human title", () => {
    expect(modelToolDescription({
      name: "host_transferMoney",
      title: "Send money",
      description: "Send money to a person from the user's checking account.",
    })).toBe("Send money — Send money to a person from the user's checking account.");
  });

  it("leaves the description alone when there is no title to add", () => {
    expect(modelToolDescription({ name: "host_x", description: "Does a thing." })).toBe("Does a thing.");
    expect(modelToolDescription({ name: "host_x", title: "  ", description: "Does a thing." })).toBe("Does a thing.");
    // `ToolListing.title` falls back to the NAME; repeating the identifier as a
    // label would teach the model exactly the wrong vocabulary.
    expect(modelToolDescription({ name: "host_x", title: "host_x", description: "Does a thing." })).toBe("Does a thing.");
  });
});

describe("the placement pair — one name, read by three packages", () => {
  it("pins both names inside the apps family, so the family's laws apply to them", () => {
    expect(VENDO_APPS_PIN_TOOL).toBe("vendo_apps_pin");
    expect(VENDO_APPS_UNPIN_TOOL).toBe("vendo_apps_unpin");
    expect(isVendoAppsTool(VENDO_APPS_PIN_TOOL)).toBe(true);
    expect(isVendoAppsTool(VENDO_APPS_UNPIN_TOOL)).toBe(true);
    expect(TOOL_NAME_PATTERN.test(VENDO_APPS_PIN_TOOL)).toBe(true);
    expect(TOOL_NAME_PATTERN.test(VENDO_APPS_UNPIN_TOOL)).toBe(true);
  });

  it("titles both in the consumer voice — a model may only say a label it was told", () => {
    // The apps package asserts `descriptor.title === VENDO_TOOL_TITLES[name]`
    // for EVERY descriptor, so a missing entry here is a titleless tool there.
    expect(VENDO_TOOL_TITLES[VENDO_APPS_PIN_TOOL]).toBe("Pin the app to your page");
    expect(VENDO_TOOL_TITLES[VENDO_APPS_UNPIN_TOOL]).toBe("Take the app off your page");
    for (const title of [VENDO_TOOL_TITLES[VENDO_APPS_PIN_TOOL], VENDO_TOOL_TITLES[VENDO_APPS_UNPIN_TOOL]]) {
      expect(title).not.toMatch(/vendo|_/i);
    }
  });

  it("names them as the presence-only set the projection reads", () => {
    expect([...PRESENCE_ONLY_TOOLS].sort()).toEqual(["vendo_apps_pin", "vendo_apps_unpin"]);
  });
});
