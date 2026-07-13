import { createAnthropic } from "@ai-sdk/anthropic";
import { createVendo, type Vendo } from "@vendoai/vendo/server";
import type { Principal, VendoStore } from "@vendoai/vendo";
import type { LanguageModel } from "ai";

const RELAY_PRINCIPAL: Principal = {
  kind: "user",
  subject: "relay-demo-user",
  display: "Relay demo user",
};

export interface RelayVendoOptions {
  model?: LanguageModel;
  store?: VendoStore;
}

function productionModel(): LanguageModel {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic(process.env.VENDO_MODEL ?? "claude-sonnet-4-6");
}

export function createRelayVendo(options: RelayVendoOptions = {}): Vendo {
  return createVendo({
    model: options.model ?? productionModel(),
    // Loopback-only single-user fixture: one fixed demo principal is intentional.
    principal: async () => RELAY_PRINCIPAL,
    ...(options.store === undefined ? {} : { store: options.store }),
    policy: { file: ".vendo/policy.json" },
    telemetry: false,
  });
}
