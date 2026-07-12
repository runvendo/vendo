/**
 * POST /voice/session — mint an ephemeral OpenAI Realtime client secret.
 *
 * The browser receives only the scoped, short-lived credential; the host's
 * OPENAI_API_KEY never leaves this server route. The caller guard lives in
 * fetch-handler.ts so voice mints share the same spend boundary as chat/action.
 */
import { createHmac } from "node:crypto";
import type { VendoPrincipal } from "@vendoai/runtime";

const DEFAULT_REALTIME_MODEL = "gpt-realtime";
const DEFAULT_REALTIME_VOICE = "marin";
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export interface VoiceSessionDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  principal?: VendoPrincipal;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safetyIdentifier(principal: VendoPrincipal | undefined, env: Record<string, string | undefined>, apiKey: string): string | undefined {
  if (!principal?.userId) return undefined;
  const key = present(env["VENDO_OPENAI_SAFETY_SALT"]) ?? apiKey;
  const digest = createHmac("sha256", key).update(principal.userId).digest("hex");
  // OpenAI caps OpenAI-Safety-Identifier at 64 chars; `vendo_` + a full
  // 64-hex digest is 70 and gets rejected (400 -> mint 502). Clamp to 64.
  return `vendo_${digest}`.slice(0, 64);
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
  const safetyId = safetyIdentifier(deps.principal, env, apiKey);

  let upstream: Response;
  try {
    upstream = await fetchImpl(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {}),
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          audio: { output: { voice } },
        },
      }),
    });
  } catch (err) {
    console.error("[vendo voice] client_secrets mint failed", { error: err instanceof Error ? err.name : "unknown" });
    return Response.json({ error: "mint failed" }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("[vendo voice] client_secrets mint failed", {
      status: upstream.status,
      requestId: upstream.headers.get("x-request-id") ?? upstream.headers.get("openai-request-id") ?? undefined,
    });
    return Response.json({ error: "mint failed" }, { status: 502 });
  }

  const body = (await upstream.json().catch(() => ({}))) as { value?: string };
  if (!body.value) {
    console.error("[vendo voice] client_secrets mint failed", {
      status: upstream.status,
      requestId: upstream.headers.get("x-request-id") ?? upstream.headers.get("openai-request-id") ?? undefined,
    });
    return Response.json({ error: "mint failed" }, { status: 502 });
  }

  return Response.json({ clientSecret: body.value, model });
}
