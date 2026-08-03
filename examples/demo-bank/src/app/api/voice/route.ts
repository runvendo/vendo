import { demoRequestAllowed } from "@/vendo/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";

export async function POST(req: Request): Promise<Response> {
  if (!demoRequestAllowed(req)) {
    return Response.json({ error: "voice is restricted to local demo runs" }, { status: 403 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });

  const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model: MODEL, audio: { output: { voice: VOICE } } } }),
  });
  const body = (await upstream.json().catch(() => ({}))) as { value?: string; error?: { message?: string } };
  if (!upstream.ok || !body.value) {
    return Response.json({ error: body.error?.message ?? `mint failed (${upstream.status})` }, { status: 502 });
  }
  return Response.json({ clientSecret: body.value, model: MODEL });
}
