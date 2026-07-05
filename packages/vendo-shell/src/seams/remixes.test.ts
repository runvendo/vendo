import { describe, expect, it } from "vitest";
import { createLocalRemixes } from "./remixes";

const node = { id: "n1", kind: "generated" as const, payload: {} };

describe("createLocalRemixes", () => {
  it("pins one record per anchor with upsert semantics, gets, and unpins", async () => {
    const remixes = createLocalRemixes();
    expect(await remixes.get("invoices-widget")).toBeNull();

    const first = await remixes.pin({ anchorId: "invoices-widget", node, prompt: "add a column" });
    expect(first.createdAt).toBeTruthy();

    const second = await remixes.pin({
      anchorId: "invoices-widget",
      node: { ...node, id: "n2" },
      prompt: "sort it",
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect((await remixes.get("invoices-widget"))?.node.id).toBe("n2");

    await remixes.unpin("invoices-widget");
    expect(await remixes.get("invoices-widget")).toBeNull();
  });
});
