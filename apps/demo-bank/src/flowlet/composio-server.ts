/**
 * Server-only Composio accessor for the demo's connect flow.
 *
 * Builds ONE real `createComposioClient` (lazily, env-keyed) and uses the SAME
 * `DEMO_PRINCIPAL.userId` the chat agent runs as, so a connection authorized
 * here is the same connected account the agent later ingests tools from.
 *
 * Pulls in `@composio/core` (Node internals) — import only from route handlers,
 * never from a client component.
 */
import { createComposioClient, type ComposioClient } from "@flowlet/runtime";
import { DEMO_PRINCIPAL } from "./principal";

// Lazily-constructed singleton: never touches the network until first use.
let client: ComposioClient | undefined;

function getClient(): ComposioClient {
  if (!client) {
    client = createComposioClient({ apiKey: process.env.COMPOSIO_API_KEY });
  }
  return client;
}

/**
 * Begin (or resume) the OAuth connection for a toolkit as the demo user.
 * Returns the provider OAuth `redirectUrl` (null when already authorized) and
 * the `connectedAccountId` to poll.
 */
export function authorizeToolkit(
  toolkit: string,
): Promise<{ redirectUrl: string | null; connectedAccountId: string }> {
  return getClient().authorize(DEMO_PRINCIPAL.userId, toolkit);
}

/** Normalized status of a connected account: active | pending | failed. */
export function toolkitConnectionStatus(
  connectedAccountId: string,
): Promise<"active" | "pending" | "failed"> {
  return getClient().connectionStatus(connectedAccountId);
}

/**
 * Is the toolkit ALREADY authorized (an ACTIVE connected account) for the demo
 * user? This is the authoritative check — NOT fetchTools, which returns a
 * toolkit's tool schemas even when the user hasn't connected it (which made
 * GitHub/Notion fake-connect instantly). Gmail/Slack are pre-authorized, so they
 * take the fast path; everything else falls through to real OAuth.
 */
export async function isToolkitConnected(toolkit: string): Promise<boolean> {
  return getClient().hasActiveConnection(DEMO_PRINCIPAL.userId, toolkit);
}
