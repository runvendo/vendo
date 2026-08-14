import { VendoError } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret, cloudTextChannel } from "../src/channels.js";
import { selectChannels } from "../src/compose-channels.js";

/**
 * The channels SELECTION LADDER, and the sentence each rung says out loud.
 *
 * The failure this pins is the `connectorApps` trap in its channel spelling: a
 * host writes `channels: { text: true }`, has no Cloud key, and gets a
 * deployment that composes nothing and says nothing — so the anchor they added
 * silently does nothing forever. Asking for a channel with no way to carry it
 * has to REFUSE, by name. Not asking for one has to stay silent.
 */

const refusal = async (call: () => Promise<unknown>): Promise<VendoError> => {
  try {
    await call();
  } catch (error) {
    if (error instanceof VendoError) return error;
    throw error;
  }
  throw new Error("expected the unconfigured channel to refuse");
};

beforeEach(() => {
  // The ladder reads the key itself; a developer's real key in the ambient env
  // must never decide what this suite observes.
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("VENDO_CLOUD_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("selectChannels — the adapter ladder", () => {
  it("composes nothing, silently, when the host never asked for a channel", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_live_present");
    for (const configured of [undefined, {}, { text: false }] as const) {
      const channels = selectChannels(configured);
      expect(channels.posture).toBe(false);
      // The default sentence — generic setup guidance, not an accusation: this
      // deployment never asked for a channel, so nothing is wrong with it.
      const error = await refusal(() => channels.send({ conversationId: "c1", text: "hi" }));
      expect(error.code).toBe("not-implemented");
      expect(error.message).toContain("channels: { text: true }");
    }
  });

  it("refuses BY NAME when the host asked for text with no Cloud key", async () => {
    const channels = selectChannels({ text: true });
    expect(channels.posture).toBe(false);
    const error = await refusal(() => channels.register({ url: "https://host.test", secret: "s" }));
    expect(error.code).toBe("not-implemented");
    expect(error.message).toContain("VENDO_API_KEY");
    expect(error.message).toContain("channels: { text: true }");
  });

  it("composes the Cloud adapter when the key is there", () => {
    vi.stubEnv("VENDO_API_KEY", "vk_live_present");
    expect(selectChannels({ text: true }).posture).toBe("cloud");
  });
});

describe("cloudTextChannel — the frozen wire, from this side", () => {
  it("registers and sends over the two console routes, bearing the deployment key", async () => {
    const calls: Array<{ path: string; auth: string | null; body: unknown }> = [];
    const channels = cloudTextChannel({
      apiKey: "vk_live_abc",
      baseUrl: "https://console.test",
      fetch: async (input, init) => {
        calls.push({
          path: new URL(String(input)).pathname,
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return Response.json(
          calls.length === 1
            ? { identityId: "tid_1", handle: "maple", number: "+15550000000", connectCommand: "connect @maple" }
            : { ok: true },
        );
      },
    });

    const identity = await channels.register({ url: "https://maple.test", secret: "sec" });
    expect(identity).toEqual({
      identityId: "tid_1",
      handle: "maple",
      number: "+15550000000",
      connectCommand: "connect @maple",
    });
    await channels.send({ conversationId: "conv_1", text: "two invoices are due" });

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/channels/text/register",
      "/api/v1/channels/text/send",
    ]);
    expect(new Set(calls.map((call) => call.auth))).toEqual(new Set(["Bearer vk_live_abc"]));
    expect(calls[0]?.body).toEqual({ url: "https://maple.test", secret: "sec" });
    expect(calls[1]?.body).toEqual({ conversationId: "conv_1", text: "two invoices are due" });
  });

  it("fails loudly on a registration that carries no identity to text", async () => {
    const channels = cloudTextChannel({
      apiKey: "vk_live_abc",
      fetch: async () => Response.json({ ok: true }),
    });
    const error = await refusal(() => channels.register({ url: "https://maple.test", secret: "sec" }));
    expect(error.code).toBe("validation");
  });

  it("never reads the environment — the ladder above does", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_live_env_key_that_must_not_win");
    const channels = cloudTextChannel({
      apiKey: "vk_live_passed",
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer vk_live_passed");
        return Response.json({ ok: true });
      },
    });
    await channels.send({ conversationId: "conv_1", text: "hello" });
  });
});

describe("the inbound secret", () => {
  it("is a stable derivation of the deployment's key, and only of that key", async () => {
    const [first, again, other] = await Promise.all([
      channelInboundSecret("vk_live_abc"),
      channelInboundSecret("vk_live_abc"),
      channelInboundSecret("vk_live_xyz"),
    ]);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    // A hex SHA-256 digest, and never the key itself.
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("vk_live_abc");
  });
});
