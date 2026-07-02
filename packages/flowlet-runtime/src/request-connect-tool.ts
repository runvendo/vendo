/**
 * `request_connect` — the agent's narrow affordance for the ONE piece of UI that
 * legitimately can't render in the egress-jailed sandbox: the Connect card. It
 * runs the real Composio OAuth flow (popup, chat context, window events), all
 * needing host-page privileges the opaque-origin sandbox denies. So this tool
 * emits a HOST-rendered `component` node named "Connect"; the demo's render-node
 * Connect branch turns it into <DemoConnectCard toolkit reason />.
 */
import { tool } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { FlowletUIMessage, UINode } from "@flowlet/core";

type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

export function createRequestConnectTool(writer: FlowletWriter) {
  let counter = 0;

  return tool({
    description:
      "Show a Connect card so the user can authorize a toolkit (e.g. gmail, slack) " +
      "that isn't connected yet. Use this when a request needs a toolkit the user " +
      "hasn't connected.",
    inputSchema: z.object({
      toolkit: z.string().describe("Toolkit slug to connect, e.g. 'gmail' or 'slack'."),
      reason: z.string().optional().describe("Short reason shown to the user for why this connection is needed."),
    }),
    execute: async ({ toolkit, reason }) => {
      const node: UINode = {
        id: `connect-${++counter}`,
        kind: "component",
        source: "host",
        name: "Connect",
        props: { toolkit, reason },
      };
      writer.write({ type: "data-ui", id: node.id, data: node });
      return "connect card shown";
    },
  });
}
