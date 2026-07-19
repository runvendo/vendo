import { createVendoClient } from "@vendoai/ui";
import { createVoiceActBridge, realtimeVoiceDriver } from "@vendoai/ui/voice";

/** Maple's v0 WebRTC voice surface (08-ui §1), with the ENG-319 live pipeline:
 * the realtime model acts through Vendo mid-call via the `vendo_act` bridge —
 * views land in the stage feed, approvals park in the guard queue and reach
 * the stage's consent bar. */
export const mapleRealtimeVoiceDriver = realtimeVoiceDriver({
  getSession: async () => {
    const response = await fetch("/api/voice", { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as {
      clientSecret?: string;
      model?: string;
      error?: string;
    };
    if (!response.ok || !body.clientSecret) {
      throw new Error(body.error ?? `voice session failed (${response.status})`);
    }
    return { clientSecret: body.clientSecret, model: body.model };
  },
  instructions:
    "You are Maple's concise, warm banking voice assistant. Use the vendo_act tool for anything "
    + "that touches the user's accounts, transactions, views or messages — describe the action in "
    + "plain language and speak from its result. Anything needing permission is asked on screen; "
    + "tell the user to look at the consent card when the result says so.",
  act: createVoiceActBridge({ client: createVendoClient({ baseUrl: "/api/vendo" }) }),
});
