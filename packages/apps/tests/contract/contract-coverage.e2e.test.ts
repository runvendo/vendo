/**
 * The app-generation half of core's contract-coverage and schema suites.
 *
 * These cases moved with their subjects: `validateTree`, the tree/query schemas
 * and `vendoThemeSchema` are the app format, so they live on the contract door
 * now and `@vendoai/core`'s own suite may not reach up to them. The bodies are
 * unchanged — only the file and the import specifier are.
 */
import { describe, expect, it } from "vitest";
import * as contract from "../../src/contract/index.js";
import {
  appDocumentSchema,
  treeQuerySchema,
  treeSchema,
  validateAppDocument,
  validateTree,
  vendoThemeSchema,
} from "../../src/contract/index.js";
import { treeNodeSchema, uiPayloadSchema } from "@vendoai/core";

describe("§8 — tree/node/query schemas parse the structural shape", () => {
  it("treeSchema accepts a minimal v2 tree and rejects a foreign formatVersion", () => {
    expect(treeSchema.safeParse({
      formatVersion: "vendo-genui/v2", root: "a", nodes: [{ id: "a", component: "Text" }],
    }).success).toBe(true);
    expect(treeSchema.safeParse({
      formatVersion: "vendo-canvas/v2", root: "a", nodes: [],
    }).success).toBe(false);
  });

  it("treeNode and treeQuery enforce their required fields", () => {
    expect(treeNodeSchema.safeParse({ id: "a", component: "Text", source: "generated" }).success).toBe(true);
    expect(treeNodeSchema.safeParse({ id: "a", component: "Text", source: "wired" }).success).toBe(false);
    expect(treeQuerySchema.safeParse({ name: "x", tool: "host_x", input: { limit: 5 } }).success).toBe(true);
    expect(treeQuerySchema.safeParse({ name: "x" }).success).toBe(false);
  });
});

