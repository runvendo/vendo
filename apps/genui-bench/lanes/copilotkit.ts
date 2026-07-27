/**
 * CopilotKit lane — registered-components paradigm: CopilotKit has NO
 * server-generated UI. The model emits tool calls; UI comes from components
 * YOU register. This adapter drives one conversation against a self-hosted
 * CopilotKit v2 runtime (keyless/local — no CopilotKit account): it POSTs
 * AG-UI RunAgentInput to the runtime's fetch handler in-process, parses the
 * SSE event stream, executes host tool calls against the fixture, and records
 * harness-component tool calls (chart/table/form) as render intents for the
 * pane. Per the spec footnote: this measures tool-call routing over
 * registered components, not open-ended generation.
 *
 * Model: the runtime's BuiltInAgent with an Anthropic model (the runtime
 * offers a first-class Anthropic path, preferred over OpenAI here), so the
 * lane needs ANTHROPIC_API_KEY — same key the Vendo lane uses.
 */
import { BuiltInAgent, CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import {
  buildHarnessCatalog,
  isHarnessComponentName,
  type HarnessComponentName,
} from "../cockpit/panes/harness-components";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

// Anthropic model ids are dash-separated ("claude-sonnet-4-6", not "4.5");
// the runtime strips the provider prefix and passes the rest to the API.
// Same GENUI_BENCH_MODEL override the Vendo lane honors, for parity.
export const COPILOTKIT_MODEL = `anthropic/${process.env.GENUI_BENCH_MODEL ?? "claude-sonnet-4-6"}`;
export const COPILOTKIT_BASE_PATH = "/api/copilotkit";
export const COPILOTKIT_AGENT_ID = "default";
const MAX_ROUNDS = 4;

export type RuntimeHandler = (req: Request) => Promise<Response>;

/** The self-hosted runtime; shared by the adapter (in-process, no server) and
 *  the Next route at app/api/copilotkit/route.ts. */
export function buildCopilotRuntimeHandler(): RuntimeHandler {
  // Same posture as denying @scarf/scarf: no anonymous telemetry from a bench.
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
  const runtime = new CopilotRuntime({
    agents: { [COPILOTKIT_AGENT_ID]: new BuiltInAgent({ model: COPILOTKIT_MODEL }) },
  });
  return createCopilotRuntimeHandler({ runtime, basePath: COPILOTKIT_BASE_PATH });
}

interface AgUiEvent {
  type: string;
  [key: string]: unknown;
}

interface AgUiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  toolCallId?: string;
}

export interface CopilotKitToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Stringified result fed back to the model (host tools) or "rendered" (harness components). */
  result?: string;
}

/** Shape of `LaneResult.raw` for this lane (what CopilotKitPane renders). */
export interface CopilotKitRaw {
  model: string;
  /** Assistant text across all rounds. */
  text: string;
  /** Ordered tool calls across all rounds, with the results we fed back. */
  toolCalls: CopilotKitToolCall[];
  /** Harness component picks — the "generated UI" under this paradigm. */
  intents: Array<{ name: HarnessComponentName; props: Record<string, unknown> }>;
  /** Full ordered AG-UI event stream (all rounds), for the internals drawer. */
  events: unknown[];
}

/** CopilotKit's zod converter (convertJsonSchemaToZodSchema) only handles
 *  scalar `type` strings — a union like `type: ["string","number"]` crashes
 *  the whole run. Narrow unions to their first non-null member (noted in the
 *  description) so the runtime accepts every harness/host schema. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "type" && Array.isArray(value)) {
      const kept = value.find((t) => t !== "null") ?? value[0];
      out.type = kept;
      const dropped = value.filter((t) => t !== kept);
      if (dropped.length > 0) {
        const note = `accepts ${value.join(" or ")}; send as ${String(kept)}`;
        out.description = typeof out.description === "string" ? `${out.description} (${note})` : note;
      }
      continue;
    }
    out[key] = sanitizeSchema(value);
  }
  return out;
}

/** The runtime's SSE handler writes encoder STRINGS into its stream; Node's
 *  undici rejects that inside Response.text() ("Received non-Uint8Array
 *  chunk"), so read the body reader directly, accepting either chunk kind. */
