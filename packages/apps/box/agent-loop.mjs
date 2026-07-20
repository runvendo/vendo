/**
 * execution-v2 Wave 3 — the in-box coding agent loop.
 *
 * A deliberately thin agentic loop over the Anthropic-compatible Messages API
 * (VENDO_INFERENCE_URL/KEY — BYO Anthropic key today, the Cloud gateway rides
 * the same door in Wave 5): shell + file tools inside the box, structured
 * completion via a `report_done` tool. FALLBACK NOTE (loud, per the Wave-3
 * charter): this is the thin-loop engine, not the Claude Agent SDK harness —
 * the SDK's CLI-sized install and key plumbing fought the base-template
 * budget; the control-port protocol is engine-agnostic, so the SDK can slot in
 * behind runAgentTask without touching the host side.
 *
 * The loop trusts nothing it cannot see: the model must verify its own work
 * (curl its fn endpoints) and report honestly; the host treats the whole
 * result as DATA (prompt-injection floor — nothing in this result can approve
 * or authorize anything host-side).
 */
import { exec } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_STEPS = 80;
const MAX_OUTPUT_TOKENS = 16_384;
const BASH_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_CAP = 16_384;
const API_ATTEMPTS = 4;

const TOOLS = [
  {
    name: "bash",
    description: "Run one shell command inside the box (cwd /app, 120s timeout). stdout+stderr come back truncated.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description: "Write a file (parent directories are created). Paths resolve inside the app directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file (truncated to 16KB).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List a directory's entries.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "report_done",
    description: "End the task with your honest structured result. Call exactly once, when the work is verified (or has definitively failed).",
    input_schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        summary: { type: "string" },
        filesChanged: { type: "array", items: { type: "string" } },
        testsRun: { type: "integer" },
        fns: {
          type: "array",
          items: { type: "string" },
          description: "The POST /fn/<name> function names the app now serves.",
        },
        servesUi: {
          type: "boolean",
          description: "True ONLY when the task asked for a real served web app and the app now serves verified pages (GET / answered 200) on non-/fn paths of $PORT.",
        },
      },
      required: ["ok", "summary"],
    },
  },
];

const systemPrompt = (appDir) => `You are the coding agent living inside a Vendo app machine (the box). The app directory ${appDir} is yours: any language, any framework, any process.

Box conventions (the skin of the box):
- The app process must listen on the PORT env var, serve POST /fn/<name> endpoints answering {"result": ...} on success or {"error": {"code", "message"}} on failure, and serve GET /vendo.json returning the manifest file verbatim.
- The manifest ${appDir}/vendo.json declares schedules ({"schedules":[{"cron":"0 8 * * *","fn":"name"}]}) and outbound domains ({"egress":["api.example.com"]}). Declare every third-party domain your code fetches; undeclared egress is blocked at the network layer.
- ${appDir}/.vendo/run is the Procfile-style entry: ONE shell line that starts the app (e.g. "node server.js"). A supervisor (not you) runs it with the boundary env and restarts it when you POST http://localhost:${process.env.VENDO_CONTROL_PORT ?? 8811}/agent/restart-app.
- Durable data goes through the Vendo store, NOT the disk: curl -X PUT "$VENDO_STORE_URL/rows/<collection>/<id>" -H "authorization: Bearer $VENDO_APP_TOKEN" -H "content-type: application/json" -d '{"data": {...}}' (list with GET "$VENDO_STORE_URL/rows/<collection>"). The disk is scratch.
- Host tools ride POST "$VENDO_HOST_URL/tools/<name>" with the same bearer; approvals and audit happen host-side.

Working style:
- STRONGLY prefer zero-dependency Node: node:http for the server, the global fetch for egress, node:crypto etc. The box egress is deny-by-default, so \`npm install\` reaches only registries you DECLARE in vendo.json egress — avoid it unless the task truly needs a package.
- Verify against reality: after writing code, restart the app (curl the supervisor route above), wait a moment, then curl your own endpoints on http://localhost:$PORT and fix failures before reporting.
- Verify efficiently: batch related checks into ONE bash call (chain curls with && or a short inline script) instead of one command per turn — every extra turn costs a full model round trip. Two or three batched verification turns usually suffice; do not keep re-checking what already passed.
- Never bind $PORT from a process you spawn yourself; the supervisor owns the app process.
- Report honestly with report_done: ok=false with a clear summary beats a fake success. List the fn names you serve in fns.
- If (and only if) the task asks you to serve a real web app: serve its pages on the non-/fn paths of $PORT (GET / is the entry page), keep any /fn/<name> endpoints working beside them, curl your pages until they answer 200 with real content, and then report servesUi: true. Never claim servesUi for an fn-only task.`;

