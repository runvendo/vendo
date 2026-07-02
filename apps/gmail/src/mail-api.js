/**
 * Client for the clone's own mail API (proxied to the Express backend).
 * The Redux mail slice mirrors the server; every mutation refreshes it so
 * agent-made changes and user actions render the same way.
 */
import { setMessages } from "./redux/mail/mail.actions";

const jsonFetch = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
};

export const fetchMailbox = async () => {
  const [inbox, sent] = await Promise.all([
    jsonFetch("/api/messages?folder=inbox"),
    jsonFetch("/api/messages?folder=sent"),
  ]);
  return [...inbox.messages, ...sent.messages];
};

/** Fetch the mailbox and push it into the store. */
export const refreshMail = async (dispatch) => {
  try {
    dispatch(setMessages(await fetchMailbox()));
  } catch (e) {
    // Server briefly down (restart) — keep last known state, next poll heals.
    console.warn("[mail] refresh failed:", e.message);
  }
};

export const sendMessage = (payload) =>
  jsonFetch("/api/messages/send", { method: "POST", body: JSON.stringify(payload) });

export const setStar = (id, starred) =>
  jsonFetch(`/api/messages/${encodeURIComponent(id)}/star`, {
    method: "POST",
    body: JSON.stringify({ starred }),
  });

export const markRead = (id, read) =>
  jsonFetch(`/api/messages/${encodeURIComponent(id)}/read`, {
    method: "POST",
    body: JSON.stringify({ read }),
  });

export const deleteMessage = (id) =>
  jsonFetch(`/api/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
