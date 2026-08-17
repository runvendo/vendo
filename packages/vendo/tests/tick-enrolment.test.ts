/**
 * SELF-ENROLMENT: how a deployment tells Vendo Cloud where its firing door is
 * and which secret will sign the knock. Nobody configures either — the secret is
 * derived from the deployment's own VENDO_API_KEY — and without the call there is
 * no failure to see: the deployment is healthy, its automations are armed, and
 * Cloud has no URL to knock on, so nothing ever fires.
 *
 * The secret is proven against the SHIPPED verifier (`verifySignature` in
 * @vendoai/automations) as the oracle, signed the way Cloud's heartbeat actually
 * signs — HMAC over `${webhook-id}.${webhook-timestamp}.` keyed on the secret's
 * base64url-DECODED BYTES. A derivation that only satisfied a scheme restated
 * here would still have answered 401 to every knock in the fleet; that mistake
 * has been made twice on this seam, once on each side.
 */
import { signedWebhookBytes, verifySignature } from "@vendoai/automations";
import { setLogger, type VendoLogEvent } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTickSecret, enrolForTicks, tickSecret } from "../src/tick-enrolment.js";

const API_KEY = `vnd_${"a".repeat(40)}`;

const events: VendoLogEvent[] = [];
afterEach(() => {
  events.length = 0;
  setLogger(undefined);
  vi.unstubAllEnvs();
});

const capture = (): void => setLogger((event) => void events.push(event));

/** One captured request, the only thing enrolment is allowed to send. */
interface Sent { url: string; init: RequestInit }
const recorder = (response: () => Response): { sent: Sent[]; fetch: typeof fetch } => {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return response();
    }) as typeof fetch,
  };
};

const ok = (): Response => new Response(JSON.stringify({ ok: {} }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const enrol = (options: Partial<Parameters<typeof enrolForTicks>[0]>): Promise<void> => enrolForTicks({
  cloud: { apiKey: API_KEY },
  automationsMounted: true,
  development: false,
  publicUrl: new URL("https://maple.example.com/"),
  ...options,
});

describe("the derived tick secret", () => {
  it("is the same value every time, so two replicas cannot register different secrets", async () => {
    const [first, second] = await Promise.all([deriveTickSecret(API_KEY), deriveTickSecret(API_KEY)]);

    expect(first).toBe(second);
    expect(first).toBe(await deriveTickSecret(API_KEY));
    // A different deployment's key is a different secret — the derivation is not
    // a constant dressed up as one.
    expect(await deriveTickSecret(`${API_KEY}z`)).not.toBe(first);
  });

  it("verifies a knock signed exactly the way Cloud's heartbeat signs one", async () => {
    const secret = await deriveTickSecret(API_KEY);
    const id = "msg_heartbeat_enrolled";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    // The SHIPPED signed bytes, not a string built here.
    const body = new Uint8Array(signedWebhookBytes(id, timestamp, new Uint8Array()));

    // Cloud's `sign()` (vendo-web lib/automations/heartbeat.ts) keys the HMAC on
    // `Buffer.from(secret, "base64url")` — the DECODED BYTES.
    const key = await crypto.subtle.importKey(
      "raw", Buffer.from(secret, "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, body);

    // ORACLE — the artifact the deployment's own door calls says this is good.
    expect(await verifySignature(secret, btoa(String.fromCharCode(...new Uint8Array(mac))), body)).toBe(true);

    // And the mistake this pins: keying on the secret's CHARACTERS produces a
    // signature the shipped verifier rejects. A derivation that only agreed with
    // a local restatement of the scheme could not tell these two apart.
    const characterKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const wrong = await crypto.subtle.sign("HMAC", characterKey, body);
    expect(await verifySignature(secret, btoa(String.fromCharCode(...new Uint8Array(wrong))), body)).toBe(false);
  });

  it("lets VENDO_TICK_SECRET win, and derives only for the host that set none", async () => {
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_TICK_SECRET", "the-operator-s-own-passphrase");

    // The hard BYO rule: setting a Cloud key never shadows a secret the operator
    // already ships in the environment.
    expect(await tickSecret()).toBe("the-operator-s-own-passphrase");

    vi.stubEnv("VENDO_TICK_SECRET", undefined);
    expect(await tickSecret()).toBe(await deriveTickSecret(API_KEY));

    vi.stubEnv("VENDO_API_KEY", undefined);
    expect(await tickSecret()).toBeUndefined();
  });
});

describe("enrolment", () => {
  it("publishes the door and the secret in the one request Cloud's register door takes", async () => {
    const { sent, fetch } = recorder(ok);

    await enrol({ fetch });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://console.vendo.run/api/v1/automations/deployments/register");
    expect(sent[0]!.init.method).toBe("POST");
    const headers = new Headers(sent[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    // `{url, secret}` and nothing else. The URL keeps its path prefix (Cloud
    // appends /api/vendo/tick to what it stores) and loses its trailing slash,
    // so the knock never doubles the separator.
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      url: "https://maple.example.com",
      secret: await deriveTickSecret(API_KEY),
    });
  });

  it("publishes the deployment's path prefix, and reaches a repointed console", async () => {
    const { sent, fetch } = recorder(ok);

    await enrol({
      cloud: { apiKey: API_KEY, baseUrl: "https://console.localhost.test" },
      publicUrl: new URL("https://maple.example.com/bank/"),
      fetch,
    });

    expect(sent[0]!.url).toBe("https://console.localhost.test/api/v1/automations/deployments/register");
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ url: "https://maple.example.com/bank" });
  });

  it("shouts when Cloud refuses, because a deployment that never enrolled looks healthy", async () => {
    capture();
    const { sent, fetch } = recorder(() => new Response(
      JSON.stringify({ error: { code: "unavailable", message: "Could not enrol the deployment — try again." } }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));

    // Never throws: a console blip must not take the deployment down with it.
    await enrol({ fetch });

    expect(sent).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("error");
    expect(events[0]!.code).toBe("vendo.tick-enrolment-failed");
    expect(events[0]!.message).toContain("will not fire");
    expect(events[0]!.message).toContain("Could not enrol the deployment");
    // The secret is never in a log line, an error message, or a URL.
    expect(events[0]!.message).not.toContain(await deriveTickSecret(API_KEY));
  });

  it("shouts when there is no public URL to be woken at, and sends nothing", async () => {
    capture();
    const { sent, fetch } = recorder(ok);

    await enrol({ publicUrl: undefined, fetch });

    expect(sent).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("error");
    expect(events[0]!.message).toContain("VENDO_BASE_URL");
  });

  it("says nothing at all with no Cloud key, no automations, or a development process", async () => {
    capture();
    const { sent, fetch } = recorder(ok);

    // No Cloud: nothing is going to knock, and nothing is missing.
    await enrol({ cloud: undefined, fetch });
    // No automations mounted: there is nothing for a knock to fire.
    await enrol({ automationsMounted: false, fetch });
    // A development process fires its own ticks and its URL is in no
    // deployment inventory — enrolling it would register a wire Cloud cannot
    // reach and then alarm about the silence.
    await enrol({ development: true, fetch });

    expect(sent).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
