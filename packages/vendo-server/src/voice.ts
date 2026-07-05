/**
 * POST /voice/session — mint an ephemeral OpenAI Realtime client secret.
 *
 * The browser receives only the scoped, short-lived credential; the host's
 * OPENAI_API_KEY never leaves this server route. The caller guard lives in
 * fetch-handler.ts so voice mints share the same spend boundary as chat/action.
 */

const DEFAULT_REALTIME_MODEL = "gpt-realtime";
const DEFAULT_REALTIME_VOICE = "marin";
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export interface VoiceSessionDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function handleVoiceSessionPost(_req: Request, deps: VoiceSessionDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const apiKey = present(env["OPENAI_API_KEY"]);
  if (!apiKey) {
    return Response.json({ error: "voice not configured (OPENAI_API_KEY missing)" }, { status: 503 });
  }

  const model = present(env["OPENAI_REALTIME_MODEL"]) ?? DEFAULT_REALTIME_MODEL;
  const voice = present(env["OPENAI_REALTIME_VOICE"]) ?? DEFAULT_REALTIME_VOICE;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let upstream: Response;
  try {
    upstream = await fetchImpl(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          audio: { output: { voice } },
        },
      }),
    });
  } catch (err) {
    console.error("[vendo voice] client_secrets mint failed", err);
    return Response.json({ error: "mint failed" }, { status: 502 });
  }

  const body = (await upstream.json().catch(() => ({}))) as {
    value?: string;
    error?: { message?: string };
  };
  if (!upstream.ok || !body.value) {
    console.error("[vendo voice] client_secrets mint failed", upstream.status, body);
    return Response.json(
      { error: body.error?.message ?? `mint failed (${upstream.status})` },
      { status: 502 },
    );
  }

  return Response.json({ clientSecret: body.value, model });
}
