/**
 * The in-process tools that are safe to re-run without the user asking.
 * Isomorphic single source: the server policy allowlists them and tools.ts
 * implements exactly this set.
 */
export const READ_ONLY_TOOLS = [
  "get_dashboard",
  "get_clients",
  "get_client_documents",
  "get_deadlines",
  "get_activity",
] as const;
