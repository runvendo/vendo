import { describe, expect, it } from "vitest";
import { resolvePrincipal, DEFAULT_PRINCIPAL } from "./guard";

function req(host: string): Request {
  return new Request(`http://${host}/api/vendo/chat`, {
    method: "POST",
    headers: { host },
  });
}

describe("resolvePrincipal", () => {
  it("allows local requests with the default principal", async () => {
    const result = await resolvePrincipal(req("localhost:3000"), {}, {});
    expect(result).toEqual({ ok: true, principal: DEFAULT_PRINCIPAL });
  });

  it("blocks remote requests by default with a 403", async () => {
    const result = await resolvePrincipal(req("myapp.vercel.app"), {}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("fails closed in production even for a spoofed local Host (review P0)", async () => {
    const spoofed = await resolvePrincipal(req("localhost:3000"), {}, { NODE_ENV: "production" });
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.response.status).toBe(403);
  });

  it("serves remote traffic when VENDO_ALLOW_REMOTE=1 (even in production)", async () => {
    const result = await resolvePrincipal(
      req("myapp.vercel.app"),
      {},
      { VENDO_ALLOW_REMOTE: "1", NODE_ENV: "production" },
    );
    expect(result.ok).toBe(true);
  });

  it("delegates entirely to a principal resolver when provided", async () => {
    const options = { principal: () => ({ userId: "u-42" }) };
    const ok = await resolvePrincipal(req("myapp.vercel.app"), options, {});
    expect(ok).toEqual({ ok: true, principal: { userId: "u-42" } });

    const denied = await resolvePrincipal(req("localhost:3000"), { principal: () => null }, {});
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
  });
});
