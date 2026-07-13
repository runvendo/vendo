import { realtimeVoiceDriver } from "@vendoai/ui/voice";

/** Maple's v0 WebRTC voice surface (08-ui §1). */
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
  instructions: "You are Maple's concise, warm banking voice assistant.",
});

// VENDO-MIGRATION: the retired voice driver supported tool calls, generated
// views, approval choreography, and a scripted no-key fallback. The frozen
// 08-ui voice seam currently carries state and transcript events only, so
// those extensions cannot be re-expressed without inventing an uncontracted
// event protocol.
