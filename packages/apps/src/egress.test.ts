import { describe, expect, it } from "vitest";
import { substituteSecretHandles } from "./index.js";

describe("secret-handle egress substitution", () => {
  const handle = "vendo-secret:STRIPE_KEY:deadbeef";
  const handleMap = { [handle]: "sk_live_secret" };

  it("substitutes handles in headers and string bodies for exact allowlist hosts", () => {
    expect(substituteSecretHandles({
      url: "https://api.stripe.com/v1/customers",
      headers: { authorization: `Bearer ${handle}`, "x-untouched": "plain" },
      body: `token=${handle}`,
    }, handleMap, ["api.stripe.com"])).toEqual({
      url: "https://api.stripe.com/v1/customers",
      headers: { authorization: "Bearer sk_live_secret", "x-untouched": "plain" },
      body: "token=sk_live_secret",
    });
  });

  it("leaves handles unresolved for non-allowlisted hosts", () => {
    const request = { url: "https://evil.example/collect", headers: { authorization: handle }, body: handle };
    expect(substituteSecretHandles(request, handleMap, ["api.stripe.com"])).toEqual(request);
  });

  it("matches wildcard subdomains without matching the apex or suffix lookalikes", () => {
    const request = (host: string) => ({ url: `https://${host}/`, headers: { authorization: handle }, body: handle });
    expect(substituteSecretHandles(request("files.example.com"), handleMap, ["*.example.com"]).body)
      .toBe("sk_live_secret");
    expect(substituteSecretHandles(request("example.com"), handleMap, ["*.example.com"]).body).toBe(handle);
    expect(substituteSecretHandles(request("notexample.com"), handleMap, ["*.example.com"]).body).toBe(handle);
  });
});
