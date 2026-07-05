/**
 * Server-side model calls behind the swipe actions: swipe-right drafts the
 * reply, swipe-up writes the Slack summary. Small, single-purpose prompts —
 * the chat agent is NOT in the loop here; these run inside governed in-process
 * tools after the user approves the action.
 */
import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { MailMessage } from "../store";

const DRAFT_MODEL = process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6";

/** Injectable text generator so tests never hit the network. */
export type Generate = (prompt: string) => Promise<string>;

export function modelGenerate(model?: LanguageModel): Generate {
  return async (prompt) => {
    const { text } = await generateText({ model: model ?? anthropic(DRAFT_MODEL), prompt });
    return text.trim();
  };
}

export async function draftReply(message: MailMessage, generate: Generate): Promise<string> {
  const prompt = [
    "Draft a short reply email from Yousef (a staff engineer at Acme Labs) to the message below.",
    "Sound like a busy, friendly colleague: direct, warm, 2-4 sentences, no fluff, no emoji.",
    "Commit to something concrete when the message asks for something.",
    "Output ONLY the reply body text — no subject line, no quoting, no signature beyond '— Yousef'.",
    "",
    `From: ${message.from.name} <${message.from.email}>`,
    `Subject: ${message.subject}`,
    "",
    message.body,
  ].join("\n");
  return generate(prompt);
}

export async function summarizeForSlack(message: MailMessage, generate: Generate): Promise<string> {
  const prompt = [
    "Summarize the email below for the sender's team Slack channel in ONE punchy sentence",
    "(max ~30 words). Lead with what matters or what is being asked. Plain text, no emoji,",
    "no preamble — output only the sentence.",
    "",
    `From: ${message.from.name} <${message.from.email}>`,
    `Subject: ${message.subject}`,
    "",
    message.body,
  ].join("\n");
  return generate(prompt);
}
