// apps/demo-accounting/src/lib/api.ts
var ApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
};
async function fetcher(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(json?.error?.message ?? `Request failed: ${url}`, res.status);
  }
  if (json === null || !("data" in json)) {
    throw new ApiError(`Malformed response (missing data envelope): ${url}`, res.status);
  }
  return json.data;
}
export {
  ApiError,
  fetcher
};
