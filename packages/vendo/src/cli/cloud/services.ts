import { cloudFetch, type CloudFetchOptions } from "./client.js";

export function pushSyncReport(
  payload: unknown,
  options: Pick<CloudFetchOptions, "apiKey" | "apiUrl" | "env" | "fetchImpl"> = {},
): Promise<unknown> {
  return cloudFetch("/api/v1/sync/report", {
    ...options,
    auth: "key",
    method: "POST",
    body: payload,
  });
}
