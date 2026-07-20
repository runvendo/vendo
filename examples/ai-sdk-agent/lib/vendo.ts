// --- vendo: the whole server-side Vendo surface for this example lives in this
// one file — `createVendo` plus the two host actions it guards. The action
// descriptors (name, schema, risk) live in `.vendo/tools.json`, exactly where
// `vendo init` extracts them in a real app.
import { anthropic } from "@ai-sdk/anthropic";
import { createVendo } from "@vendoai/vendo/server";

/** The quickstart's weather lookup, registered as a Vendo action
 *  (`host_get_weather`, risk `read` — the cautious policy runs it and audits
 *  it). Same fake data as the AI SDK quickstart's inline tool. */
export async function getWeather(city: string) {
  const temperature = Math.round(Math.random() * (90 - 32) + 32);
  const conditions = ["sunny", "cloudy", "rainy", "snowy"][
    Math.floor(Math.random() * 4)
  ];
  return { city, temperature, conditions };
}

/** Every report "sent" — the observable side effect the approval gate holds. */
export const sentReports: Array<{ to: string; subject: string; body: string }> = [];

/** The deliberately risky action (`host_send_trip_report`, risk `write`): the
 *  cautious policy parks it for approval, the tool returns a
 *  `vendo/approval-ref@1` envelope, and the wire executes the parked call the
 *  moment the user approves in `<VendoApprovalEmbed>`. */
export async function sendTripReport(to: string, subject: string, body: string) {
  sentReports.push({ to, subject, body });
  return { delivered: true, to, subject };
}

/** This demo has no auth, so every request is the same demo user. In a real
 *  app, resolve your session's user here (or pass a `createVendo({ auth })`
 *  preset) so approvals park under the person who asked. */
export const demoUser = { kind: "user", subject: "demo-user" } as const;

export const vendo = createVendo({
  // Vendo's own model seam: powers app generation (`vendo_create_app`) and the
  // delegate. Your agent keeps its own model in app/api/chat/route.ts.
  model: anthropic("claude-sonnet-4-6"),
  principal: async () => demoUser,
  // Ask before write/destructive actions, run reads: the gate that turns
  // `host_send_trip_report` into an approval card in your own chat.
  policy: "cautious",
  // In-process dispatch for the two actions declared in .vendo/tools.json.
  serverActions: {
    "lib/vendo.ts#getWeather": getWeather,
    "lib/vendo.ts#sendTripReport": sendTripReport,
  },
});
// --- /vendo
