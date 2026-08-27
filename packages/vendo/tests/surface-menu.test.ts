import { CONNECTOR_DISCOVERY_TOOLS, VENDO_BASH_TOOL, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { memoizedSurfaceMenu, withAgentMenu } from "../src/surface-menu.js";

const listing = (...names: string[]): ToolRegistry => ({
  async descriptors(): Promise<ToolDescriptor[]> {
    return names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, risk: "read" }));
  },
  async execute() {
    return { status: "ok", output: {} as never };
  },
});

describe("withAgentMenu", () => {
  it("curates the host's surface and leaves Vendo's own plumbing alone", async () => {
    const [discovery] = CONNECTOR_DISCOVERY_TOOLS;
    const tools = listing("host_invoices", "host_payroll", "vendo_make", VENDO_BASH_TOOL, discovery!);

    const curated = withAgentMenu(tools, async () => new Set(["host_invoices"]));

    // `bash` carries no `vendo_` prefix — that is the whole point of its name —
    // so the prefix exemption cannot cover it and it has to be named. Without
    // that, a curated deployment loses the one tool that opens the user's files
    // while the system prompt keeps teaching it.
    expect((await curated.descriptors()).map(({ name }) => name))
      .toEqual(["host_invoices", "vendo_make", VENDO_BASH_TOOL, discovery]);
  });
});

describe("memoizedSurfaceMenu", () => {
  it("resolves once and reuses the answer", async () => {
    const resolve = vi.fn(async () => ["host_a"]);
    const menu = memoizedSurfaceMenu(resolve, () => undefined);
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("caches an unrestricted answer too", async () => {
    const resolve = vi.fn(async () => undefined);
    const menu = memoizedSurfaceMenu(resolve, () => undefined);
    await expect(menu()).resolves.toBeUndefined();
    await expect(menu()).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure: it warns with the cause and retries next time", async () => {
    const warnings: string[] = [];
    let attempt = 0;
    const resolve = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("overrides.json is unreadable");
      return ["host_a"];
    });
    const menu = memoizedSurfaceMenu(resolve, (line) => warnings.push(line));

    // Degrades to unrestricted rather than emptying the surface…
    await expect(menu()).resolves.toBeUndefined();
    // …loudly, naming the cause…
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("overrides.json is unreadable");
    // …and the next call tries again instead of being frozen unrestricted.
    await expect(menu()).resolves.toEqual(new Set(["host_a"]));
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
