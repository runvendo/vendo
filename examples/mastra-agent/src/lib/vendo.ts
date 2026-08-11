// --- vendo: touch 1 of 4 — the Vendo composition. One createVendo call; the
// weather agent's loop, model, and UI stay Mastra's — Vendo brings guarded
// host actions, generated UI, and approvals ("Vendo minus the conversation").
// Action descriptors (name, schema, risk) live in `.vendo/tools.json`, exactly
// where `vendo init` extracts them in a real app.
import { openai } from "@ai-sdk/openai";
import type { Principal } from "@vendoai/core";
import { createVendo, guard, type Vendo } from "@vendoai/vendo/server";
import { getWeather, sendTripReport } from "./vendo-actions";

/** The demo runs as one fixed user. A real host resolves the principal from
 *  its own session (or passes an auth preset — see docs/quickstart.md). */
export const DEMO_PRINCIPAL: Principal = { kind: "user", subject: "demo-user" };

/** Whether this environment carries a usable OpenAI credential — NON-BLANK, not
 *  merely present. `export OPENAI_API_KEY=` is an ordinary thing to have in a
 *  shell or a .env file, and an empty key that still named the model seat would
 *  preempt the `VENDO_API_KEY` fallback that was about to fill it correctly, then
 *  fail the turn against OpenAI with no credential at all. This is the same rule
 *  the SDK's own detection uses, so "set" means one thing on both sides. */
export function hasOpenAiCredential(env: Record<string, string | undefined> = process.env): boolean {
  return (env["OPENAI_API_KEY"] ?? "").trim() !== "";
}

export function composeVendo(overrides?: Parameters<typeof createVendo>[0]): Vendo {
  return createVendo({
    principal: async () => DEMO_PRINCIPAL,
    // "cautious" runs reads and asks before write/destructive calls — that is
    // what parks vendo_send_trip_report on the approval embed in the demo.
    guard: guard({ policy: "cautious" }),
    // The registration map for .vendo/tools.json's server-action bindings.
    serverActions: {
      "src/lib/vendo-actions.ts#getWeather": getWeather,
      "src/lib/vendo-actions.ts#sendTripReport": sendTripReport,
    },
    // Two models, two credentials — and each is CHOSEN here, not sniffed from
    // the environment. Vendo's own turns (app generation, the delegate) take the
    // same OpenAI model the weather agent thinks on, so the one OPENAI_API_KEY
    // this example asks for covers both; `@ai-sdk/openai` reads that key itself.
    // With no OpenAI key the seat stays unset, and VENDO_API_KEY fills it with
    // the Vendo Cloud gateway. With neither, the first generation says so — and
    // "no key" means blank as well as absent (see hasOpenAiCredential).
    ...(hasOpenAiCredential() ? { models: { default: openai("gpt-4.1-mini") } } : {}),
    ...overrides,
  });
}

export const vendo = composeVendo();
// --- /vendo