async function readBodyText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array | string>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += typeof value === "string" ? value : decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function parseSse(body: string): AgUiEvent[] {
  const events: AgUiEvent[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as AgUiEvent);
    } catch {
      // non-JSON keepalive frames are fine to skip
    }
  }
  return events;
}

function digestRound(events: AgUiEvent[]): { text: string; calls: CopilotKitToolCall[]; error?: string } {
  let text = "";
  const open = new Map<string, { name: string; args: string }>();
  const calls: CopilotKitToolCall[] = [];
  let error: string | undefined;
  for (const event of events) {
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
        text += String(event.delta ?? "");
        break;
      case "TOOL_CALL_START":
        open.set(String(event.toolCallId), { name: String(event.toolCallName), args: "" });
        break;
      case "TOOL_CALL_ARGS": {
        const call = open.get(String(event.toolCallId));
        if (call) call.args += String(event.delta ?? "");
        break;
      }
      case "TOOL_CALL_END": {
        const id = String(event.toolCallId);
        const call = open.get(id);
        if (call) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
          } catch {
            // leave args empty when the model emitted unparsable JSON
          }
          calls.push({ id, name: call.name, arguments: parsed });
          open.delete(id);
        }
        break;
      }
      case "RUN_ERROR":
        error = String(event.message ?? "runtime RUN_ERROR");
        break;
      default:
        break;
    }
  }
  return { text, calls, ...(error === undefined ? {} : { error }) };
}

export interface CopilotKitDeps {
  /** Test seam: recorded SSE fixtures play back through the real parse/loop path. */
  handler?: RuntimeHandler;
}

export function createCopilotKitAdapter(deps: CopilotKitDeps = {}): LaneAdapter {
  return {
    name: "copilotkit",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      if (!process.env.ANTHROPIC_API_KEY) return { status: "no-key" };
      const startedAt = Date.now();
      try {
        const handler = deps.handler ?? buildCopilotRuntimeHandler();
        const hostTools = host.tools as Array<{
          name: string;
          description: string;
          inputSchema?: Record<string, unknown>;
        }>;
        const tools = [
          ...buildHarnessCatalog(host).map((c) => ({
            name: c.name,
            description: c.description,
            parameters: sanitizeSchema(c.propsSchema),
          })),
          ...hostTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} }),
          })),
        ];

        const threadId = `bench-${startedAt.toString(36)}`;
        const messages: AgUiMessage[] = [{ id: "msg-user-1", role: "user", content: prompt }];
        const allEvents: AgUiEvent[] = [];
        const orderedCalls: CopilotKitToolCall[] = [];
        const intents: CopilotKitRaw["intents"] = [];
        let text = "";

        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await handler(
            new Request(
              `http://genui-bench.internal${COPILOTKIT_BASE_PATH}/agent/${COPILOTKIT_AGENT_ID}/run`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  threadId,
                  runId: `run-${round + 1}`,
                  state: {},
                  messages,
                  tools,
                  context: [],
                  forwardedProps: {},
                }),
              },
            ),
          );
          const body = await readBodyText(response);
          if (!response.ok) {
            throw new Error(`copilotkit runtime ${response.status}: ${body.slice(0, 300)}`);
          }
          const events = parseSse(body);
          allEvents.push(...events);
          const { text: roundText, calls, error } = digestRound(events);
          if (error) throw new Error(error);
          text += roundText;
          if (calls.length === 0) break;

          messages.push({
            id: `msg-assistant-${round + 1}`,
            role: "assistant",
            content: roundText,
            toolCalls: calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          });
          let sawHostTool = false;
          for (const call of calls) {
            if (isHarnessComponentName(call.name)) {
              intents.push({ name: call.name, props: call.arguments });
              call.result = "rendered";
            } else {
              sawHostTool = true;
              try {
                call.result = JSON.stringify(await host.execute(call.name, call.arguments));
              } catch (error) {
                call.result = JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            orderedCalls.push(call);
            messages.push({
              id: `msg-tool-${call.id}`,
              role: "tool",
              toolCallId: call.id,
              content: call.result ?? "",
            });
          }
          // Component picks are terminal — the "UI" exists once rendered.
          if (!sawHostTool) break;
        }

        const raw: CopilotKitRaw = {
          model: COPILOTKIT_MODEL,
          text,
          toolCalls: orderedCalls,
          intents,
          events: allEvents,
        };
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

const adapter = createCopilotKitAdapter();
export default adapter;
