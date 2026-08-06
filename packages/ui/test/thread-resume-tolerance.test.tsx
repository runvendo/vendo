// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, useVendoThread, type VendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

/**
 * Stream resume against a wire that does not have it.
 *
 * `useVendoThread` asks `GET /threads/:id/stream` after it loads a transcript,
 * so a reload mid-turn rejoins instead of painting the question and nothing else.
 * But `ChatTransport.reconnectToStream` THROWS on any answer that is neither ok
 * nor 204 (`ai@6`, `HttpChatTransport.reconnectToStream`), and `AbstractChat`
 * turns that throw into the chat's error state.
 *
 * So a host still on a server version without the route — or any wire that 404s
 * it — would see a healthy thread open in an ERROR state, caused by a feature
 * that merely was not available. The fixture wire here has no such route (its
 * thread matcher is `/^\/threads\/([^/]+)$/`), which makes it exactly the older
 * deployment this has to tolerate.
 */
describe("a wire without the resume route", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url, headers: { "X-Hook-Test": "true" } });
  });

  afterEach(async () => {
    await wire.close();
  });

  function wrapper({ children }: PropsWithChildren) {
    return <VendoProvider client={client}>{children}</VendoProvider>;
  }

  it("opens the thread ready, with its transcript, instead of erroring on a resume it cannot do", async () => {
    // A transcript that ends on the user's turn — the mid-turn-reload shape,
    // the one case the hook actually probes the server to resume. The fixture
    // wire has no resume route, so the probe is refused.
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", {
      ...existing,
      messages: [...existing.messages, { id: "msg_asking", role: "user", parts: [{ type: "text", text: "Mid-turn question" }] }],
    });

    const { result } = renderHook(() => useVendoThread("thr_1"), { wrapper });
    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe("msg_asking"));

    // The ask really happened — otherwise this test proves nothing about how a
    // refused ask is handled.
    await waitFor(() =>
      expect(wire.requests).toContainEqual(
        expect.objectContaining({ method: "GET", path: "/threads/thr_1/stream" }),
      ));

    // And the refusal cost the thread nothing.
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages[0]?.id).toBe("msg_existing");
    expect(result.current.messages.at(-1)?.id).toBe("msg_asking");
  });
});
