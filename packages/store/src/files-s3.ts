import { VendoError, type FilesAdapter } from "@vendoai/core";
import { AwsClient } from "aws4fetch";

/** Build contract §3.4 — the one shipped files adapter. S3-compatible covers
 *  S3, R2, Supabase Storage and MinIO, so one implementation is the whole
 *  surface. Credentials arrive as arguments and are never read from the
 *  environment (the adapter rule — see `hostedStore`/`selectStore`). */
export interface S3FilesOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Signing region. `auto` is what R2 and most MinIO deployments expect. */
  region?: string;
  sessionToken?: string;
  /** Base URL of an S3-compatible service (R2, Supabase, MinIO). Given, keys
      are addressed path-style (`<endpoint>/<bucket>/<key>`); omitted, the
      AWS virtual-host form is used. */
  endpoint?: string;
  /** Key prefix inside the bucket, so a bucket can hold more than a workspace. */
  prefix?: string;
  /** Injection seam for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

/** Build contract §3.4 — `s3(bucket)`: workspace blobs in an object store. */
export function s3(options: S3FilesOptions): FilesAdapter {
  // Without either, the AWS host would be `<bucket>.s3.auto.amazonaws.com` —
  // a DNS failure on the first write instead of a configuration error here.
  if (options.region === undefined && options.endpoint === undefined) {
    throw new VendoError(
      "validation",
      "s3() needs a `region` (for AWS, e.g. `region: \"us-east-1\"`) or an `endpoint`"
        + " (for an S3-compatible service such as R2, Supabase or MinIO, which also"
        + " accept `region: \"auto\"`).",
    );
  }
  const region = options.region ?? "auto";
  const prefix = options.prefix === undefined ? "" : `${trimSlashes(options.prefix)}/`;
  const base = options.endpoint === undefined
    ? `https://${options.bucket}.s3.${region}.amazonaws.com`
    : `${options.endpoint.replace(/\/+$/, "")}/${options.bucket}`;
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    service: "s3",
    region,
  });
  const fetchImpl = options.fetch;

  // Workspace blob keys are minted from base64url segments (workspace-rows.ts),
  // so a key is always URL-safe as written — no escaping decisions here.
  const urlFor = (key: string): string => `${base}/${prefix}${key}`;

  const send = async (key: string, init: RequestInit): Promise<Response> => {
    const request = await client.sign(urlFor(key), init);
    return await (fetchImpl === undefined ? fetch(request) : fetchImpl(request));
  };

  /**
   * The bucket's answer, in Vendo's vocabulary. A refused or unwell bucket is
   * not the host's input being invalid, and treating every status as
   * `validation` told callers to go fix an argument that was already right.
   *
   * Retryable upstream trouble (429, 5xx) deliberately does NOT map to
   * `conflict`: in this subsystem that word already means a stale-base
   * compare-and-swap (`CommitResult.status`, `putAppRow`), and one word with two
   * meanings is worse than a coarse one. Core's `VendoErrorCode` list is frozen,
   * so retryability travels in `detail` where a caller can act on it.
   */
  const raise = (response: Response, action: string, key: string): never => {
    const retryable = response.status === 429 || response.status >= 500;
    const code = response.status === 404
      ? "not-found" // the bucket (or the whole endpoint) is not there
      : retryable || response.status === 401 || response.status === 403
        ? "blocked" // the call did not go through, and not because of its arguments
        : "validation";
    throw new VendoError(
      code,
      `S3 ${action} of ${key} failed with ${response.status} ${response.statusText}`.trimEnd(),
      { status: response.status, retryable },
    );
  };

  return {
    async put(key, bytes, meta) {
      const response = await send(key, {
        method: "PUT",
        body: bytes,
        headers: meta?.contentType === undefined ? {} : { "content-type": meta.contentType },
      });
      if (!response.ok) raise(response, "put", key);
    },
    async get(key) {
      const response = await send(key, { method: "GET" });
      if (response.status === 404) return undefined;
      if (!response.ok) raise(response, "get", key);
      const contentType = response.headers.get("content-type");
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        ...(contentType === null ? {} : { contentType }),
      };
    },
    async delete(key) {
      const response = await send(key, { method: "DELETE" });
      // S3 DELETE is idempotent: a missing key answers 204, and 404 from an
      // S3-compatible service means the same thing.
      if (!response.ok && response.status !== 404) raise(response, "delete", key);
    },
  };
}
