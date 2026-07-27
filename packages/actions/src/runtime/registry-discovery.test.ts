import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import { createActions } from "./registry.js";

/** Discovery-discipline T4 (criterion 10): repeated identical discovery must
 * be free — memoized per query, incremental toolkit expansion, configurable
 * expansion fan-out. The "transport" here is the fake lazy connector: every
 * descriptor/index read that would be an HTTP round-trip is counted. */

function tool(toolkit: string, slug: string): ToolDescriptor {
  return {
    name: `${toolkit}_${slug}`,
    description: `${toolkit} ${slug.toLowerCase().replaceAll("_", " ")}`,
    inputSchema: { type: "object" },
    risk: "write",
  };
}

const TOOLKITS: Record<string, ToolDescriptor[]> = {
  gmail: [tool("gmail", "SEND_EMAIL")],
  slack: [tool("slack", "POST_MESSAGE")],
  notion: [tool("notion", "CREATE_PAGE")],
};

/** A lazy brokered connector with counted "wire" reads. */
function fakeLazyConnector() {
  const counters = { index: 0, schemaFetches: [] as string[] };
  const expanded = new Set<string>();
  const fetched = new Set<string>();
  const connector: Connector = {
    name: "composio",
    execute: async () => ({ status: "ok", output: {} }),
    discoveryIndex: async () => {
      counters.index += 1;
      return [
        { toolkit: "gmail", description: "send and read email" },
        { toolkit: "slack", description: "post chat messages to channels" },
        { toolkit: "notion", description: "create pages and databases" },
      ];
    },
    expandToolkits: async (toolkits) => {
      let changed = false;
      for (const toolkit of toolkits) {
        if (!(toolkit in TOOLKITS) || expanded.has(toolkit)) continue;
        expanded.add(toolkit);
        changed = true;
      }
      return changed;
    },
    descriptors: async () => {
      const out: ToolDescriptor[] = [];
      for (const toolkit of expanded) {
        // Per-toolkit schema loads are memoized process-wide (the real
        // connectors' toolkitToolCache); a REfetch of a known toolkit is the
        // regression this counter exists to catch.
        if (!fetched.has(toolkit)) {
          fetched.add(toolkit);
          counters.schemaFetches.push(toolkit);
        }
        out.push(...TOOLKITS[toolkit]!);
      }
      return out;
    },
    toolkitOf: (name) => Object.keys(TOOLKITS).find((toolkit) => name.startsWith(`${toolkit}_`)),
  };
  return { connector, counters };
}

describe("search memo (criterion 10)", () => {
  it("a second identical query hits the memo: zero new wire reads, no re-expansion", async () => {
    const { connector, counters } = fakeLazyConnector();
    const expandSpy = vi.spyOn(connector, "expandToolkits");
    const registry = createActions({ connectors: [connector] });

    const first = await registry.search("send an email");
    expect(first.map((match) => match.name)).toContain("gmail_SEND_EMAIL");
    const indexReads = counters.index;
    const schemaReads = counters.schemaFetches.length;
    const expansions = expandSpy.mock.calls.length;

    const second = await registry.search("send an email");
    expect(second).toEqual(first);
    expect(counters.index).toBe(indexReads);
    expect(counters.schemaFetches.length).toBe(schemaReads);
    // The memo answers before scoring: no second expansion pass at all.
    expect(expandSpy.mock.calls.length).toBe(expansions);
  });

  it("add() invalidates the memo so a mid-run surface change is searchable", async () => {
    const { connector } = fakeLazyConnector();
    const registry = createActions({ connectors: [connector] });
    const before = await registry.search("open the vault");
    expect(before.map((match) => match.name)).not.toContain("host_OPEN_VAULT");

    registry.add({
      descriptors: async () => [{ name: "host_OPEN_VAULT", description: "open the vault", inputSchema: { type: "object" }, risk: "read" }],
      execute: async () => ({ status: "ok", output: {} }),
    });
    const after = await registry.search("open the vault");
    expect(after.map((match) => match.name)).toContain("host_OPEN_VAULT");
  });
});

