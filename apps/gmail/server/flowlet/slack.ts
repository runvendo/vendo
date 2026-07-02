/**
 * Fires a real Slack message via Composio's REST execute endpoint — the same
 * verified path demo-bank uses (SLACK_CHAT_POST_MESSAGE as `flowlet-demo`).
 * Failures are reported truthfully; there is no fake-success fallback here:
 * the demo beat's wow moment must be real or visibly broken.
 */
import { DEMO_USER_ID } from "./principal";

const COMPOSIO_API = "https://backend.composio.dev/api/v3";

/** #general in the demo workspace (verified). Overridable for other channels. */
const GENERAL_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? "C09U93V4ER3";

export interface SlackPostResult {
  ok: boolean;
  channel: string;
  text: string;
  error?: string;
}

function resolveChannel(name: string): string {
  const clean = name.replace(/^#/, "").toLowerCase();
  if (clean === "general") return GENERAL_CHANNEL_ID;
  return name;
}

export async function postToSlack(channel: string, text: string): Promise<SlackPostResult> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return { ok: false, channel, text, error: "COMPOSIO_API_KEY not set (run via infisical)" };
  }
  try {
    const res = await fetch(`${COMPOSIO_API}/tools/execute/SLACK_CHAT_POST_MESSAGE`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: DEMO_USER_ID,
        arguments: { channel: resolveChannel(channel), text },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { successful?: boolean; error?: string };
    if (json.successful) return { ok: true, channel, text };
    return { ok: false, channel, text, error: json.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, channel, text, error: String(e) };
  }
}

export type SlackPoster = typeof postToSlack;