const truncate = (text, cap = TOOL_OUTPUT_CAP) =>
  text.length <= cap ? text : `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;

const resolveInside = (appDir, candidate) => {
  const resolved = path.resolve(appDir, candidate);
  return resolved;
};

const runBash = (command, appDir, env) => new Promise((resolve) => {
  exec(command, { cwd: appDir, env, timeout: BASH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, shell: "/bin/bash" }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
    const timedOut = error !== null && error.killed === true;
    resolve(`exit ${code}${timedOut ? " (timed out)" : ""}\n${truncate(`${stdout}${stderr === "" ? "" : `\n--- stderr ---\n${stderr}`}`)}`);
  });
});

const messagesUrl = (base) => {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
};

const callModel = async (config, messages, log) => {
  const backoffMs = Number(config.retryMs ?? 2_000);
  let lastError;
  for (let attempt = 0; attempt < API_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(messagesUrl(config.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: config.system,
          tools: TOOLS,
          messages,
        }),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`inference returned ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
        continue;
      }
      if (!response.ok) {
        throw new Error(`inference returned ${response.status}: ${truncate(await response.text(), 500)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      log(`[model] attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("inference unavailable");
};

/**
 * Run one agent task to a structured result. Never throws for model/tool
 * failures — an exhausted or wedged loop reports {ok:false} honestly.
 */
export const runAgentTask = async ({ prompt, context, env, appDir, log }) => {
  const url = env.VENDO_INFERENCE_URL;
  const key = env.VENDO_INFERENCE_KEY;
  if (typeof url !== "string" || url === "" || typeof key !== "string" || key === "") {
    return { ok: false, summary: "the box has no inference endpoint (VENDO_INFERENCE_URL/VENDO_INFERENCE_KEY missing)", filesChanged: [], testsRun: 0 };
  }
  const config = {
    url,
    key,
    model: typeof env.VENDO_INFERENCE_MODEL === "string" && env.VENDO_INFERENCE_MODEL !== "" ? env.VENDO_INFERENCE_MODEL : DEFAULT_MODEL,
    system: systemPrompt(appDir),
    ...(env.VENDO_INFERENCE_RETRY_MS === undefined ? {} : { retryMs: env.VENDO_INFERENCE_RETRY_MS }),
  };
  const written = new Set();
  const messages = [{
    role: "user",
    content: context === undefined ? prompt : `${context}\n\nTASK:\n${prompt}`,
  }];
  log(`[task] model=${config.model} promptBytes=${messages[0].content.length}`);

  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    let reply;
    try {
      reply = await callModel(config, messages, log);
    } catch (error) {
      return {
        ok: false,
        summary: `inference failed: ${error instanceof Error ? error.message : String(error)}`,
        filesChanged: [...written],
        testsRun: 0,
      };
    }
    const content = Array.isArray(reply.content) ? reply.content : [];
    for (const block of content) {
      if (block.type === "text" && block.text.trim() !== "") log(`[assistant] ${truncate(block.text, 2_000)}`);
    }
    const toolUses = content.filter((block) => block.type === "tool_use");
    const done = toolUses.find((block) => block.name === "report_done");
    if (done !== undefined) {
      const input = done.input ?? {};
      const declared = Array.isArray(input.filesChanged) ? input.filesChanged.filter((entry) => typeof entry === "string") : [];
      const result = {
        ok: input.ok === true,
        summary: typeof input.summary === "string" ? input.summary : "(no summary)",
        filesChanged: [...new Set([...written, ...declared])],
        testsRun: Number.isInteger(input.testsRun) && input.testsRun >= 0 ? input.testsRun : 0,
        ...(Array.isArray(input.fns) ? { fns: input.fns.filter((entry) => typeof entry === "string") } : {}),
        ...(input.servesUi === true ? { servesUi: true } : {}),
      };
      log(`[task] done ok=${result.ok} summary=${truncate(result.summary, 500)}`);
      return result;
    }
    if (toolUses.length === 0) {
      if (nudged) {
        return { ok: false, summary: "agent stopped without calling report_done", filesChanged: [...written], testsRun: 0 };
      }
      nudged = true;
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: "Continue with tool calls, and end by calling report_done with your structured result." });
      continue;
    }
    messages.push({ role: "assistant", content });
    const results = [];
    for (const use of toolUses) {
      const input = use.input ?? {};
      let output;
      try {
        if (use.name === "bash") {
          log(`[bash] ${input.command}`);
          output = await runBash(String(input.command ?? ""), appDir, env);
        } else if (use.name === "write_file") {
          const target = resolveInside(appDir, String(input.path ?? ""));
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, String(input.content ?? ""));
          written.add(target);
          log(`[write] ${target} (${String(input.content ?? "").length} bytes)`);
          output = `wrote ${target}`;
        } else if (use.name === "read_file") {
          output = truncate(readFileSync(resolveInside(appDir, String(input.path ?? "")), "utf8"));
        } else if (use.name === "list_dir") {
          output = readdirSync(resolveInside(appDir, String(input.path ?? "."))).join("\n");
        } else {
          output = `unknown tool: ${use.name}`;
        }
      } catch (error) {
        output = `tool failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: truncate(output) });
    }
    messages.push({ role: "user", content: results });
  }
  return { ok: false, summary: `agent did not finish within ${MAX_STEPS} steps`, filesChanged: [...written], testsRun: 0 };
};
