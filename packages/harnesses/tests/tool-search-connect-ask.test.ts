/**
 * The connect ask, on the `find_tools` rail: it survives curation, and nothing
 * here says a card arrives without it.
 *
 * uiaudit 2026-08-06 — the system prompt teaches `list_connections` and
 * `request_connection` by name on every discovery surface, but neither carries the
 * `vendo_` prefix the always-active exemption keyed on, so the loadout treated
 * them as host API tools. Every branch of {@link computeInitialLoadout} could then
 * drop them: a host past the cap (dub ≈ 617 tools), a curated `surfaces.agent`
 * menu, an explicit `loadout`, a connection-scoped seed. The prompt kept teaching
 * both tools regardless — a teaching that becomes a lie in exactly the
 * deployments large enough to need it.
 *
 * Asserted through the shipped session's own `activeToolNames()`, attached the way
 * `createDiscoveryRails` attaches it, so this reads the same set the model is
 * offered rather than the loadout helper in isolation.
 */
import { CONNECTOR_DISCOVERY_TOOLS, type ToolDescriptor } from "@vendoai/core";
import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  computeInitialLoadout,
  createToolSearchSession,
  DEFAULT_MAX_INITIAL_TOOLS,
  FIND_TOOLS_TOOL_NAME,
  type ToolSearchConfig,
} from "../src/tool-search.js";

const tool = (name: string): ToolDescriptor => ({
  name,
  title: `Do ${name}`,
  description: `the ${name} tool`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
});

const CONNECTOR_TOOLS = CONNECTOR_DISCOVERY_TOOLS.map(tool);
/** A host well past the cap — the size the cap exists for. */
const BIG_HOST = Array.from({ length: 200 }, (_, index) =>
  tool(`host_tool_${String(index).padStart(3, "0")}`));
const LISTING = [...BIG_HOST, ...CONNECTOR_TOOLS];

const hostToolsIn = (names: readonly string[]): string[] =>
  names.filter((name) => name.startsWith("host_tool_"));

function active(
  descriptors: readonly ToolDescriptor[],
  options: {
    config?: Partial<ToolSearchConfig>;
    menuNames?: readonly string[];
    seedNames?: readonly string[];
  } = {},
): string[] {
  const session = createToolSearchSession({
    config: { search: async () => [], ...options.config },
    descriptors,
    loaded: new Set<string>(),
    ...(options.menuNames === undefined ? {} : { menuNames: options.menuNames }),
    ...(options.seedNames === undefined ? {} : { seedNames: options.seedNames }),
  });
  // The one ToolSet `createDiscoveryRails` builds, from the same descriptors.
  session.attach(Object.fromEntries(descriptors.map((d) => [d.name, {} as never])) as ToolSet);
  return session.activeToolNames();
}

describe("the connector-discovery tools are never loadout-gated", () => {
  it("keeps them all on a listing far past the cap, and does not spend the cap on them", () => {
    const names = active(LISTING);
    for (const name of CONNECTOR_DISCOVERY_TOOLS) expect(names, name).toContain(name);
    // Exempt means exempt: the host's budget is untouched by the four.
    expect(hostToolsIn(names)).toHaveLength(DEFAULT_MAX_INITIAL_TOOLS);
  });

  it("keeps them when the host curates this surface down to two host tools", () => {
    const names = active(LISTING, { menuNames: ["host_tool_000", "host_tool_001"] });
    expect(names).toContain("request_connection");
    expect(names).toContain("list_connections");
    // The menu still binds everything it is entitled to bind.
    expect(hostToolsIn(names)).toEqual(["host_tool_000", "host_tool_001"]);
  });

  it("keeps them under an explicit loadout that never names them", () => {
    const names = active(LISTING, { config: { loadout: ["host_tool_000"] } });
    expect(names).toContain("request_connection");
    expect(names).toContain("list_connections");
    expect(hostToolsIn(names)).toEqual(["host_tool_000"]);
  });

  it("keeps them under a connection-scoped seed that never names them", () => {
    const names = active(LISTING, { seedNames: ["host_tool_042"] });
    expect(names).toContain("request_connection");
    expect(names).toContain("list_connections");
    expect(hostToolsIn(names)).toEqual(["host_tool_042"]);
  });

  it("exempts them in the loadout helper itself, so no future path can re-gate them", () => {
    const initial = computeInitialLoadout(LISTING, { search: async () => [], loadout: [] }, undefined, []);
    for (const name of CONNECTOR_DISCOVERY_TOOLS) expect([...initial], name).toContain(name);
  });
});

describe("find_tools does not promise a card nobody asked for", () => {
  /** The old text said an unconnected service "surfaces an inline connect card
   *  WITHOUT its tools running" — a card that arrives on its own. It does not: the
   *  card is minted by `request_connection`, which the model has to call. A model
   *  that believes the card is coming has a licensed reason not to ask. */
  const description = (): string => {
    const tools: ToolSet = {};
    createToolSearchSession({
      config: { search: async () => [] },
      descriptors: CONNECTOR_TOOLS,
      loaded: new Set<string>(),
    }).attach(tools);
    return (tools[FIND_TOOLS_TOOL_NAME] as { description: string }).description;
  };

  it("keeps the true half and names the ask instead of an automatic card", () => {
    const text = description();
    expect(text).toContain("do not keep calling tools of a service you know is unconnected");
    expect(text).toContain("ask for it with request_connection instead");
    expect(text).not.toContain("surfaces an inline connect card");
    expect(text).not.toContain("WITHOUT its tools running");
  });
});
