/**
 * The demo's in-process tools — the actions a generated view can dispatch
 * through the sandbox bridge (POST /api/flowlet/action), and that the chat
 * agent can call directly. They execute against the SAME MailStore the REST
 * API serves, so every action is immediately visible in the app.
 *
 * Gating: `list_unread_messages`/`search_messages` are read-only (policy
 * allow). `delete_message`, `send_reply` and `slack_summary` are writes — the
 * policy answers "approve" (fail-safe name rule) and the action route enforces
 * a server-issued one-time approval token before executing them.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MailStore } from "../store";
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

    delete_message: tool({
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
      }),
      execute: async ({ messageId, channel }) => {
        const message = store.get(messageId);
        if (!message) throw new Error(`unknown message "${messageId}"`);
        const summary = await summarizeForSlack(message, generate);
        const text = `Inbox, via Vendo — ${message.from.name}: "${message.subject}" — ${summary}`;
        const result = await postToSlack(channel ?? "#general", text);
        if (!result.ok) throw new Error(`Slack post failed: ${result.error}`);
        store.markRead(messageId, true);
        return { posted: true, channel: result.channel, text: result.text };
      },
    }),
  };
}

/** Read-only tool names — safe for policy allow and reopen-replay. */
export const READ_ONLY_TOOLS = new Set(["list_unread_messages", "search_messages"]);
