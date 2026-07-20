/**
 * execution-v2 Wave 8 — the in-box coding agent IS the Claude Agent SDK.
 *
 * `runAgentTask` keeps the exact engine-agnostic contract the control port
 * speaks ({prompt, context} in → {ok, summary, filesChanged, testsRun, fns?,
 * servesUi?} out) but the loop underneath is Claude Code as a library
 * (`@anthropic-ai/claude-agent-sdk` `query()`): the SDK's own agentic harness
 * with its shell + file tools, working dir /app. The Wave-3 thin custom loop
 * is deleted — the box inherits Anthropic's harness improvements instead of
 * us maintaining a homegrown one. The Wave-3 frictions are solved where they
 * belong: size at template-build time (the SDK + zod are npm-installed into
 * /opt/vendo-box when the base template is baked, never at wake), auth via
 * plain env (ANTHROPIC_API_KEY = VENDO_INFERENCE_KEY, ANTHROPIC_BASE_URL =
 * VENDO_INFERENCE_URL — BYO Anthropic and the Cloud gateway ride the same
 * two vars).
 *
 * The structured result rides an in-process MCP tool (`report_done`) so the
 * schema is enforced at the tool layer. The loop trusts nothing it cannot
 * see: the model must verify its own work (curl its fn endpoints) and report
 * honestly; the host treats the whole result as DATA (prompt-injection floor
 * — nothing in this result can approve or authorize anything host-side).
 */

const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_TURNS = 80;
const NUDGE_TURNS = 4;
const LOG_CAP = 2_000;

const truncate = (text, cap = LOG_CAP) =>
  text.length <= cap ? text : `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;

/** The box conventions, appended to the SDK's own Claude Code system prompt. */
const boxConventions = (appDir, controlPort) => `You are the coding agent living inside a Vendo app machine (the box). The app directory ${appDir} is yours: any language, any framework, any process.

Box conventions (the skin of the box):
- The app process must listen on the PORT env var, serve POST /fn/<name> endpoints answering {"result": ...} on success or {"error": {"code", "message"}} on failure, and serve GET /vendo.json returning the manifest file verbatim.
- The manifest ${appDir}/vendo.json declares schedules ({"schedules":[{"cron":"0 8 * * *","fn":"name"}]}) and outbound domains ({"egress":["api.example.com"]}). Declare every third-party domain your code fetches; undeclared egress is blocked at the network layer.
- ${appDir}/.vendo/run is the Procfile-style entry: ONE shell line that starts the app (e.g. "node server.js"). A supervisor (not you) runs it with the boundary env and restarts it when you POST http://localhost:${controlPort}/agent/restart-app.
- Durable data goes through the Vendo store, NOT the disk: curl -X PUT "$VENDO_STORE_URL/rows/<collection>/<id>" -H "authorization: Bearer $VENDO_APP_TOKEN" -H "content-type: application/json" -d '{"data": {...}}' (list with GET "$VENDO_STORE_URL/rows/<collection>"). The disk is scratch.
- Host tools ride POST "$VENDO_HOST_URL/tools/<name>" with the same bearer; approvals and audit happen host-side.

Working style:
- STRONGLY prefer zero-dependency Node: node:http for the server, the global fetch for egress, node:crypto etc. The box egress is deny-by-default, so \`npm install\` reaches only registries you DECLARE in vendo.json egress — avoid it unless the task truly needs a package.
- Verify against reality: after writing code, restart the app (curl the supervisor route above), wait a moment, then curl your own endpoints on http://localhost:$PORT and fix failures before reporting.
- Never bind $PORT from a process you spawn yourself; the supervisor owns the app process.
- End the task by calling the report_done tool EXACTLY ONCE with your honest structured result — ok=false with a clear summary beats a fake success. List the fn names you serve in fns.
- If (and only if) the task asks you to serve a real web app: serve its pages on the non-/fn paths of $PORT (GET / is the entry page), keep any /fn/<name> endpoints working beside them, curl your pages until they answer 200 with real content, and then report servesUi: true. Never claim servesUi for an fn-only task.`;

/** ANTHROPIC_BASE_URL wants the bare origin; VENDO_INFERENCE_URL may carry /v1. */
const baseUrl = (url) => url.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * The real engine: Claude Code as a library. Dynamic imports on purpose — the
 * SDK + zod live in the base box template (/opt/vendo-box/node_modules, baked
 * at build-template time), and host-side unit tests inject a fake engine so
 * they never load it.
 */
