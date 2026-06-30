"use client";

/**
 * Shared client-side REAL connect flow, used by both the in-thread
 * DemoConnectCard and the manual "+ Connect tools" selector.
 *
 * Steps:
 *   1. POST { id, action: "authorize" } → { redirectUrl, connectedAccountId }.
 *   2. If a redirectUrl came back, open it in a small popup so the user completes
 *      OAuth. (Already-authorized toolkits return a null redirectUrl — fast path.)
 *   3. Poll GET ?status&id&account every POLL_MS until the status is terminal
 *      (active/failed) or TIMEOUT_MS elapses. The status route marks the toolkit
 *      connected in the demo store as soon as Composio reports ACTIVE.
 */

const POLL_MS = 1500;
const TIMEOUT_MS = 90_000;
const POPUP_FEATURES = "width=520,height=680";

export type ConnectResult = "active" | "failed" | "timeout";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AuthorizeResponse {
  redirectUrl: string | null;
  connectedAccountId: string;
}

async function authorize(toolkit: string): Promise<AuthorizeResponse> {
  const res = await fetch("/api/flowlet/integrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: toolkit, action: "authorize" }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`authorize failed: ${res.status}`);
  const json = (await res.json()) as { data?: AuthorizeResponse };
  if (!json.data?.connectedAccountId) throw new Error("authorize: no account id");
  return json.data;
}

async function pollStatus(
  toolkit: string,
  account: string,
): Promise<"active" | "pending" | "failed"> {
  const res = await fetch(
    `/api/flowlet/integrations?status&id=${encodeURIComponent(
      toolkit,
    )}&account=${encodeURIComponent(account)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return "failed";
  const json = (await res.json()) as { data?: { status?: string } };
  const status = json.data?.status;
  if (status === "active" || status === "failed") return status;
  return "pending";
}

/**
 * Run the full authorize → popup → poll flow for a toolkit. Resolves once the
 * connection is ACTIVE (store now marked connected), or "failed"/"timeout".
 */
export async function runConnectFlow(toolkit: string): Promise<ConnectResult> {
  const { redirectUrl, connectedAccountId } = await authorize(toolkit);

  let popup: Window | null = null;
  if (redirectUrl && typeof window !== "undefined") {
    popup = window.open(redirectUrl, "flowlet-connect", POPUP_FEATURES);
  }

  const deadline = Date.now() + TIMEOUT_MS;
  // Already-authorized (null redirectUrl) accounts usually report ACTIVE at once,
  // so check immediately, then poll on the interval.
  while (Date.now() < deadline) {
    const status = await pollStatus(toolkit, connectedAccountId);
    if (status === "active") {
      popup?.close();
      return "active";
    }
    if (status === "failed") {
      popup?.close();
      return "failed";
    }
    await wait(POLL_MS);
  }
  popup?.close();
  return "timeout";
}