describe("incremental expansion (T4b)", () => {
  it("expanding a second toolkit appends its tools without refetching the first", async () => {
    const { connector, counters } = fakeLazyConnector();
    const registry = createActions({ connectors: [connector] });

    await registry.search("send an email"); // expands gmail, loads the registry
    expect(counters.schemaFetches).toEqual(["gmail"]);

    await registry.expandToolkits(["slack"]);
    const names = (await registry.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("gmail_SEND_EMAIL");
    expect(names).toContain("slack_POST_MESSAGE");
    // gmail's schemas were never refetched by the slack expansion.
    expect(counters.schemaFetches).toEqual(["gmail", "slack"]);

    // The appended tool dispatches (it is in the live dispatch table).
    const outcome = await registry.execute(
      { id: "c1", tool: "slack_POST_MESSAGE", args: {} },
      { principal: { kind: "user", subject: "u1" }, venue: "chat", presence: "present", sessionId: "s1" },
    );
    expect(outcome.status).toBe("ok");
  });

  it("overrides still apply to incrementally expanded tools (disabled stays out)", async () => {
    const { connector } = fakeLazyConnector();
    const registry = createActions({
      connectors: [connector],
      overrides: {
        format: "vendo/overrides@3",
        tools: { slack_POST_MESSAGE: { disabled: true } },
      },
    });

    await registry.search("send an email"); // full load happens here
    await registry.expandToolkits(["slack"]);
    const names = (await registry.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("gmail_SEND_EMAIL");
    expect(names).not.toContain("slack_POST_MESSAGE");
  });
});

describe("transient failures never poison the caches (checker F4)", () => {
  it("a rejected schema fetch is evicted, so the next search retries and recovers", async () => {
    let attempt = 0;
    const connector: Connector = {
      name: "composio",
      execute: async () => ({ status: "ok", output: {} }),
      discoveryIndex: async () => [{ toolkit: "gmail", description: "send and read email" }],
      expandToolkits: async () => true,
      descriptors: async () => {
        attempt += 1;
        // First read is a broker blip; every later read succeeds.
        if (attempt === 1) throw new Error("ENOTFOUND backend.composio.dev");
        return TOOLKITS.gmail!;
      },
    };
    const registry = createActions({ connectors: [connector] });

    await expect(registry.search("send an email")).rejects.toThrow(/ENOTFOUND/);
    // Without eviction this second call would replay the rejection forever.
    const recovered = await registry.search("send an email");
    expect(recovered.map((match) => match.name)).toContain("gmail_SEND_EMAIL");
    expect(attempt).toBeGreaterThan(1);
  });

  it("a rejected discovery index is evicted too, so discovery recovers", async () => {
    let indexAttempt = 0;
    const connector: Connector = {
      name: "composio",
      execute: async () => ({ status: "ok", output: {} }),
      descriptors: async () => [],
      expandToolkits: async () => false,
      discoveryIndex: async () => {
        indexAttempt += 1;
        if (indexAttempt === 1) throw new Error("catalog unreachable");
        return [{ toolkit: "gmail", description: "send and read email" }];
      },
    };
    const registry = createActions({ connectors: [connector] });

    await expect(registry.search("send an email")).rejects.toThrow(/catalog unreachable/);
    await expect(registry.search("send an email")).resolves.toEqual([]);
    expect(indexAttempt).toBe(2);
  });
});

describe("configurable expansion fan-out (T4c)", () => {
  it("maxExpansions bounds how many toolkits one query may expand (default stays 3)", async () => {
    const { connector } = fakeLazyConnector();
    const registry = createActions({ connectors: [connector] });

    // A broad query matching all three toolkit blurbs, capped to ONE expansion.
    const matches = await registry.search("create a page, post chat messages, send and read email", { maxExpansions: 1 });
    const toolkits = new Set(matches.map((match) => match.name.split("_")[0]));
    expect(toolkits.size).toBeLessThanOrEqual(1);
  });
});
