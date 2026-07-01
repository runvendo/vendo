/**
 * Fires a real Slack message via Composio (the verified REST execute endpoint).
 * On any failure it returns a `fallback` result so the poller can still report
 * "posted" on screen — the canned fallback for stage reliability.
 */
const COMPOSIO_API = "https://backend.composio.dev/api/v3"
const USER_ID = "flowlet-demo"
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
    return { ok: false, fallback: true, channel, text, error: "COMPOSIO_API_KEY not set" }
  }
  try {
    const res = await fetch(`${COMPOSIO_API}/tools/execute/SLACK_CHAT_POST_MESSAGE`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: USER_ID,
        arguments: { channel: resolveChannel(channel), text },
      }),
    })
    const json = (await res.json().catch(() => ({}))) as { successful?: boolean; error?: string }
    if (json.successful) return { ok: true, fallback: false, channel, text }
    return { ok: false, fallback: true, channel, text, error: json.error ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, fallback: true, channel, text, error: String(e) }
  }
}

export type Poster = (channel: string, text: string) => Promise<SlackFireResult>
