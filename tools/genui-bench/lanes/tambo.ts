/**
 * Tambo lane — same registered-components family as CopilotKit: we register
 * the harness components (chart/table/form) and the host's tools (executors
 * backed by the fixture) with Tambo's headless client; their hosted
 * orchestration picks a component + props, returned as "component" content
 * blocks on the thread's assistant messages — one block per message, arriving
 * after the assistant text, as the 2026-07-26 live run showed. TamboPane
 * renders those picks through OUR harness registry. Each run creates a thread
 * on their hosted service (expected).
 */
import {
  buildHarnessCatalog,
  harnessRegistry,
  isHarnessComponentName,
  type HarnessComponentName,
} from "../cockpit/panes/harness-components";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

const MAX_STEPS = 6;

/** Tambo's V1 API rejects a run without a context identifier ("provide either
 *  userKey or an OAuth bearer token"); the bench is one synthetic user. */
const USER_KEY = "genui-bench";

/** Tambo injects its own display metadata into the props/inputs the model
 *  produces (`_tambo_statusMessage`, `_tambo_completionStatusMessage`); those
 *  are theirs, not our components'. Live run 2026-07-26 carried them on every
 *  component pick. */
function stripTamboInternals(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith("_tambo_")));
}

/** The minimal thread surface the adapter reads (TamboThread-compatible). */
export interface TamboThreadLike {
  id?: string;
  messages: Array<{
    role: string;
    content: Array<{ type: string; [key: string]: unknown }>;
  }>;
}

export type TamboRunner = (prompt: string, host: HostFixture, apiKey: string) => Promise<TamboThreadLike>;

interface HostToolLike {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** Default runner: the real @tambo-ai/client against their hosted service. */
const runWithTamboClient: TamboRunner = async (prompt, host, apiKey) => {
  const { TamboClient } = await import("@tambo-ai/client");
  type TamboTool = import("@tambo-ai/client").TamboTool;
  const client = new TamboClient({
    apiKey,
    userKey: USER_KEY,
    tools: (host.tools as HostToolLike[]).map(
      (tool): TamboTool => ({
        name: tool.name,
        description: tool.description,
        // TamboTool accepts raw JSON Schema alongside Standard Schema validators.
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as TamboTool["inputSchema"],
        outputSchema: {} as TamboTool["outputSchema"],
        tool: async (input: Record<string, unknown>) => {
          try {
            return await host.execute(tool.name, input ?? {});
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ),
  });
  for (const descriptor of buildHarnessCatalog(host)) {
    client.registerComponent(descriptor.name, {
      name: descriptor.name,
      description: descriptor.description,
      props: descriptor.propsSchema,
      contextTools: [],
      component: harnessRegistry[descriptor.name],
    });
  }
  const stream = client.run(prompt, { autoExecuteTools: true, maxSteps: MAX_STEPS });
  return (await stream.thread) as unknown as TamboThreadLike;
};

/** Shape of `LaneResult.raw` for this lane (what TamboPane renders). */
export interface TamboRaw {
  /** The final thread as returned by their service (internals drawer). */
  thread: TamboThreadLike;
  /** Assistant text across the thread. */
  text: string;
  /** Their orchestration's component picks — the "generated UI" under this paradigm. */
  components: Array<{ name: HarnessComponentName; props: Record<string, unknown> }>;
}

export interface TamboDeps {
  /** Test seam: recorded thread fixtures play back through the real extraction path. */
  run?: TamboRunner;
}

export function createTamboAdapter(deps: TamboDeps = {}): LaneAdapter {
  return {
    name: "tambo",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      const apiKey = process.env.TAMBO_API_KEY;
      if (!apiKey) return { status: "no-key" };
      const startedAt = Date.now();
      try {
        const thread = await (deps.run ?? runWithTamboClient)(prompt, host, apiKey);
        let text = "";
        const components: TamboRaw["components"] = [];
        for (const message of thread.messages ?? []) {
          if (message.role !== "assistant") continue;
          for (const block of message.content ?? []) {
            if (block.type === "text") text += String(block.text ?? "");
            if (block.type === "component" && isHarnessComponentName(String(block.name))) {
              components.push({
                name: String(block.name) as HarnessComponentName,
                props: stripTamboInternals((block.props ?? {}) as Record<string, unknown>),
              });
            }
          }
        }
        const raw: TamboRaw = { thread, text, components };
        return { status: "ok", startedAt, durationMs: Date.now() - startedAt, raw };
      } catch (error) {
        return {
          status: "failed",
          startedAt,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

const adapter = createTamboAdapter();
export default adapter;
