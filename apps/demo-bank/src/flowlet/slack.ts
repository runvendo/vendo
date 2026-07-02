/**
 * Fires a real Slack message via Composio (the verified REST execute endpoint).
 * On failure it reports the failure truthfully (`ok: false, fallback: false`).
 * Set `FLOWLET_STAGE_FALLBACK=1` to opt into the canned "posted" fallback for
 * stage reliability — off by default so the demo never silently claims success.
 */
import { DEMO_USER_ID } from "./principal"

const COMPOSIO_API = "https://backend.composio.dev/api/v3"

/** Whether to fake a successful post on failure (stage reliability crutch). */
const stageFallback = () => process.env.FLOWLET_STAGE_FALLBACK === "1"
/** #general in the demo workspace (verified). Overridable for other channels. */
const GENERAL_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? "C09U93V4ER3"

export interface SlackFireResult {
  ok: boolean
  fallback: boolean
  channel: string
  text: string
  error?: string
}

function resolveChannel(name: string): string {
  const clean = name.replace(/^#/, "").toLowerCase()
  if (clean === "general") return GENERAL_CHANNEL_ID
  return name
}

export async function postToSlack(channel: string, text: string): Promise<SlackFireResult> {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    return { ok: false, fallback: stageFallback(), channel, text, error: "COMPOSIO_API_KEY not set" }
  }
  try {
    const res = await fetch(`${COMPOSIO_API}/tools/execute/SLACK_CHAT_POST_MESSAGE`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: DEMO_USER_ID,
        arguments: { channel: resolveChannel(channel), text },
      }),
    })
    const json = (await res.json().catch(() => ({}))) as { successful?: boolean; error?: string }
    if (json.successful) return { ok: true, fallback: false, channel, text }
    return { ok: false, fallback: stageFallback(), channel, text, error: json.error ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, fallback: stageFallback(), channel, text, error: String(e) }
  }
}

export type Poster = (channel: string, text: string) => Promise<SlackFireResult>
