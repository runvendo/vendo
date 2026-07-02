/**
 * The demo's in-process tools — the actions a generated view can dispatch
 * through the sandbox bridge (POST /api/flowlet/action), and that the chat
 * agent can call directly. They execute against the SAME MailStore the REST
 * API serves, so every action is immediately visible in the app.
 *
 * Gating: `list_unread_messages`/`search_messages` are read-only (policy
 * allow). `delete_email`, `send_reply` and `slack_summary` are writes — the
 * policy answers "approve" (fail-safe name rule) and the action route enforces
 * a server-issued one-time approval token before executing them.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MailMessage, MailStore } from "../store";
import { draftReply, summarizeForSlack, type Generate } from "./drafting";
import type { SlackPoster } from "./slack";

export interface DemoToolsDeps {
  store: MailStore;
  generate: Generate;
  postToSlack: SlackPoster;
}

/** Compact projection for generated views — small payloads render fast. */
const project = (m: {
  id: string; from: { name: string; email: string }; subject: string;
  snippet: string; body: string; date: string; unread: boolean; starred: boolean;
}) => ({
  id: m.id,
  from: m.from.name,
  fromEmail: m.from.email,
  subject: m.subject,
  snippet: m.snippet,
  body: m.body,
  date: m.date,
  unread: m.unread,
  starred: m.starred,
});

export function demoTools({ store, generate, postToSlack }: DemoToolsDeps): ToolSet {
  // Slack posts already made, scoped to the seed lifetime (cleared by reset).
  const postedToSlack = new Set<string>();
  return {
    list_unread_messages: tool({
      description:
        "Read the user's UNREAD inbox emails, newest first. Returns id, sender, subject, " +
        "snippet, full body and date for each. Use this to build views over unread mail " +
        "(and declare it as the view's refresh query).",
      inputSchema: z.object({
        limit: z.number().optional().describe("Max messages to return (default 20)."),
      }),
      execute: async ({ limit }) => {
        return store.list({ folder: "inbox", unread: true, limit: limit ?? 20 }).map(project);
      },
    }),

    search_messages: tool({
      description:
        "Search the mailbox (sender, subject and body, case-insensitive). Optional folder " +
        "(inbox, sent, trash — default inbox). Read-only.",
      inputSchema: z.object({
        q: z.string().describe("The search text."),
        folder: z.enum(["inbox", "sent", "trash"]).optional(),
        limit: z.number().optional(),
      }),
      execute: async ({ q, folder, limit }) => {
        return store.list({ q, folder: folder ?? "inbox", limit: limit ?? 20 }).map(project);
      },
    }),

    // Named delete_email (not delete_message) so it can never collide with the
    // OpenAPI-derived client tool of that name (review finding).
    delete_email: tool({
      description:
        "Delete one email (moves it to trash) as the signed-in user. Destructive — the user " +
        "approves each call. Input is the message id.",
      inputSchema: z.object({
        messageId: z.string().describe("The id of the message to delete."),
      }),
      execute: async ({ messageId }) => {
        const deleted = store.delete(messageId);
        return { deleted: true, id: deleted.id, subject: deleted.subject };
      },
    }),

    send_reply: tool({
      description:
        "Reply to an email FOR the user: drafts a short reply in their voice (unless `body` " +
        "is given) and sends it. Sends mail as the user — each call needs their approval. " +
        "Returns the sent message including the drafted body.",
      inputSchema: z.object({
        messageId: z.string().describe("The id of the message being replied to."),
        body: z.string().optional().describe("Reply text; omit to have one drafted."),
      }),
      execute: async ({ messageId, body }) => {
        const original = store.get(messageId);
        if (!original) throw new Error(`unknown message "${messageId}"`);
        // Idempotency (review finding): a double-gesture or gesture+button on
        // one card must not fire two real replies.
        if (store.list({ folder: "sent" }).some((m) => m.inReplyTo === messageId)) {
          throw new Error(`a reply to "${original.subject}" was already sent`);
        }
        const replyBody = body?.trim() ? body : await draftReply(original, generate);
        const sent = store.send({ inReplyTo: messageId, body: replyBody });
        store.markRead(messageId, true);
        return {
          sent: true,
          to: sent.to[0]?.email,
          subject: sent.subject,
          body: sent.body,
        };
      },
    }),

    slack_summary: tool({
      description:
        "Post a short model-written summary of one email to the user's team Slack (#general " +
        "by default) — a REAL Slack message via the user's connected account. Posts on the " +
        "user's behalf — each call needs their approval.",
      inputSchema: z.object({
        messageId: z.string().describe("The id of the message to summarize."),
        channel: z.string().optional().describe('Slack channel (default "#general").'),
        text: z
          .string()
          .optional()
          .describe("Exact message to post; omit to have the summary written."),
      }),
      execute: async ({ messageId, channel, text }) => {
        const message = store.get(messageId);
        if (!message) throw new Error(`unknown message "${messageId}"`);
        const dedupeKey = `${store.generation}:${messageId}`;
        if (postedToSlack.has(dedupeKey)) {
          throw new Error(`a Slack summary of "${message.subject}" was already posted`);
        }
        // The consent-time preview passes `text` through so the user approves the
        // EXACT line that posts; drafting here is the fallback (agent-direct call).
        const line = text?.trim() ? text : await slackLine(message, generate);
        const result = await postToSlack(channel ?? "#general", line);
        if (!result.ok) throw new Error(`Slack post failed: ${result.error}`);
        postedToSlack.add(dedupeKey);
        store.markRead(messageId, true);
        return { posted: true, channel: result.channel, text: result.text };
      },
    }),
  };
}

async function slackLine(message: MailMessage, generate: Generate): Promise<string> {
  const summary = await summarizeForSlack(message, generate);
  return `Inbox, via Vendo — ${message.from.name}: "${message.subject}" — ${summary}`;
}

/**
 * Consent-time previews (review finding): the approval card must show the
 * EXACT content a gated action will produce, not just a message id. The action
 * route calls this while minting the approval token; whatever it returns is
 * merged into the payload the user approves, bound into the token, and used
 * verbatim at execute time.
 */
export function demoPreviews({ store, generate }: Pick<DemoToolsDeps, "store" | "generate">) {
  return async (
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
    if (action === "send_reply" && !(typeof payload.body === "string" && payload.body.trim())) {
      const original = store.get(messageId);
      if (!original) throw new Error(`unknown message "${messageId}"`);
      return {
        replyingTo: `${original.from.name} <${original.from.email}>`,
        subject: original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`,
        body: await draftReply(original, generate),
      };
    }
    if (action === "slack_summary" && !(typeof payload.text === "string" && payload.text.trim())) {
      const message = store.get(messageId);
      if (!message) throw new Error(`unknown message "${messageId}"`);
      return {
        summarizing: `${message.from.name} — "${message.subject}"`,
        text: await slackLine(message, generate),
      };
    }
    if (action === "delete_email") {
      const message = store.get(messageId);
      if (!message) throw new Error(`unknown message "${messageId}"`);
      return { deleting: `${message.from.name} — "${message.subject}"` };
    }
    return null;
  };
}

/** Read-only tool names — safe for policy allow and reopen-replay. */
export const READ_ONLY_TOOLS = new Set(["list_unread_messages", "search_messages"]);