describe("§8 — validateTree validates fn: GRAMMAR only; machine-presence is an app-document rule", () => {
  // The tree shape carries no machine field, so validateTree structurally
  // cannot enforce "trees without a machine must not contain fn: references." It
  // validates fn: grammar; validateAppDocument (which knows `machine`) enforces
  // the machine-presence rule. See ESCALATION in the lane report.
  it("accepts a well-formed fn: reference with no machine in sight", () => {
    expect(validateTree({
      formatVersion: "vendo-genui/v2", root: "r",
      nodes: [{ id: "r", component: "Text" }],
      queries: [{ name: "refresh", tool: "fn:refresh" }],
    }).ok).toBe(true);
  });

  it("rejects fn: references that violate the /^fn:[A-Za-z_][A-Za-z0-9_-]*$/ grammar", () => {
    for (const tool of ["fn:", "fn:9lead", "fn:has space", "fn:slash/x"]) {
      const result = validateTree({
        formatVersion: "vendo-genui/v2", root: "r",
        nodes: [{ id: "r", component: "Text" }],
        queries: [{ name: "q", tool }],
      });
      expect(result.ok, tool).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });

  it("CORE-5: enforces the same grammar on fn: ACTION names inside node props (the wire-enforceable half)", () => {
    const treeWithAction = (action: string) => ({
      formatVersion: "vendo-genui/v2", root: "r",
      nodes: [{ id: "r", component: "Text", props: { rows: [{ action, label: "Go" }] } }],
    });
    expect(validateTree(treeWithAction("fn:refresh")).ok).toBe(true);
    for (const action of ["fn:", "fn:9lead", "fn:has space", "fn:slash/x"]) {
      const result = validateTree(treeWithAction(action));
      expect(result.ok, action).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
    // Non-fn action names are the host's tool namespace — not this grammar's job.
    expect(validateTree(treeWithAction("host_refresh")).ok).toBe(true);
  });

  it("validateAppDocument is where a machine-less fn: reference becomes an error", () => {
    const withFnNoMachine = {
      format: "vendo/app@1", id: "app_x", name: "X", ui: "tree" as const,
      tree: {
        formatVersion: "vendo-genui/v2", root: "r",
        nodes: [{ id: "r", component: "Text" }],
        queries: [{ name: "refresh", tool: "fn:refresh" }],
      },
    };
    expect(validateAppDocument(withFnNoMachine).ok).toBe(false);
    expect(validateAppDocument({
      ...withFnNoMachine,
      machine: { snapshotRef: "e2b:v2:snap_1", provisionedAt: "2026-07-19T00:00:00.000Z" },
    }).ok).toBe(true);
  });
});

describe("§12/§13/§14 — store, host-seam, and theme schemas", () => {
  it("vendoTheme accepts the remaining density/motion enum values", () => {
    expect(vendoThemeSchema.safeParse({
      colors: {
        background: "#000", surface: "#111", text: "#fff", muted: "#999",
        accent: "#00f", accentText: "#fff", danger: "#f00", border: "#333",
      },
      typography: { fontFamily: "Inter", headingFamily: "Newsreader", baseSize: "16px" },
      radius: { small: "2px", medium: "6px", large: "12px" },
      density: "compact", motion: "full",
    }).success).toBe(true);
  });

});

describe("tool, grant, approval, context, trigger, host-report, theme, and stream schemas", () => {
  it("validates a complete theme", () => {
    expect(vendoThemeSchema.safeParse({
      colors: {
        background: "#fff", surface: "#fff", text: "#111", muted: "#777",
        accent: "#00f", accentText: "#fff", danger: "#f00", border: "#ddd",
      },
      typography: { fontFamily: "Inter", baseSize: "16px" },
      radius: { small: "4px", medium: "8px", large: "16px" },
      density: "comfortable",
      motion: "reduced",
    }).success).toBe(true);
  });
});

describe("public export surface — the app-format schemas moved off @vendoai/core", () => {
  // The same zod-completeness guard core's suite keeps, for the names that left
  // it: every wire-crossing/persisted app-format type still ships a schema, on
  // the contract door.
  it("exposes the moved <name>Schema exports as zod schemas", () => {
    const expected = ["treeSchema", "treeQuerySchema", "vendoThemeSchema"];
    const registry = contract as unknown as Record<string, unknown>;
    for (const name of expected) {
      expect(name in registry, `missing export ${name}`).toBe(true);
      expect(typeof (registry[name] as { safeParse?: unknown }).safeParse, `${name} is not a zod schema`).toBe("function");
    }
  });
});

describe("§8 — UIPayload is the format-tag dispatch surface; unknown tags are valid payloads", () => {
  it("an unknown tag passes UIPayload but validateTree rejects it as a 'version' error (containment is the renderer's job)", () => {
    const unknown = { formatVersion: "vendo-canvas/v2", root: "r", nodes: [] };
    expect(uiPayloadSchema.safeParse(unknown).success).toBe(true);
    const result = validateTree(unknown);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("version");
  });
});

describe("§9 — app document plane values and sub-schemas", () => {
  it("accepts the http plane (keeps the last payload as a cover)", () => {
    const httpApp = {
      format: "vendo/app@1", id: "app_http", name: "Server App", ui: "http" as const,
    };
    expect(appDocumentSchema.safeParse(httpApp).success).toBe(true);
    expect(validateAppDocument(httpApp).ok).toBe(true);
  });
});

describe("amended public export surface — the Kit is one component family", () => {
  it("exports the Kit vocabulary as ONE name list", () => {
    const registry = contract as unknown as Record<string, unknown>;
    // V4 — one component family: the Kit specs ARE the built-in vocabulary,
    // and the three hand-kept name lists that used to sit beside them
    // (reserved / branded / prewired) are gone from the root.
    expect(registry.KIT_COMPONENT_NAMES).toEqual((registry.KIT_SPECS as { name: string }[]).map((spec) => spec.name));
    expect(registry.KIT_COMPONENT_NAMES).toContain("DataTable");
    expect(Object.keys(registry).filter((name) => /_COMPONENT_NAMES$/.test(name)).sort())
      .toEqual(["KIT_COMPONENT_NAMES", "KIT_SCREEN_COMPONENT_NAMES"]);
  });
});
