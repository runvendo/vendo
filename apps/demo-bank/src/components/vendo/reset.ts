/** Reset the demo to its pristine starting state, then reload to a fresh thread. */
export async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/vendo/reset", { method: "POST" });
  } catch {
    /* reload anyway — server may already be pristine */
  }
  window.location.href = "/";
}
