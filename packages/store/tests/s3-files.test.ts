/**
 * The `s3Files` boundary. There is no live-bucket harness in this repo (no
 * MinIO, no localstack, no testcontainers), so this does NOT claim to prove
 * that a real bucket accepts these calls, nor that the SIGNATURE is
 * cryptographically right — only aws4fetch attests to that. What it does prove
 * is everything that is ours: the real signer runs over the real credentials,
 * and the request that leaves the adapter is asserted whole — method,
 * path-style URL, headers, body.
 *
 * The counterparty is a captured `fetch`, and it is the only mock here: the
 * adapter's job ENDS at the request it hands over.
 */
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { s3Files } from "../src/s3-files.js";

const CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const ENDPOINT = "https://acct123.r2.cloudflarestorage.com";

interface Sent {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

/** A capturing counterparty: records what the adapter actually signed and
    sent, and answers with whatever the case under test needs. */
function capture(reply: (sent: Sent) => Response): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const impl = (async (input: Request | URL | string): Promise<Response> => {
    const request = input as Request;
    const record: Sent = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    sent.push(record);
    return reply(record);
  }) as unknown as typeof fetch;
  return { sent, fetch: impl };
}

const ok = (): Response => new Response(null, { status: 200 });

describe("s3Files — what leaves the adapter", () => {
  it("PUTs to path-style <endpoint>/<bucket>/<key>, signed with real SigV4", async () => {
    const { sent, fetch } = capture(ok);
    const bytes = new TextEncoder().encode("month,revenue\njan,31000\n");
    await s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch })
      .put("wsb_abc", bytes, { contentType: "text/csv" });

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${ENDPOINT}/drawer/wsb_abc`);
    expect(request.headers.get("content-type")).toBe("text/csv");
    expect(request.body).toEqual(bytes);
    // aws4fetch's documented S3 default: the payload is not hashed into the
    // signature, TLS covers it, and every target accepts the literal — it is
    // what gets signed, so it is pinned rather than left to drift.
    expect(request.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(request.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    // "auto" is the default because R2 requires it; the credential scope above
    // is where a wrong default would show up.
    expect(request.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("signs for the region and session token it is given", async () => {
    const { sent, fetch } = capture(ok);
    await s3Files({
      endpoint: "https://s3.us-east-2.amazonaws.com",
      bucket: "drawer",
      credentials: { ...CREDENTIALS, sessionToken: "FwoGZXIvYXdzEXAMPLE" },
      region: "us-east-2",
      fetch,
    }).put("wsb_abc", new Uint8Array([1, 2, 3]));

    expect(sent[0]!.headers.get("authorization")).toContain("/us-east-2/s3/aws4_request");
    expect(sent[0]!.headers.get("x-amz-security-token")).toBe("FwoGZXIvYXdzEXAMPLE");
  });

  it("puts the prefix inside the bucket, on every verb", async () => {
    const { sent, fetch } = capture(ok);
    const files = s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, prefix: "prod/", fetch });
    await files.put("wsb_abc", new Uint8Array([1]));
    await files.delete("wsb_abc");

    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT ${ENDPOINT}/drawer/prod/wsb_abc`,
      `DELETE ${ENDPOINT}/drawer/prod/wsb_abc`,
    ]);
  });

  it("GETs bytes and content type back", async () => {
    const { fetch } = capture(() =>
      new Response(new Uint8Array([7, 8, 9]), { status: 200, headers: { "content-type": "text/csv" } }));
    const got = await s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch }).get("wsb_abc");

    expect(got).toEqual({ bytes: new Uint8Array([7, 8, 9]), contentType: "text/csv" });
  });

  it("resolves undefined on a 404 GET — the interface's own `| undefined`", async () => {
    const { fetch } = capture(() => new Response(null, { status: 404 }));

    expect(await s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch }).get("gone"))
      .toBeUndefined();
  });

  it("still resolves undefined when the OBJECT is missing and the bucket is fine", async () => {
    const { fetch } = capture(() => new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code>'
      + "<Message>The specified key does not exist.</Message></Error>",
      { status: 404 },
    ));

    expect(await s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch }).get("gone"))
      .toBeUndefined();
  });

  it("THROWS when the bucket itself is missing, which R2 also answers 404", async () => {
    // Verified against a real R2 bucket: a wrong or deleted bucket comes back
    // with the SAME status as a missing object, and only the error body's code
    // tells them apart. Read on status alone, a typo'd bucket reads back to the
    // host as "that file isn't there" — silently, forever.
    const { fetch } = capture(() => new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code>'
      + "<Message>The specified bucket does not exist.</Message></Error>",
      { status: 404 },
    ));
    const files = s3Files({ endpoint: ENDPOINT, bucket: "typo", credentials: CREDENTIALS, fetch });

    await expect(files.get("wsb_abc")).rejects.toThrow(VendoError);
    await expect(files.get("wsb_abc")).rejects.toThrow(
      "s3Files: GET typo/wsb_abc failed with 404"
      + " — check the endpoint, region, bucket and credentials passed to s3Files().",
    );
  });

  it("throws ONE error that names itself and the fix on any other failure", async () => {
    const { fetch } = capture(() => new Response("no", { status: 403 }));
    const files = s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch });

    await expect(files.get("wsb_abc")).rejects.toThrow(VendoError);
    await expect(files.get("wsb_abc")).rejects.toThrow(
      "s3Files: GET drawer/wsb_abc failed with 403"
      + " — check the endpoint, region, bucket and credentials passed to s3Files().",
    );
    // A 404 is only special on GET; a delete that 404s is still a failure the
    // deployment has to hear about.
    await expect(files.put("wsb_abc", new Uint8Array([1]))).rejects.toThrow("s3Files: PUT drawer/wsb_abc failed");
    await expect(files.delete("wsb_abc")).rejects.toThrow("s3Files: DELETE drawer/wsb_abc failed");
  });

  it("reads no environment and does no I/O at construction", async () => {
    const before = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "must-not-be-read";
    try {
      const { sent, fetch } = capture(ok);
      // Constructing alone must not reach the network — `createVendo` composes
      // this at module init on targets that forbid work in global scope.
      const files = s3Files({ endpoint: ENDPOINT, bucket: "drawer", credentials: CREDENTIALS, fetch });
      expect(sent).toHaveLength(0);

      await files.put("wsb_abc", new Uint8Array([1]));
      expect(sent[0]!.headers.get("authorization")).toContain("Credential=AKIAEXAMPLE/");
    } finally {
      if (before === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = before;
    }
  });
});
