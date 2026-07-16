/**
 * SPIKE rung 1 baseline — direct Anthropic Messages API with an explicit env
 * key (ANTHROPIC_API_KEY), streaming, no harness. This is what Vendo dev-mode
 * does today when a key exists; the riders are measured against it.
 */

import { now, type TurnMetrics } from "./metrics.js";

export async function baselineTurn(
  text: string,
  model: string,
): Promise<Omit<TurnMetrics, "rung" | "scenario" | "trial">> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("baseline needs ANTHROPIC_API_KEY (source the key file first)");

  const t0 = now();
  let ttftMs: number | null = null;
  let answer = "";
  let usage: unknown;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      stream: true,
      system: "You are Vendo's embedded product agent for a demo bank. Answer in one short sentence.",
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`baseline HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let event: { type?: string; delta?: { type?: string; text?: string }; usage?: unknown };
      try {
        event = JSON.parse(payload) as typeof event;
      } catch {
        continue;
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        if (ttftMs === null) ttftMs = now() - t0;
        answer += event.delta.text ?? "";
      }
      if (event.type === "message_delta" && event.usage) usage = event.usage;
    }
  }

  return { ttftMs, totalMs: now() - t0, model, usage, answer };
}
