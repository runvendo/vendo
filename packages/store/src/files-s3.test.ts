import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { s3 } from "./files-s3.js";

// Build contract §3.4 — the one shipped files adapter. The `fetch` seam lets
// these tests read exactly what goes on the wire (URL, method, signature)
// without an account, the same way hostedStore's tests do.

interface Sent {
  url: string;
  method: string;
  authorization: string | null;
  body: Uint8Array | undefined;
}

const recorder = (respond: (sent: Sent) => Response): { sent: Sent[]; fetch: typeof globalThis.fetch } => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: Request | string | URL): Promise<Response> => {
    const request = input as Request;
    const body = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const record: Sent = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body,
    };
    sent.push(record);
    return respond(record);
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch: fetchImpl };
};

const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretexample" };

describe("s3() files adapter", () => {
  it("puts an object at the AWS virtual-host URL, signed", async () => {
    const { sent, fetch } = recorder(() => new Response(null, { status: 200 }));
    const files = s3({ bucket: "vendo-files", region: "us-east-1", ...credentials, fetch });

    await files.put("ws/abc/def/r1", new Uint8Array([1, 2, 3]), { contentType: "text/plain" });

    expect(sent[0]?.url).toBe("https://vendo-files.s3.us-east-1.amazonaws.com/ws/abc/def/r1");
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent[0]?.authorization).toContain("AWS4-HMAC-SHA256");
    expect(sent[0]?.authorization).toContain("/us-east-1/s3/aws4_request");
    // The secret itself never appears on the wire.
    expect(sent[0]?.authorization).not.toContain(credentials.secretAccessKey);
  });

  it("addresses an S3-compatible endpoint path-style, under the given prefix", async () => {
    const { sent, fetch } = recorder(() => new Response(null, { status: 200 }));
    const files = s3({
      bucket: "workspace",
      endpoint: "https://account.r2.cloudflarestorage.com/",
      prefix: "/vendo/",
      ...credentials,
      fetch,
    });

    await files.put("ws/abc/def/r1", new Uint8Array([7]));

    expect(sent[0]?.url).toBe("https://account.r2.cloudflarestorage.com/workspace/vendo/ws/abc/def/r1");
  });

  it("reads bytes back and reports a missing key as undefined", async () => {
    const { fetch } = recorder((sent) =>
      sent.url.endsWith("present")
        ? new Response(new Uint8Array([9, 8]), { status: 200, headers: { "content-type": "application/octet-stream" } })
        : new Response(null, { status: 404 }));
    const files = s3({ bucket: "b", region: "us-east-1", ...credentials, fetch });

    expect(await files.get("present")).toEqual({
      bytes: new Uint8Array([9, 8]),
      contentType: "application/octet-stream",
    });
    expect(await files.get("absent")).toBeUndefined();
  });

  it("treats a delete of a missing key as done, and raises anything else", async () => {
    const { fetch: missing } = recorder(() => new Response(null, { status: 404 }));
    await expect(s3({ bucket: "b", region: "us-east-1", ...credentials, fetch: missing }).delete("gone"))
      .resolves.toBeUndefined();

    const { fetch: denied } = recorder(() => new Response(null, { status: 403, statusText: "Forbidden" }));
    await expect(s3({ bucket: "b", region: "us-east-1", ...credentials, fetch: denied }).delete("nope"))
      .rejects.toMatchObject<Partial<VendoError>>({ code: "blocked" });
  });

  // F11 (verifier): with neither region nor endpoint the adapter built
  // `s3.auto.amazonaws.com` — a DNS failure at the first write instead of a
  // configuration error at construction.
  it("refuses to be built without a region or an endpoint, naming the fix", async () => {
    expect(() => s3({ bucket: "b", ...credentials }))
      .toThrow(/region|endpoint/);
    try {
      s3({ bucket: "b", ...credentials });
    } catch (error) {
      expect(error).toMatchObject<Partial<VendoError>>({ code: "validation" });
    }
    // Either one is enough.
    expect(() => s3({ bucket: "b", region: "us-east-1", ...credentials })).not.toThrow();
    expect(() => s3({ bucket: "b", endpoint: "https://minio.internal", ...credentials })).not.toThrow();
  });

  // F14 (verifier): every non-2xx became VendoError("validation") — a 403 or a
  // 500 is not the host's input being invalid.
  it("maps a refusal, a missing bucket and an upstream failure to distinct kinds", async () => {
    const adapterFor = (status: number, statusText = ""): ReturnType<typeof s3> => {
      const { fetch } = recorder(() => new Response(null, { status, statusText }));
      return s3({ bucket: "b", region: "us-east-1", ...credentials, fetch });
    };

    // The caller is not allowed: that is the guard's vocabulary, not validation.
    await expect(adapterFor(403, "Forbidden").put("k", new Uint8Array([1])))
      .rejects.toMatchObject<Partial<VendoError>>({ code: "blocked" });
    await expect(adapterFor(401, "Unauthorized").put("k", new Uint8Array([1])))
      .rejects.toMatchObject<Partial<VendoError>>({ code: "blocked" });
    // The bucket itself is not there.
    await expect(adapterFor(404, "Not Found").put("k", new Uint8Array([1])))
      .rejects.toMatchObject<Partial<VendoError>>({ code: "not-found" });
    // Upstream is unwell or throttling — neither is the host's fault, and
    // neither is a `conflict`: that word already means a stale-base CAS in this
    // subsystem (CommitResult.status, putAppRow), so reusing it here would give
    // one word two meanings. Retryability travels in `detail` instead, since
    // core's error-code list is frozen.
    for (const status of [429, 500, 503]) {
      const failure = await adapterFor(status).put("k", new Uint8Array([1]))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject<Partial<VendoError>>({ code: "blocked" });
      expect((failure as VendoError).detail).toMatchObject({ status, retryable: true });
    }
    // A refusal is NOT retryable, and says so.
    const refused = await adapterFor(403, "Forbidden").put("k", new Uint8Array([1]))
      .catch((error: unknown) => error);
    expect((refused as VendoError).detail).toMatchObject({ status: 403, retryable: false });
    // A genuinely malformed request stays validation.
    await expect(adapterFor(400, "Bad Request").put("k", new Uint8Array([1])))
      .rejects.toMatchObject<Partial<VendoError>>({ code: "validation" });
  });

  it("reads no credentials from the environment (the adapter rule)", async () => {
    const { sent, fetch } = recorder(() => new Response(null, { status: 200 }));
    process.env["AWS_ACCESS_KEY_ID"] = "env-key-must-be-ignored";
    try {
      await s3({ bucket: "b", region: "us-east-1", accessKeyId: "arg-key", secretAccessKey: "arg-secret", fetch })
        .put("k", new Uint8Array([1]));
    } finally {
      delete process.env["AWS_ACCESS_KEY_ID"];
    }
    expect(sent[0]?.authorization).toContain("arg-key");
    expect(sent[0]?.authorization).not.toContain("env-key-must-be-ignored");
  });
});
