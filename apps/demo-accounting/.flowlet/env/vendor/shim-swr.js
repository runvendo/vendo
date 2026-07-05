// ../../packages/flowlet-sandbox-shims/dist/swr.js
function resolveKey(key) {
  if (typeof key === "string")
    return key;
  if (Array.isArray(key) && typeof key[0] === "string")
    return key[0];
  return void 0;
}
function useSWR(key, _fetcher) {
  const store = globalThis.__flowletAnchorData ?? {};
  const resolved = resolveKey(key);
  const data = resolved !== void 0 ? store[resolved] : void 0;
  return {
    data,
    error: void 0,
    isLoading: data === void 0,
    isValidating: false,
    mutate: async () => data
  };
}
export {
  useSWR as default,
  useSWR
};
