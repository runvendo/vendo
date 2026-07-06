/**
 * A configured provider whose optional peer isn't installed (OPENAI_API_KEY
 * set but @ai-sdk/openai missing) must degrade like the no-key ladder state —
 * capabilities chat:false, non-chat routes healthy, chat 503 with the
 * actionable install hint — not 500 every route at first assembly.
 * Isolated in its own file because it mocks ./model module-wide.
 */
import { describe, expect, it, vi } from "vitest";

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  resolveModel,
}));

import { createVendoFetchHandler } from "./fetch-handler";
import { ModelPeerMissingError } from "./model";

const PEER_HINT =
  "OPENAI_API_KEY selects openai, which requires @ai-sdk/openai — run: npm i @ai-sdk/openai";

function makeHandler() {
  resolveModel.mockRejectedValue(new ModelPeerMissingError(PEER_HINT));
  return createVendoFetchHandler({ automations: false });
}

describe("missing optional provider peer", () => {
  it("GET /capabilities answers 200 with chat:false instead of a 500", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = makeHandler();
    const res = await handler(new Request("http://localhost/api/vendo/capabilities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chat: boolean };
    expect(body.chat).toBe(false);
    // The hint must still reach the developer loudly, server-side.
    expect(err.mock.calls.flat().join("\n")).toMatch(/@ai-sdk\/openai/);
    err.mockRestore();
  });

  it("POST /chat answers 503 with the actionable install hint", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = makeHandler();
    const res = await handler(
      new Request("http://localhost/api/vendo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "c1", messages: [] }),
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/@ai-sdk\/openai/);
    err.mockRestore();
  });
});
