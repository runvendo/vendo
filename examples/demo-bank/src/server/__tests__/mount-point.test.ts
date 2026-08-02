/**
 * THE MOUNT POINT HAS TO REACH THE AGENT'S TOOL CALLS.
 *
 * Maple is served in place at demos.vendo.run/maple, so the endpoints really
 * live at `<origin>/maple/api/…`. Next rewrites the app's own requests; it does
 * not know the agent exists. The prefix travels `openapi.json` servers →
 * `vendo sync` → `.vendo/tools.json` `binding.path`, and NOTHING a human can
 * see depends on it: get it wrong and every page renders perfectly while every
 * number the agent quotes is a 404. That is why this is asserted rather than
 * eyeballed.
 */
import { describe, expect, it } from "vitest";
import { config } from "../../proxy";
import spec from "../../../openapi.json";
import tools from "../../../.vendo/tools.json";
import { BASE_PATH } from "@/lib/base-path";

describe("Maple's mount point", () => {
  it("is what the spec declares as its server", () => {
    expect(spec.servers).toEqual([{ url: BASE_PATH }]);
  });

  it("reaches every synced tool binding, route-scanned ones included", () => {
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const { name, binding } of tools.tools) {
      expect(binding.path.startsWith(`${BASE_PATH}/`), `${name}: ${binding.method} ${binding.path}`).toBe(true);
    }
  });

  /** Also catches a STALE tools.json — a spec edit that never got synced. */
  it("covers every documented operation exactly once", () => {
    const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).map(method => `${method.toUpperCase()} ${BASE_PATH}${path}`))
      .sort();
    const synced = tools.tools
      .filter(tool => tool.binding.kind === "openapi")
      .map(tool => `${tool.binding.method} ${tool.binding.path}`)
      .sort();
    expect(synced).toEqual(documented);
  });

  /** Next prefixes every proxy matcher with the mount point, so the catch-all
   *  becomes `/maple/((?!…).*)` and does not match the bare `/maple` a visitor
   *  types. Dropping the explicit "/" leaves the home page as the one page the
   *  auth gate never sees — and it renders a signed-out visitor a signed-in
   *  page. */
  it("is covered by the proxy matcher at its bare root", () => {
    expect(config.matcher).toContain("/");
  });
});
