import { describe, expect, it } from "vitest";
import {
  resolveGeneratedPayload,
  type GeneratedPayload,
  type ComponentNode,
  type RegisteredComponent,
  type VendoSchema,
} from "@vendoai/core";
import { createGenUISession } from "./genui-host.js";

const VERSION = "vendo-genui/v1";

// A Standard Schema for `{ title: string }`. Built by hand (rather than importing
// zod, which is not a stage dependency) but conforming to the exact `~standard`
// contract zod implements, so it exercises the same validate() code path.
const titleStringSchema: VendoSchema<{ title: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { title?: unknown }).title === "string"
      ) {
        return { value: value as { title: string } };
      }
      return { issues: [{ message: "title must be a string" }] };
    },
  },
};

/** Same shape but async — used to prove async schemas are SKIPPED in v1. */
const asyncTitleSchema: VendoSchema<{ title: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    async validate(value: unknown) {
      return titleStringSchema["~standard"].validate(value);
    },
  },
};

const registryWith = (
  schema: VendoSchema<unknown>,
  name = "Card",
): RegisteredComponent[] => [
  { name, description: "a card", propsSchema: schema, source: "host" },
];

/** A small generated payload: a host Card sibling + a prewired Text. */
function hostPayload(cardProps: Record<string, unknown>): GeneratedPayload {
  return {
    formatVersion: VERSION,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["card", "text"] },
      { id: "card", component: "Card", source: "host", props: cardProps },
      { id: "text", component: "Text", props: { value: "sibling" } },
    ],
  };
}

/** A minimal valid payload with two nodes binding distinct pointers. */
function basePayload(): GeneratedPayload {
  return {
    formatVersion: VERSION,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["greeting", "subtitle"] },
      { id: "greeting", component: "Text", props: { value: { $path: "/user/name" } } },
      { id: "subtitle", component: "Text", props: { value: { $path: "/title" } } },
    ],
    data: { user: { name: "Ada" }, title: "Hello" },
  };
}

