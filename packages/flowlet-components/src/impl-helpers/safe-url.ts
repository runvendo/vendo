/** Returns the URL if its protocol is allowlisted, else undefined. */
export function allowlistUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(trimmed)) return trimmed;
  return undefined;
}
