/**
 * The text-channel SEAM against the real Vendo Cloud console — no stub on
 * either side.
 *
 * This repo produces two things the console has to agree with, and both are
 * exercised here for real: the `register`/`send` calls the deployment makes
 * (against the live console, with Yousef's own key), and the inbound envelope
 * the console delivers back (posted at a REAL composed `createVendo` handler on
 * a real socket, authenticated with the very secret this deployment just handed
 * the console during registration). A harness that mocks the counterparty
 * proves nothing — the only thing that can make the first half pass is the
 * console genuinely serving those routes.
 *
 * The one leg that cannot be driven from a laptop is the console ORIGINATING a
 * delivery: that needs a real phone texting the shared router number and a
 * publicly reachable deployment URL. What is proven here instead is that the
 * envelope this deployment accepts is the envelope the frozen contract names,
 * on the secret the console was actually given.
 *
 * Gated on `VENDO_API_KEY` having content, like every other `.live.test.ts`:
 * skipped without it, so CI and a keyless clone stay green. `VENDO_CLOUD_URL`
 * overrides the mount for a staging console.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { VendoError, type Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterAll, expect, it, describe } from "vitest";
import { channelInboundSecret, cloudTextChannel } from "../src/channels.js";
import { createVendo } from "../src/server.js";

// A named secret can EXIST and be empty (`infisical secrets get` exits 0 either
// way), so the gate checks for content rather than for presence.
const apiKey = process.env["VENDO_API_KEY"] ?? "";
const live = apiKey === "" ? describe.skip : describe;

const LIVE_TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, LIVE_TIMEOUT_MS);

const principal: Principal = { kind: "user", subject: `user_live_${globalThis.crypto.randomUUID().slice(0, 8)}` };

const channels = (): ReturnType<typeof cloudTextChannel> => cloudTextChannel({
  apiKey,
  ...(process.env["VENDO_CLOUD_URL"] === undefined ? {} : { baseUrl: process.env["VENDO_CLOUD_URL"] }),
});

/** The deployment side, on a real socket: the composed wire, its own store, and
 *  the door the console is about to be told about. */
async function deployment(): Promise<{ url: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-live-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    harness: defineHarness({
      name: "channel-live-probe",
      // eslint-disable-next-line require-yield
      async *run() {
        yield { type: "text", delta: "ok" };
      },
    }) as never,
    channels: { text: true },
  } as Parameters<typeof createVendo>[0]);

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      void (async () => {
        const response = await vendo.handler(new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body === "" ? {} : { body }),
        }));
        res.statusCode = response.status;
        res.end(await response.text());
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
}

live("the text channel, against the real console", () => {
  it("registers this deployment's door and learns a real identity to text", async () => {
    const { url } = await deployment();
    const identity = await channels().register({ url, secret: await channelInboundSecret(apiKey) });

    // The frozen contract's answer, field for field.
    expect(typeof identity.identityId).toBe("string");
    expect(typeof identity.handle).toBe("string");
    expect(identity.number).toMatch(/^\+\d{10,15}$/);
    expect(identity.connectCommand).toContain(identity.handle);
  }, LIVE_TIMEOUT_MS);

  it("delivers the frozen inbound envelope to the door it registered", async () => {
    const { url } = await deployment();
    const secret = await channelInboundSecret(apiKey);
    await channels().register({ url, secret });

    // Exactly the shape the console sends, on exactly the secret it was given.
    const delivery = await fetch(`${url}/api/vendo/channels/text/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        eventId: `evt_live_${globalThis.crypto.randomUUID()}`,
        channel: "text",
        from: "+15555550123",
        text: "hello",
        conversationId: `conv_live_${globalThis.crypto.randomUUID()}`,
        receivedAt: new Date().toISOString(),
      }),
    });
    expect(delivery.status).toBe(202);
    expect(await delivery.json()).toEqual({ ok: true });

    // And a secret that is not the registered one is refused.
    const forged = await fetch(`${url}/api/vendo/channels/text/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-the-secret" },
      body: JSON.stringify({
        eventId: "evt_live_forged",
        channel: "text",
        from: "+15555550123",
        text: "hello",
        conversationId: "conv_live_forged",
        receivedAt: new Date().toISOString(),
      }),
    });
    expect(forged.status).toBe(401);
  }, LIVE_TIMEOUT_MS);

  it("relays one outbound message through the real console", async () => {
    // No live conversation exists without a real phone having texted the
    // router, so this proves the ROUTE and the error envelope rather than a
    // delivered message: the console answers a wire-legal refusal for an
    // unknown conversation, never a transport failure or an HTML 404.
    await expect(channels().send({
      conversationId: `conv_live_${globalThis.crypto.randomUUID()}`,
      text: "vendo live seam probe",
    })).rejects.toBeInstanceOf(VendoError);
  }, LIVE_TIMEOUT_MS);
});
