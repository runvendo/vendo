import type { HostFixture, HostName } from "../runner/types";

/** Browser-side HostFixture handle for pane components: `execute` proxies to
 *  the fixture executors through POST /api/tools (Task 5's route); the
 *  generation-side metadata (catalog/tools/shapes/theme) lives server-side
 *  only — panes that need it (VendoPane's theme) receive it with their
 *  document at integration time. */
export function makeClientFixture(name: HostName): HostFixture {
  return {
    name,
    catalog: {},
    tools: [],
    shapes: {},
    theme: {},
    async execute(tool, input) {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: name, tool, input }),
      });
      if (!res.ok) {
        throw new Error(`tool ${tool} failed: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },
  };
}
