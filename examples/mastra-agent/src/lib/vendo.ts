// --- vendo: touch 1 of 4 — the Vendo composition. One createVendo call; the
// weather agent's loop, model, and UI stay Mastra's — Vendo brings guarded
// host actions, generated UI, and approvals ("Vendo minus the conversation").
// Action descriptors (name, schema, risk) live in `.vendo/tools.json`, exactly
// where `vendo init` extracts them in a real app.
import type { Principal } from "@vendoai/core";
import { createVendo, type Vendo } from "@vendoai/vendo/server";
import { getWeather, sendTripReport } from "./vendo-actions";

/** The demo runs as one fixed user. A real host resolves the principal from
 *  its own session (or passes an auth preset — see docs/quickstart.md). */
export const DEMO_PRINCIPAL: Principal = { kind: "user", subject: "demo-user" };

export function composeVendo(overrides?: Parameters<typeof createVendo>[0]): Vendo {
  return createVendo({
    principal: async () => DEMO_PRINCIPAL,
    // "cautious" runs reads and asks before write/destructive calls — that is
    // what parks vendo_send_trip_report on the approval embed in the demo.
    policy: "cautious",
    // The registration map for .vendo/tools.json's server-action bindings.
    serverActions: {
      "src/lib/vendo-actions.ts#getWeather": getWeather,
      "src/lib/vendo-actions.ts#sendTripReport": sendTripReport,
    },
    // No model key here: app generation resolves ANTHROPIC_API_KEY /
    // OPENAI_API_KEY / VENDO_API_KEY from the environment (docs/quickstart.md).
    ...overrides,
  });
}

export const vendo = composeVendo();