const sdkEngine = async ({ prompt, systemAppend, model, url, key, env, appDir, log, onWrite, onReport }) => {
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");

  let sessionId;
  let reported = false;
  const reportServer = createSdkMcpServer({
    name: "vendo",
    version: "1.0.0",
    tools: [
      tool(
        "report_done",
        "End the task with your honest structured result. Call exactly once, when the work is verified (or has definitively failed).",
        {
          ok: z.boolean(),
          summary: z.string(),
          filesChanged: z.array(z.string()).optional(),
          testsRun: z.number().int().optional(),
          fns: z.array(z.string()).optional().describe("The POST /fn/<name> function names the app now serves."),
          servesUi: z.boolean().optional().describe("True ONLY when the task asked for a real served web app and the app now serves verified pages (GET / answered 200) on non-/fn paths of $PORT."),
        },
        async (input) => {
          reported = true;
          onReport(input);
          return { content: [{ type: "text", text: "result recorded — you are done" }] };
        },
      ),
    ],
  });

  const options = {
    cwd: appDir,
    model,
    maxTurns: MAX_TURNS,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
    // The box IS the sandbox: every tool is pre-approved, the provider network
    // layer (deny-by-default egress) is the real boundary.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Web tools are pointless behind deny-by-default egress; subagents and
    // interactive tools have no place in a headless box task.
    disallowedTools: ["WebSearch", "WebFetch", "Task", "AskUserQuestion"],
    mcpServers: { vendo: reportServer },
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "mcp__vendo__report_done"],
    // Never read settings/CLAUDE.md from the app dir — the agent writes there.
    settingSources: [],
    env: {
      ...env,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: baseUrl(url),
      // The box blocks everything but the inference host; don't let the CLI
      // stall on telemetry/update endpoints it can never reach.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CONFIG_DIR: "/tmp/vendo-claude",
    },
  };

  const consume = async (stream) => {
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
          if (block.type === "text" && block.text.trim() !== "") log(`[assistant] ${truncate(block.text)}`);
          if (block.type === "tool_use") {
            const input = block.input ?? {};
            if (block.name === "Bash") log(`[bash] ${truncate(String(input.command ?? ""), 500)}`);
            else if (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit" || block.name === "NotebookEdit") {
              const target = String(input.file_path ?? "");
              if (target !== "") onWrite(target);
              log(`[write] ${target}`);
            } else log(`[tool] ${block.name}`);
          }
        }
      } else if (message.type === "result") {
        log(`[result] subtype=${message.subtype} turns=${message.num_turns ?? "?"} cost_usd=${message.total_cost_usd ?? "?"}`);
      }
    }
  };

  const run = (promptText, extra = {}) =>
    consume(query({ prompt: promptText, options: { ...options, ...extra } }));

  await run(prompt);

  // One nudge, mirroring the thin loop's: an agent that finished without the
  // structured result gets a short resumed turn to file it.
  if (!reported && sessionId !== undefined) {
    log("[task] no report_done — nudging once via resume");
    await run("Call the report_done tool now with your honest structured result for the task you just worked on.", {
      resume: sessionId,
      maxTurns: NUDGE_TURNS,
    });
  }
};

/**
 * Run one agent task to a structured result. Never throws for model/tool
 * failures — an exhausted or wedged engine reports {ok:false} honestly.
 */
export const runAgentTask = async ({ prompt, context, env, appDir, log, engine }) => {
  const url = env.VENDO_INFERENCE_URL;
  const key = env.VENDO_INFERENCE_KEY;
  if (typeof url !== "string" || url === "" || typeof key !== "string" || key === "") {
    return { ok: false, summary: "the box has no inference endpoint (VENDO_INFERENCE_URL/VENDO_INFERENCE_KEY missing)", filesChanged: [], testsRun: 0 };
  }
  const model = typeof env.VENDO_INFERENCE_MODEL === "string" && env.VENDO_INFERENCE_MODEL !== "" ? env.VENDO_INFERENCE_MODEL : DEFAULT_MODEL;
  const written = new Set();
  let report;
  const fullPrompt = context === undefined ? prompt : `${context}\n\nTASK:\n${prompt}`;
  log(`[task] engine=claude-agent-sdk model=${model} promptBytes=${fullPrompt.length}`);
  try {
    await (engine ?? sdkEngine)({
      prompt: fullPrompt,
      systemAppend: boxConventions(appDir, env.VENDO_CONTROL_PORT ?? "8811"),
      model,
      url,
      key,
      env,
      appDir,
      log,
      onWrite: (path) => written.add(path),
      onReport: (input) => { report = input; },
    });
  } catch (error) {
    return {
      ok: false,
      summary: `agent engine failed: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [...written],
      testsRun: 0,
    };
  }
  if (report === undefined || typeof report !== "object" || report === null) {
    return { ok: false, summary: "agent finished without calling report_done", filesChanged: [...written], testsRun: 0 };
  }
  // The injection floor: only the declared fields pass through, exactly as
  // declared — a box result is data, never authority.
  const declared = Array.isArray(report.filesChanged) ? report.filesChanged.filter((entry) => typeof entry === "string") : [];
  const result = {
    ok: report.ok === true,
    summary: typeof report.summary === "string" ? report.summary : "(no summary)",
    filesChanged: [...new Set([...written, ...declared])],
    testsRun: Number.isInteger(report.testsRun) && report.testsRun >= 0 ? report.testsRun : 0,
    ...(Array.isArray(report.fns) ? { fns: report.fns.filter((entry) => typeof entry === "string") } : {}),
    ...(report.servesUi === true ? { servesUi: true } : {}),
  };
  log(`[task] done ok=${result.ok} summary=${truncate(result.summary, 500)}`);
  return result;
};
