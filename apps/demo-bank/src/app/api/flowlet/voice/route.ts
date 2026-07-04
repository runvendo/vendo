/**
 * POST /api/flowlet/voice — mints an ephemeral OpenAI Realtime client secret.
 *
 * This is the whole server-side footprint of voice (the OSS model's "no
 * relay"): the host backend holds OPENAI_API_KEY, hands the browser a
 * short-lived scoped credential, and audio then flows browser ⇄ provider
 * directly over WebRTC. In the packaged world this endpoint lives inside
 * `createFlowletHandler()`; Maple carries it inline as the reference host.
 * 503 with no key — the shell's mic degrades to the scripted demo.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";

export async function POST(): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "voice not configured (OPENAI_API_KEY missing)" }, { status: 503 });
  }
  const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: MODEL,
        audio: { output: { voice: VOICE } },
      },
    }),
  });
  const body = (await upstream.json().catch(() => ({}))) as { value?: string; error?: { message?: string } };
  if (!upstream.ok || !body.value) {
    console.error("[flowlet voice] client_secrets mint failed", upstream.status, body);
    return Response.json(
      { error: body.error?.message ?? `mint failed (${upstream.status})` },
      { status: 502 },
    );
  }
  return Response.json({ clientSecret: body.value, model: MODEL });
}
