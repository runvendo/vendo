"use client";

/**
 * Client-side Composio connect flow against `createFlowletHandler()`'s
 * integrations endpoints: connect → (fast path | OAuth popup) → status poll.
 * The status route marks the toolkit connected server-side once ACTIVE, which
 * rebuilds the agent with the new toolkit on its next turn.
 */

const POLL_MS = 1500;
const TIMEOUT_MS = 120_000;
const POPUP_FEATURES = "width=520,height=680,menubar=no,toolbar=no";

export type ConnectOutcome =
  | { result: "active" }
  | { result: "failed" }
  | { result: "timeout" }
  | { result: "needs-auth"; redirectUrl: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ConnectResponse {
  connected: boolean;
  redirectUrl?: string | null;
  connectedAccountId?: string;
}

async function postConnect(basePath: string, toolkit: string): Promise<ConnectResponse> {
  const res = await fetch(`${basePath}/integrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: toolkit, action: "connect" }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`connect failed: ${res.status}`);
  return (await res.json()) as ConnectResponse;
}

async function pollStatus(
  basePath: string,
  toolkit: string,
  account: string,
): Promise<"active" | "pending" | "failed"> {
  const res = await fetch(
    `${basePath}/integrations?status&id=${encodeURIComponent(toolkit)}&account=${encodeURIComponent(account)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return "failed";
  const json = (await res.json()) as { status?: string };
  return json.status === "active" || json.status === "failed" ? json.status : "pending";
}

export async function runConnectFlow(basePath: string, toolkit: string): Promise<ConnectOutcome> {
  const res = await postConnect(basePath, toolkit);

  // Fast path: already authorized → the store is now marked connected.
  if (res.connected) return { result: "active" };

  const redirectUrl = res.redirectUrl ?? null;
  const account = res.connectedAccountId ?? "";
  if (!redirectUrl || !account) return { result: "failed" };

  const popup =
    typeof window !== "undefined" ? window.open(redirectUrl, "flowlet-connect", POPUP_FEATURES) : null;
  if (!popup) return { result: "needs-auth", redirectUrl };

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    const status = await pollStatus(basePath, toolkit, account);
    if (status === "active") {
      popup.close();
      return { result: "active" };
    }
    if (status === "failed") {
      popup.close();
      return { result: "failed" };
    }
    if (popup.closed) {
      // User closed the window — one final status check before giving up.
      const final = await pollStatus(basePath, toolkit, account);
      return { result: final === "active" ? "active" : "failed" };
    }
  }
  popup.close();
  return { result: "timeout" };
}
