import { defaultFetch, VendoError, type FilesAdapter } from "@vendoai/core";
import { AwsClient } from "aws4fetch";

/**
 * Build contract §3.4 — the ready-made `files:` adapter, for any bucket that
 * speaks S3: AWS, Cloudflare R2, Supabase Storage, MinIO. Path-style
 * addressing and SigV4 over WebCrypto, so it runs on an edge target too.
 *
 * `createVendo({ files: s3Files({...}) })` and nothing else: this reads no
 * environment of its own — which credentials reach it is the composition
 * seam's question (`selectFiles`), never the adapter's.
 */
export interface S3FilesOptions {
  /** The bucket's S3 endpoint, origin only — every target has one on its
      dashboard: R2 `https://<account>.r2.cloudflarestorage.com`, AWS
      `https://s3.<region>.amazonaws.com`, Supabase
      `https://<ref>.supabase.co/storage/v1/s3`, MinIO your own origin. */
  endpoint: string;
  bucket: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** SigV4 region. Defaults to "auto", which is what R2 requires and MinIO
      ignores; AWS and Supabase need their real one. */
  region?: string;
  /** Key prefix inside the bucket, so one bucket can hold several
      deployments. Defaults to none. */
  prefix?: string;
  fetch?: typeof fetch;
}

export function s3Files(options: S3FilesOptions): FilesAdapter {
  const base = `${options.endpoint.replace(/\/$/, "")}/${options.bucket}`;
  const send = options.fetch ?? defaultFetch;
  // Bound on the first call, never at construction: `createVendo` must stay
  // I/O-free at module init (the portability gate), and AwsClient builds a
  // WebCrypto key cache. Memoized, so every call shares one signer.
  let signer: AwsClient | undefined;
  const client = (): AwsClient => (signer ??= new AwsClient({
    ...options.credentials,
    service: "s3",
    region: options.region ?? "auto",
  }));

  const call = async (method: string, key: string, init?: RequestInit): Promise<Response> => {
    const path = `${options.prefix ?? ""}${key}`;
    const signed = await client().sign(`${base}/${path}`, { method, ...init });
    const response = await send(signed);
    // 404 is the interface's `| undefined` on `get`, so only `get` reads it;
    // every other outcome on every verb is the deployment's to fix. But a
    // missing BUCKET answers 404 too (measured against R2), and only the error
    // body's code tells it from a missing object — so a wrong or deleted bucket
    // would otherwise read back to the host as "that file isn't there",
    // silently and forever. The body is read ONLY on this branch; a served GET
    // never touches it.
    const missingObject = method === "GET" && response.status === 404
      && !(await response.text()).includes("NoSuchBucket");
    if (!response.ok && !missingObject) {
      throw new VendoError(
        "unavailable",
        `s3Files: ${method} ${options.bucket}/${path} failed with ${response.status}`
          + " — check the endpoint, region, bucket and credentials passed to s3Files().",
      );
    }
    return response;
  };

  return {
    async put(key, bytes, meta) {
      await call("PUT", key, {
        body: bytes,
        ...(meta?.contentType === undefined ? {} : { headers: { "content-type": meta.contentType } }),
      });
    },
    async get(key) {
      const response = await call("GET", key);
      if (response.status === 404) return undefined;
      const contentType = response.headers.get("content-type");
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        ...(contentType === null ? {} : { contentType }),
      };
    },
    async delete(key) {
      await call("DELETE", key);
    },
  };
}