describe("createGenUISession — validation", () => {
  it("rejects a bad formatVersion with a version error", () => {
    const result = createGenUISession({ ...basePayload(), formatVersion: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("version");
  });

  it("rejects a structurally bad payload with a provision error", () => {
    const result = createGenUISession({ formatVersion: VERSION, root: "missing", nodes: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("provision");
  });

  it("rejects a non-object payload with a provision error", () => {
    const result = createGenUISession(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("provision");
  });
});

describe("createGenUISession — tree", () => {
  it("exposes the resolved tree with bound props", () => {
    const payload = basePayload();
    const result = createGenUISession(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.session.tree).toEqual(resolveGeneratedPayload(payload));
  });

  it("getData returns the initial data model", () => {
    const payload = basePayload();
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    expect(result.session.getData()).toEqual({ user: { name: "Ada" }, title: "Hello" });
  });

  it("defaults data to an empty object when omitted", () => {
    const result = createGenUISession({
      formatVersion: VERSION,
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { value: { $path: "/missing" } } }],
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.session.getData()).toEqual({});
  });
});

describe("session.applyDataPatch — affected nodes", () => {
  it("returns exactly the affected node, re-resolved against the new value", () => {
    const result = createGenUISession(basePayload());
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/user/name", "Grace");
    expect(patches).toHaveLength(1);
    expect(patches[0].nodeId).toBe("greeting");
    expect((patches[0].node as ComponentNode).props).toEqual({ value: "Grace" });
    expect(result.session.getData()).toEqual({ user: { name: "Grace" }, title: "Hello" });
  });

  it("returns [] when patching an unbound pointer", () => {
    const result = createGenUISession(basePayload());
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/unrelated", 42);
    expect(patches).toEqual([]);
    expect(result.session.getData()).toEqual({
      user: { name: "Ada" },
      title: "Hello",
      unrelated: 42,
    });
  });

  it("matches a node bound to a child path when a parent path is patched", () => {
    // node binds /user/name; patch /user → affected
    const result = createGenUISession(basePayload());
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/user", { name: "Lin" });
    const ids = patches.map((p) => p.nodeId);
    expect(ids).toContain("greeting");
    expect((patches.find((p) => p.nodeId === "greeting")!.node as ComponentNode).props).toEqual({
      value: "Lin",
    });
  });

  it("matches a node bound to a parent path when a child path is patched", () => {
    // node binds /user; patch /user/name → affected
    const payload: GeneratedPayload = {
      formatVersion: VERSION,
      root: "card",
      nodes: [{ id: "card", component: "Json", props: { value: { $path: "/user" } } }],
      data: { user: { name: "Ada" } },
    };
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/user/name", "Grace");
    expect(patches).toHaveLength(1);
    expect(patches[0].nodeId).toBe("card");
    expect((patches[0].node as ComponentNode).props).toEqual({ value: { name: "Grace" } });
  });

  it("does not match on partial segment overlap (no false positive)", () => {
    const payload: GeneratedPayload = {
      formatVersion: VERSION,
      root: "n",
      nodes: [{ id: "n", component: "Text", props: { value: { $path: "/username" } } }],
      data: { username: "ada", user: "x" },
    };
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    // patching /user must NOT affect a node bound to /username
    expect(result.session.applyDataPatch("/user", "y")).toEqual([]);
  });

  it("returns both nodes when two bind the same pointer, in original order", () => {
    const payload: GeneratedPayload = {
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["a", "b"] },
        { id: "a", component: "Text", props: { value: { $path: "/v" } } },
        { id: "b", component: "Text", props: { value: { $path: "/v" } } },
      ],
      data: { v: "x" },
    };
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/v", "y");
    expect(patches.map((p) => p.nodeId)).toEqual(["a", "b"]);
    for (const p of patches) {
      expect((p.node as ComponentNode).props).toEqual({ value: "y" });
    }
  });
});

describe("session.applyDataPatch — delete & immutability", () => {
  it("deletes a key when called without a value arg", () => {
    const result = createGenUISession(basePayload());
    if (!result.ok) throw new Error("expected success");
    const patches = result.session.applyDataPatch("/user/name");
    expect(patches).toHaveLength(1);
    expect(patches[0].nodeId).toBe("greeting");
    expect((patches[0].node as ComponentNode).props).toEqual({ value: undefined });
    expect(result.session.getData()).toEqual({ user: {}, title: "Hello" });
  });

  it("setting an explicit undefined value is NOT a delete", () => {
    const result = createGenUISession(basePayload());
    if (!result.ok) throw new Error("expected success");
    result.session.applyDataPatch("/user/name", undefined);
    const data = result.session.getData() as { user: { name?: unknown } };
    expect("name" in data.user).toBe(true);
    expect(data.user.name).toBeUndefined();
  });

  it("does not mutate the original payload object across patches", () => {
    const payload = basePayload();
    const snapshot = structuredClone(payload);
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    result.session.applyDataPatch("/user/name", "Grace");
    result.session.applyDataPatch("/title");
    expect(payload).toEqual(snapshot);
  });
});

describe("createGenUISession — registry prop validation (B1)", () => {
  const cardNode = (tree: ComponentNode): ComponentNode =>
    tree.children!.find((c) => (c as ComponentNode).id === "card") as ComponentNode;

  it("replaces a host node whose props FAIL its propsSchema with an error placeholder; siblings intact", () => {
    const result = createGenUISession(hostPayload({ title: 123 }), {
      registry: registryWith(titleStringSchema),
    });
    if (!result.ok) throw new Error("expected success");
    const tree = result.session.tree as ComponentNode;
    const card = cardNode(tree);
    expect(card).toMatchObject({
      id: "card",
      source: "prewired",
      name: "Text",
      props: { text: "[invalid props: Card]" },
    });
    // Sibling Text is untouched.
    const sibling = tree.children!.find((c) => (c as ComponentNode).id === "text") as ComponentNode;
    expect(sibling.name).toBe("Text");
    expect(sibling.props).toEqual({ value: "sibling" });
  });

  it("leaves a host node whose props PASS its propsSchema unchanged", () => {
    const result = createGenUISession(hostPayload({ title: "Hi" }), {
      registry: registryWith(titleStringSchema),
    });
    if (!result.ok) throw new Error("expected success");
    const card = cardNode(result.session.tree as ComponentNode);
    expect(card).toMatchObject({ id: "card", source: "host", name: "Card", props: { title: "Hi" } });
  });

  it("leaves the tree unchanged when no registry is provided (back-compat)", () => {
    const payload = hostPayload({ title: 123 });
    const result = createGenUISession(payload);
    if (!result.ok) throw new Error("expected success");
    expect(result.session.tree).toEqual(resolveGeneratedPayload(payload));
  });

  it("leaves a host node unchanged when its name is NOT in the registry", () => {
    // Registry knows only "Other"; the Card node has no descriptor → left as-is.
    const result = createGenUISession(hostPayload({ title: 123 }), {
      registry: registryWith(titleStringSchema, "Other"),
    });
    if (!result.ok) throw new Error("expected success");
    const card = cardNode(result.session.tree as ComponentNode);
    expect(card).toMatchObject({ id: "card", source: "host", name: "Card" });
  });

  it("SKIPS validation for an async schema (only sync schemas validated in v1)", () => {
    const result = createGenUISession(hostPayload({ title: 123 }), {
      registry: registryWith(asyncTitleSchema),
    });
    if (!result.ok) throw new Error("expected success");
    // Even though props are invalid, an async schema is skipped → node unchanged.
    const card = cardNode(result.session.tree as ComponentNode);
    expect(card).toMatchObject({ id: "card", source: "host", name: "Card" });
  });

  it("validates re-resolved nodes on a data patch too", () => {
    const payload: GeneratedPayload = {
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["card"] },
        { id: "card", component: "Card", source: "host", props: { title: { $path: "/t" } } },
      ],
      data: { t: "ok" },
    };
    const result = createGenUISession(payload, { registry: registryWith(titleStringSchema) });
    if (!result.ok) throw new Error("expected success");
    // Patch the bound pointer to an invalid (non-string) value → re-resolved node fails.
    const patches = result.session.applyDataPatch("/t", 999);
    expect(patches).toHaveLength(1);
    expect(patches[0].nodeId).toBe("card");
    expect(patches[0].node).toMatchObject({
      source: "prewired",
      name: "Text",
      props: { text: "[invalid props: Card]" },
    });
  });
});
