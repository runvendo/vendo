import { describe, it, expect } from "vitest";
import { createLocalIntegrations } from "./integrations";

describe("createLocalIntegrations", () => {
  it("lists seeded integrations", async () => {
    const ig = createLocalIntegrations([{ id: "gmail", name: "Gmail", connected: false }]);
    expect(await ig.list()).toHaveLength(1);
  });

  it("connects and disconnects by id", async () => {
    const ig = createLocalIntegrations([{ id: "gmail", name: "Gmail", connected: false }]);
    expect((await ig.connect("gmail")).connected).toBe(true);
    expect((await ig.disconnect("gmail")).connected).toBe(false);
  });

  it("throws on unknown id", async () => {
    const ig = createLocalIntegrations([]);
    await expect(ig.connect("nope")).rejects.toThrow();
  });
});
