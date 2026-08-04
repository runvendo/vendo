/**
 * Scripted turn engine — the sales-demo interception seam.
 *
 * POST /api/vendo/threads calls `scriptedThreadsResponse(request)` first: when
 * the latest user text EXACTLY matches one of the Maple scenario cards
 * (src/vendo/scenarios.tsx), a CANNED assistant turn streams back instead of
 * invoking the model. Everything else about the turn is REAL:
 *
 * - the stream is built with the SAME `createUIMessageStream` +
 *   `createUIMessageStreamResponse` helpers the agent runtime uses, emitting
 *   the same chunk vocabulary (text deltas, dynamic-tool parts,
 *   `data-vendo-view` / `data-vendo-approval` / `data-vendo-connect` wire
 *   parts), so the thread chrome renders it exactly like a live turn;
 * - host tools execute FOR REAL through `vendo.guardedTools` (guard-audited →
 *   the Activity panel fills; the transfer parks a genuine approval the
 *   in-thread ApprovalCard resumes through the BYO parked-call machinery);
 * - the turn persists to the same `vendo_threads` row a live turn would, so
 *   history survives reopen and the resume upsert works over the plain wire.
 *
 * Any prompt that doesn't match passes through to the real agent untouched.
 */
import {
  toVendoWirePart,
  vendoViewStreamId,
  type ApprovalRequest,
  type Principal,
  type RunContext,
  type ToolOutcome,
} from "@vendoai/core";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import { resolveMapleSession } from "@/vendo/auth";
import { mapleScenarios } from "@/vendo/scenarios";
import { vendo } from "@/vendo/server";
import { demoAppId } from "./seed";
import {
  loadScriptedThread,
  persistScriptedThread,
  upsertMessage,
  type ScriptedThread,
} from "./threads";

const THREAD_ID_HEADER = "x-vendo-thread-id";
/** Scripted tool-call ids carry this prefix so the resume interception can
 *  recognize its own parked approvals and leave real-agent approvals alone. */
const SCRIPT_CALL_PREFIX = "mds_";
const PARKED_OUTCOME_COLLECTION = "vendo_parked_call_outcome";

type Beat = "spending" | "transfer" | "weekly" | "moneyhq" | "lowbalance" | "gmailConnected";

/** The automations the scripted beats arm; keys match demoAppId's. */
type AutomationKey = "weekly" | "lowbalance";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A human-feeling pause: uniform between min and max milliseconds. */
const beat = (minMs: number, maxMs: number): Promise<void> =>
  sleep(minMs + Math.random() * (maxMs - minMs));

const money = (cents: number): string => {
  const abs = Math.abs(cents) / 100;
  return `${cents < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function matchBeat(text: string): Beat | undefined {
  const prompts = mapleScenarios.map((card) => (card.prompt ?? card.title).trim());
  if (text === prompts[0]) return "spending";
  if (text === prompts[1]) return "transfer";
  if (text === prompts[2]) return "weekly";
  if (text === prompts[3]) return "moneyhq";
  if (text === prompts[4]) return "lowbalance";
  // The ConnectCard's deterministic continuation line after a live Gmail
  // OAuth ("Connected Gmail." — parts.tsx onConnected, kept natural on
  // purpose; the parked connect-required call above it carries the context).
  if (text.toLowerCase().startsWith("connected gmail")) return "gmailConnected";
  return undefined;
}

/* ------------------------------------------------------------------ */
/* chunk helpers                                                       */
/* ------------------------------------------------------------------ */

type Writer = UIMessageStreamWriter<UIMessage>;

function write(writer: Writer, chunk: UIMessageChunk): void {
  writer.write(chunk as never);
}

/** Word-chunked text at ~natural reading pace (fast, never instant-dump). */
async function streamText(writer: Writer, text: string, signal?: AbortSignal): Promise<void> {
  const id = `txt_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  write(writer, { type: "text-start", id });
  for (const word of text.split(/(?<=\s)/)) {
    if (signal?.aborted) break;
    write(writer, { type: "text-delta", id, delta: word });
    await sleep(26);
  }
  write(writer, { type: "text-end", id });
}

/** One REAL guard-audited host-tool execution, streamed as the same
 *  dynamic-tool part the live runtime emits, paced so the status ribbon
 *  narrates it (0.8–1.5s on screen). */
async function toolBeat(
  writer: Writer,
  ctx: RunContext,
  tool: string,
  args: unknown,
  holdMs = 900,
): Promise<ToolOutcome> {
  const toolCallId = `${SCRIPT_CALL_PREFIX}${globalThis.crypto.randomUUID().slice(0, 12)}`;
  write(writer, { type: "tool-input-start", toolCallId, toolName: tool, dynamic: true });
  await sleep(300);
  write(writer, { type: "tool-input-available", toolCallId, toolName: tool, input: args, dynamic: true });
  const outcome = await vendo.guardedTools.execute({ id: toolCallId, tool, args }, ctx);
  await sleep(holdMs);
  write(writer, { type: "tool-output-available", toolCallId, output: outcome, dynamic: true });
  return outcome;
}

type FixtureNode = { id: string; source?: string; component: string; children?: string[] };

/** The piece-by-piece build: 4–6 valid-while-partial prefixes of the settled
 *  payload, shaped exactly like the live paint lane's partial emissions —
 *  a growing node prefix (children trimmed to arrived nodes), each island's
 *  source landing one stage AFTER its node (so the shape-aware skeleton gets
 *  a beat on screen), every prefix marked `streaming: true`. The final,
 *  unmarked payload settles the same reconciled data part. */
function progressivePayloads(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const nodes = (Array.isArray(payload.nodes) ? payload.nodes : []) as FixtureNode[];
  const components = (payload.components ?? {}) as Record<string, string>;
  if (nodes.length < 2) return [];
  const stages = Math.min(5, nodes.length);
  const arrivedSources = (cut: number): Record<string, string> => Object.fromEntries(
    Object.entries(components).filter(([name]) =>
      nodes.slice(0, cut).some((node) => node.source === "generated" && node.component === name)),
  );
  const seen = new Set<string>();
  const prefixes: Array<Record<string, unknown>> = [];
  for (let stage = 1; stage <= stages; stage += 1) {
    const cut = Math.max(1, Math.ceil((nodes.length * stage) / stages));
    const previousCut = stage === 1 ? 0 : Math.max(1, Math.ceil((nodes.length * (stage - 1)) / stages));
    const included = nodes.slice(0, cut);
    const ids = new Set(included.map((node) => node.id));
    const arrived = arrivedSources(previousCut);
    const signature = `${cut}:${Object.keys(arrived).sort().join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    prefixes.push({
      ...payload,
      streaming: true,
      nodes: included.map((node) => node.children === undefined
        ? node
        : { ...node, children: node.children.filter((child) => ids.has(child)) }),
      components: arrived,
    });
  }
  return prefixes;
}

/** Open a seeded fixture app through the real runtime (its tree queries
 *  execute against the live host API) and embed it in-thread, STREAMED the
 *  way real generation streams: successive `data-vendo-view` partials under
 *  the same `vendoViewStreamId` envelope (they reconcile in place), tripping
 *  the same forming-skeleton / FluidReveal path, then the settled payload. */
async function viewBeat(
  writer: Writer,
  ctx: RunContext,
  appId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const surface = await vendo.apps.open(appId, ctx);
    if (surface.kind !== "tree") return false;
    // `name` rides the payload so the app-card bar titles itself (appTitle()).
    const app = await vendo.apps.get(appId, ctx);
    const payload = app === null ? surface.payload : { name: app.name, ...surface.payload };
    const streamId = vendoViewStreamId(appId as never);
    const emit = (part: unknown): void => write(writer, toVendoWirePart(
      { type: "data-vendo-view", appId, payload: part as typeof payload },
      streamId,
    ) as UIMessageChunk);
    // Skeleton ~1s in, then sections landing every 0.8–1.4s.
    for (const partial of progressivePayloads(payload as unknown as Record<string, unknown>)) {
      if (signal?.aborted) return true;
      await beat(800, 1400);
      emit(partial);
    }
    await beat(700, 1000);
    emit(payload); // no `streaming` flag — the bar flips ready, the pin appears
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* the four scripted beats                                             */
/* ------------------------------------------------------------------ */

interface BeatContext {
  writer: Writer;
  ctx: RunContext;
  signal?: AbortSignal;
}

function spendingSlices(outcome: ToolOutcome): Array<{ category: string; amount: number }> {
  if (outcome.status !== "ok") return [];
  const data = (outcome.output as { data?: unknown } | undefined)?.data;
  return Array.isArray(data)
    ? data.filter((slice): slice is { category: string; amount: number } =>
        typeof slice === "object" && slice !== null
        && typeof (slice as { category?: unknown }).category === "string"
        && typeof (slice as { amount?: unknown }).amount === "number")
    : [];
}

/** Card (a) — "Where did my money go?" */
async function spendingBeat({ writer, ctx, signal }: BeatContext): Promise<void> {
  await beat(500, 800); // a breath before the first activity row
  const insights = await toolBeat(writer, ctx, "host_getSpendingInsights", {}, 1200);
  await beat(400, 700);
  await streamText(writer, "Here's where this month went.", signal);
  const opened = await viewBeat(writer, ctx, demoAppId("spending", ctx.principal.subject), signal);
  if (!opened) {
    await streamText(writer, "I couldn't load the saved breakdown — try Reset demo to restore it.", signal);
    return;
  }
  await beat(500, 800);
  const slices = spendingSlices(insights).sort((a, b) => b.amount - a.amount);
  const top = slices[0];
  const total = slices.reduce((sum, slice) => sum + slice.amount, 0);
  await streamText(
    writer,
    top === undefined
      ? "I've saved this breakdown, so you can pin it or come back to it anytime."
      : `${capitalize(top.category)} is your largest category at ${money(top.amount)} — ${Math.round((top.amount / total) * 100)}% of the ${money(total)} you've spent so far. I've saved this breakdown so you can keep it.`,
    signal,
  );
}

/** Card (b), turn 1 — "Move money to savings": the REAL parked approval. The
 *  guarded transfer call parks under the guard's pending approval; Approve in
 *  the thread decides the guard record over the wire, the BYO parked-call
 *  subscriber re-dispatches the EXACT call, and Maple's transfer API debits
 *  checking for real. */
async function transferBeat({ writer, ctx, signal }: BeatContext): Promise<void> {
  await beat(500, 800); // a breath before the narration
  await streamText(
    writer,
    "You're moving $200.00 from Maple Checking. That moves real money, so it needs your sign-off first — review and approve below.",
    signal,
  );
  await beat(600, 900); // narration lands, then the tool row appears
  const toolCallId = `${SCRIPT_CALL_PREFIX}${globalThis.crypto.randomUUID().slice(0, 12)}`;
  const args = {
    amount: 20000,
    recipient_name: "Maple Savings ··8820",
    memo: "Checking → Savings, moved by Maple Assistant",
  };
  write(writer, { type: "tool-input-start", toolCallId, toolName: "host_transferMoney", dynamic: true });
  await sleep(450);
  write(writer, { type: "tool-input-available", toolCallId, toolName: "host_transferMoney", input: args, dynamic: true });
  const outcome = await vendo.guardedTools.execute({ id: toolCallId, tool: "host_transferMoney", args }, ctx);
  await beat(500, 800); // the guard's verdict beat before the card lands
  if (outcome.status === "pending-approval") {
    // Same order as the live runtime: the guard's flat approval part first,
    // then the native approval request that parks the tool part.
    write(writer, toVendoWirePart({
      type: "data-vendo-approval",
      toolCallId,
      risk: "destructive",
      approvalId: outcome.approvalId,
    }) as UIMessageChunk);
    write(writer, { type: "tool-approval-request", approvalId: outcome.approvalId, toolCallId });
    return;
  }
  // A standing grant (from a remembered earlier approve) runs it immediately.
  write(writer, { type: "tool-output-available", toolCallId, output: outcome, dynamic: true });
  await confirmTransfer(writer, ctx, outcome, signal);
}

async function confirmTransfer(
  writer: Writer,
  ctx: RunContext,
  outcome: ToolOutcome,
  signal?: AbortSignal,
): Promise<void> {
  if (outcome.status !== "ok") {
    await streamText(writer, "The transfer didn't go through — your accounts are untouched.", signal);
    return;
  }
  await beat(400, 700); // the approval lands, then the balance check
  const accounts = await toolBeat(writer, ctx, "host_listAccounts", {}, 800);
  await beat(400, 600);
  let balanceLine = "";
  if (accounts.status === "ok") {
    const rows = (accounts.output as { data?: Array<{ kind?: string; balance?: number }> }).data;
    const checking = rows?.find((account) => account.kind === "checking");
    if (typeof checking?.balance === "number") {
      balanceLine = ` Maple Checking is now at ${money(checking.balance)}.`;
    }
  }
  await streamText(
    writer,
    `Done — $200.00 moved to savings.${balanceLine} The posted transfer is in your transactions, and the approval is recorded in Activity.`,
    signal,
  );
}

/* ------------------------------------------------------------------ */
/* automation machinery shared by cards (c) and (e)                    */
/* ------------------------------------------------------------------ */

/** Grant-ask tool-call ids carry the automation key so the approval-resume
 *  interception can tell WHICH automation the decision arms. */
const GRANT_CALL_PATTERN = new RegExp(`^${SCRIPT_CALL_PREFIX}grant_(weekly|lowbalance)_`);

/** The consent line before the set card, count-aware (a re-run may have fewer
 *  grants still missing than the full surface). */
const grantConsentLine = (count: number): string =>
  count === 1
    ? "To run this while you're away it needs one standing permission — review and approve below."
    : `To run this while you're away it needs ${count === 2 ? "two" : String(count)} standing permissions — review and approve them below.`;

function grantCallId(key: AutomationKey): string {
  return `${SCRIPT_CALL_PREFIX}grant_${key}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/** Enable a seeded automation through the REAL engine; the returned `missing`
 *  are the standing-grant asks enable() minted (guard approvals), all members
 *  of the one `grantSetId` set. */
async function enableAutomation(
  ctx: RunContext,
  key: AutomationKey,
): Promise<{ enabled: boolean; missing: ApprovalRequest[]; grantSetId?: string }> {
  try {
    return await vendo.automations.enable(demoAppId(key, ctx.principal.subject), ctx);
  } catch {
    return { enabled: false, missing: [] };
  }
}

/** The WHOLE automation card, in-thread: the `data-vendo-automation` part the
 *  chrome renders with the same card vocabulary as Workspace → Automations.
 *  Streamed under a stable reconciliation id, so the approval resume's
 *  re-emission flips the SAME card from "waiting on N permissions" to live. */
async function automationCardPart(writer: Writer, ctx: RunContext, key: AutomationKey): Promise<void> {
  const appId = demoAppId(key, ctx.principal.subject);
  const app = await vendo.apps.get(appId, ctx);
  if (app === null) return;
  const entries = await vendo.automations.list(ctx);
  const entry = entries.find((candidate) => candidate.app.id === appId);
  write(writer, toVendoWirePart({
    type: "data-vendo-automation",
    appId,
    name: app.name,
    enabled: entry?.enabled === true,
    ...(app.trigger === undefined ? {} : { trigger: app.trigger }),
    ...(app.description === undefined ? {} : { description: app.description }),
    ...(entry?.pendingGrants === undefined ? {} : { pendingGrants: entry.pendingGrants }),
  }, `vendo-automation:${appId}`) as UIMessageChunk);
}

/** Surface the WHOLE grant set enable() minted as ONE in-thread consent card:
 *  the `data-vendo-grant-set` part enumerating every permission, keyed to one
 *  parked native call (the set's first guard ask carries the native approval
 *  id). Approve on the card decides EVERY member ask over the wire in one
 *  call — the automations engine's decision subscriber mints the grants —
 *  then the native response resumes this turn. */
async function surfaceGrantSet(
  writer: Writer,
  ctx: RunContext,
  key: AutomationKey,
  asks: ApprovalRequest[],
  grantSetId: string,
): Promise<void> {
  const app = await vendo.apps.get(demoAppId(key, ctx.principal.subject), ctx);
  const name = app?.name ?? (key === "weekly" ? "Weekly spending summary" : "Low balance alert");
  const toolCallId = grantCallId(key);
  const firstAsk = asks[0]!;
  write(writer, { type: "tool-input-start", toolCallId, toolName: firstAsk.call.tool, dynamic: true });
  // The asks' own inputPreviews ARE the honest consent copy — ride them as a
  // FIELD of the input object. Never a bare string: this part persists into
  // thread history, and the real agent's replay (convertToModelMessages →
  // Anthropic) requires `tool_use.input` to be an object — a string 400s the
  // first real prompt sent in the same thread ("Input should be an object").
  write(writer, {
    type: "tool-input-available",
    toolCallId,
    toolName: firstAsk.call.tool,
    input: { permissions: asks.map((ask) => ask.inputPreview) },
    dynamic: true,
  });
  write(writer, toVendoWirePart({
    type: "data-vendo-grant-set",
    toolCallId,
    grantSetId,
    appId: demoAppId(key, ctx.principal.subject),
    name,
    permissions: asks.map((ask) => ({
      approvalId: ask.id,
      tool: ask.call.tool,
      ...(ask.descriptor.description.length === 0 ? {} : { description: ask.descriptor.description }),
      risk: ask.descriptor.risk,
    })),
  }) as UIMessageChunk);
  write(writer, { type: "tool-approval-request", approvalId: firstAsk.id, toolCallId });
}

/** Whether the signed-in user already has an active Gmail account (the
 *  delivery channel both email automations ride). */
async function gmailConnected(principal: Principal): Promise<boolean> {
  try {
    const accounts = await vendo.connections.list(principal);
    return accounts.some((account) => account.toolkit === "gmail" && account.status === "active");
  } catch {
    return false;
  }
}

/** The delivery-channel moment: an honest connect-required ask (the REAL
 *  ConnectCard — completing OAuth wires Gmail through the live broker), or a
 *  quiet skip when Gmail is already connected. */
async function gmailDeliveryMoment(
  { writer, ctx, signal }: BeatContext,
  lineWhenMissing: string,
  cardMessage: string,
): Promise<void> {
  if (await gmailConnected(ctx.principal)) {
    await beat(400, 700);
    await streamText(writer, "Gmail is already connected, so delivery is ready to go.", signal);
    return;
  }
  await beat(600, 900);
  await streamText(writer, lineWhenMissing, signal);
  await beat(400, 700);
  const toolCallId = `${SCRIPT_CALL_PREFIX}${globalThis.crypto.randomUUID().slice(0, 12)}`;
  const connect = { connector: "composio", toolkit: "gmail", message: cardMessage };
  write(writer, { type: "tool-input-start", toolCallId, toolName: "gmail_send_email", dynamic: true });
  await sleep(400);
  write(writer, { type: "tool-input-available", toolCallId, toolName: "gmail_send_email", input: { subject: "Your week at Maple" }, dynamic: true });
  await beat(500, 800);
  write(writer, { type: "tool-output-available", toolCallId, output: { status: "connect-required", connect }, dynamic: true });
  write(writer, toVendoWirePart({ type: "data-vendo-connect", toolCallId, ...connect }) as UIMessageChunk);
}

/** The armed confirmations, shared by the beat (no grant needed on a re-run)
 *  and the approval resume. */
async function automationArmedConfirmation(context: BeatContext, key: AutomationKey): Promise<void> {
  const { writer, signal } = context;
  await beat(400, 700);
  if (key === "weekly") {
    await streamText(
      writer,
      "Set. Every Friday at 5:00 PM I'll put together that week's spending by category and have the digest drafted for you — sending is always yours, one tap. It's live under Workspace → Automations — you can pause it anytime.",
      signal,
    );
    await gmailDeliveryMoment(
      context,
      "One thing left — connect Gmail below and the first digest will be waiting there as a draft this Friday.",
      "Connect Gmail so the digest can land as a draft, ready to send.",
    );
    return;
  }
  await streamText(
    writer,
    "Armed — if checking dips below $2,000, an alert will be drafted for you that same morning. It's live under Workspace → Automations.",
    signal,
  );
  await gmailDeliveryMoment(
    context,
    "One thing left — connect Gmail below so the alert has somewhere to be drafted.",
    "Connect Gmail so the alert can land as a draft, ready to send.",
  );
}

/** The approval-resume leg for a grant-SET decision (cards c/e). The deciding
 *  surface (the in-thread set card or the workspace panel) already settled
 *  the WHOLE set over the wire with ONE decision — the automations engine's
 *  subscriber minted (or discarded) every grant; nothing is bulk-approved
 *  silently here. This leg settles the parked tool part, re-emits the
 *  automation card so "waiting on N permissions" flips live in place, and
 *  streams the confirmation. On deny, the automation is switched back off so
 *  nothing sits half-armed. */
async function automationGrantResume(
  context: BeatContext,
  key: AutomationKey,
  toolCallId: string,
  approved: boolean,
): Promise<void> {
  const { writer, ctx, signal } = context;
  const appId = demoAppId(key, ctx.principal.subject);
  if (!approved) {
    write(writer, { type: "tool-output-denied", toolCallId });
    // No disable call here: the automations engine already disarmed the app
    // inside the deny decision itself (its decide subscriber) — the card
    // re-emission below reads the settled, disabled row.
    await automationCardPart(writer, ctx, key);
    await streamText(
      writer,
      "No problem — I've switched the automation off. Nothing will run, and the declined request is recorded in Activity.",
      signal,
    );
    return;
  }
  write(writer, {
    type: "tool-output-available",
    toolCallId,
    output: { status: "ok", output: { standingGrant: "recorded", appId } },
    dynamic: true,
  });
  // Same reconciliation id as the arming turn's card: the row flips from
  // "Enabled · waiting on N permissions" to live in place (mockup §2).
  await automationCardPart(writer, ctx, key);
  await automationArmedConfirmation(context, key);
}

/** Card (c) — "Email me a weekly summary": REAL automation (enabled through
 *  the automations engine), the automation card in-thread, its standing-grant
 *  approval (approve resumes the scripted confirmation), then the Gmail
 *  connect moment. */
async function weeklyBeat(context: BeatContext): Promise<void> {
  const { writer, ctx, signal } = context;
  await beat(500, 800); // a breath before the first activity row
  await toolBeat(writer, ctx, "host_getCashflowInsights", {}, 1000);
  await beat(400, 700);
  await streamText(writer, "Setting up your Friday digest — creating the automation now.", signal);
  await beat(600, 900);
  const { enabled, missing, grantSetId } = await enableAutomation(ctx, "weekly");
  if (!enabled) {
    await streamText(writer, "I couldn't arm the weekly schedule — try Reset demo to restore the automation, then run this again.", signal);
    return;
  }
  await automationCardPart(writer, ctx, "weekly");
  await beat(700, 1000); // the card lands, then the consent moment
  if (missing.length > 0) {
    await streamText(writer, grantConsentLine(missing.length), signal);
    await beat(500, 800);
    await surfaceGrantSet(writer, ctx, "weekly", missing, grantSetId ?? `gset_weekly_${ctx.principal.subject}`);
    return; // the turn parks on the set; the resume continues it
  }
  // A re-run with the grants already standing: straight to the confirmation.
  await automationArmedConfirmation(context, "weekly");
}

/** Card (e) — "Alert me before I overdraft": narration → a real balance read
 *  → the automation card → the standing-grant approve moment → (on approve,
 *  via the resume) "Armed — …" + the Gmail delivery moment. */
async function lowBalanceBeat(context: BeatContext): Promise<void> {
  const { writer, ctx, signal } = context;
  await beat(500, 800);
  await streamText(writer, "You want a heads-up before checking runs low. Creating your automation…", signal);
  await beat(500, 800);
  const accounts = await toolBeat(writer, ctx, "host_listAccounts", {}, 900);
  await beat(400, 700);
  if (accounts.status === "ok") {
    const rows = (accounts.output as { data?: Array<{ kind?: string; balance?: number }> }).data;
    const checking = rows?.find((account) => account.kind === "checking");
    if (typeof checking?.balance === "number") {
      await streamText(writer, `Maple Checking is at ${money(checking.balance)} today, so nothing fires yet — this watches it for you.`, signal);
      await beat(400, 700);
    }
  }
  const { enabled, missing, grantSetId } = await enableAutomation(ctx, "lowbalance");
  if (!enabled) {
    await streamText(writer, "I couldn't arm the alert — try Reset demo to restore the automation, then run this again.", signal);
    return;
  }
  await automationCardPart(writer, ctx, "lowbalance");
  await beat(700, 1000);
  if (missing.length > 0) {
    await streamText(writer, grantConsentLine(missing.length), signal);
    await beat(500, 800);
    await surfaceGrantSet(writer, ctx, "lowbalance", missing, grantSetId ?? `gset_lowbalance_${ctx.principal.subject}`);
    return; // parked on the set; the resume continues
  }
  await automationArmedConfirmation(context, "lowbalance");
}

/** The scripted follow-up when someone actually completes the Gmail OAuth.
 *  Generic on purpose — either email automation (the Friday digest or the
 *  low-balance alert) can be the one that parked on the connect. */
async function gmailConnectedBeat({ writer, signal }: BeatContext): Promise<void> {
  await streamText(
    writer,
    "Gmail is connected — anything I draft for you lands there, ready to send with one tap. Your automations are fully live; they're under Workspace → Automations whenever you want to pause them.",
    signal,
  );
}

/** Card (d) — "Build my money HQ": building beats, then the saved Money HQ
 *  document embeds with the pin affordance on its bar. */
async function moneyHqBeat({ writer, ctx, signal }: BeatContext): Promise<void> {
  await beat(500, 800); // a breath before the first activity row
  await toolBeat(writer, ctx, "host_listAccounts", {}, 800);
  await toolBeat(writer, ctx, "host_listGoals", {}, 800);
  await toolBeat(writer, ctx, "host_getSpendingInsights", {}, 800);
  await beat(400, 700);
  await streamText(writer, "Here's your money HQ — balances, spending, goals, and upcoming bills in one place.", signal);
  const opened = await viewBeat(writer, ctx, demoAppId("moneyhq", ctx.principal.subject), signal);
  if (!opened) {
    await streamText(writer, "I couldn't load the saved Money HQ — try Reset demo to restore it.", signal);
    return;
  }
  await beat(500, 800);
  await streamText(writer, "Pin it to your home screen and it'll be there — live — whenever you come back.", signal);
}

const BEATS: Record<Beat, (beat: BeatContext) => Promise<void>> = {
  spending: spendingBeat,
  transfer: transferBeat,
  weekly: weeklyBeat,
  moneyhq: moneyHqBeat,
  lowbalance: lowBalanceBeat,
  gmailConnected: gmailConnectedBeat,
};

/* ------------------------------------------------------------------ */
/* the interception seam                                               */
/* ------------------------------------------------------------------ */

function scriptedRunContext(request: Request, principal: Principal): RunContext {
  return {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: request.headers.get("x-vendo-session-id") ?? "maple-scripted-demo",
    requestHeaders: Object.fromEntries(request.headers.entries()),
  };
}

function scriptedStream(
  principal: Principal,
  thread: ScriptedThread,
  execute: (writer: Writer) => Promise<void>,
): Response {
  const stream = createUIMessageStream<UIMessage>({
    originalMessages: thread.messages,
    execute: async ({ writer }) => {
      await execute(writer);
    },
    onFinish: async ({ messages }) => {
      await persistScriptedThread(principal, thread.id, messages);
    },
    onError: () => "An error occurred while generating the response.",
  });
  const response = createUIMessageStreamResponse({ stream });
  response.headers.set(THREAD_ID_HEADER, thread.id);
  return response;
}

/** The parked-call outcome the BYO approval subscriber wrote on decide —
 *  polled briefly because the client decides the guard record and re-sends
 *  the thread in quick succession. */
async function parkedOutcome(
  approvalId: string,
  subject: string,
): Promise<{ state: string; outcome?: ToolOutcome } | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const record = await vendo.store.records(PARKED_OUTCOME_COLLECTION).get(approvalId);
    if (record !== null) {
      const data = record.data as { owner?: string; state?: string; outcome?: ToolOutcome };
      if (data.owner !== subject) return null;
      return { state: data.state ?? "declined", ...(data.outcome === undefined ? {} : { outcome: data.outcome }) };
    }
    await sleep(150);
  }
  return null;
}

type ApprovalToolPart = {
  type: string;
  toolCallId: string;
  state: string;
  approval?: { id?: string; approved?: boolean };
};

/** Criterion 23 (demo-live-readiness) — a parked scripted consent ABANDONED
 *  by the next user prompt must resolve to a non-orphan state:
 *  convertToModelMessages turns a part still in `approval-requested` into a
 *  tool_use with NO tool_result, and the first real-agent prompt in the same
 *  thread 400s on replay. Settling the dangling part as denied yields the
 *  matched tool-approval-response + tool-result pair. Server-side the guard
 *  asks simply stay pending — the workspace panel can still decide them. */
function settleAbandonedScriptedApprovals(messages: UIMessage[]): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const candidate = part as unknown as ApprovalToolPart & {
        approval?: { id?: string; approved?: boolean };
      };
      if (typeof candidate.toolCallId !== "string"
        || !candidate.toolCallId.startsWith(SCRIPT_CALL_PREFIX)) continue;
      if (candidate.state !== "approval-requested" && candidate.state !== "approval-responded") continue;
      candidate.state = "output-denied";
      candidate.approval = { id: candidate.approval?.id ?? "", approved: false };
    }
  }
}

/** The scripted approval this assistant upsert answers, if any. */
function scriptedApprovalResponse(message: UIMessage): ApprovalToolPart | undefined {
  for (const part of message.parts) {
    const candidate = part as unknown as ApprovalToolPart;
    if (typeof candidate.toolCallId === "string"
      && candidate.toolCallId.startsWith(SCRIPT_CALL_PREFIX)
      && candidate.state === "approval-responded") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The seam route.ts calls: a scripted Response, or null to pass the request
 * through to the real agent handler untouched.
 */
export async function scriptedThreadsResponse(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.endsWith("/api/vendo/threads")) return null;

  let body: { threadId?: string; message?: UIMessage };
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return null;
  }
  const message = body?.message;
  if (!message || !Array.isArray(message.parts)) return null;

  const user = await resolveMapleSession(request);
  if (user === null) return null;
  const principal: Principal = { kind: "user", subject: user.subject };
  const ctx = scriptedRunContext(request, principal);
  const signal = request.signal;

  if (message.role === "user") {
    const beat = matchBeat(userText(message));
    if (beat === undefined) return null;
    const thread = await loadScriptedThread(principal, body.threadId);
    // A new prompt abandons any still-parked scripted consent: settle it to a
    // non-orphan state BEFORE this turn persists over it (criterion 23).
    settleAbandonedScriptedApprovals(thread.messages);
    upsertMessage(thread.messages, message);
    return scriptedStream(principal, thread, async (writer) => {
      write(writer, { type: "start", messageId: `msg_${SCRIPT_CALL_PREFIX}${globalThis.crypto.randomUUID().slice(0, 12)}` });
      write(writer, { type: "start-step" });
      await BEATS[beat]({ writer, ctx, signal });
      write(writer, { type: "finish-step" });
      write(writer, { type: "finish" });
    });
  }

  if (message.role === "assistant") {
    // The approval-resume upsert (sendAutomaticallyWhen): only OUR parked
    // calls are scripted; real-agent approvals pass through untouched.
    const responded = scriptedApprovalResponse(message);
    if (responded === undefined || body.threadId === undefined) return null;
    const thread = await loadScriptedThread(principal, body.threadId);
    upsertMessage(thread.messages, message);
    const approved = responded.approval?.approved === true;
    const approvalId = responded.approval?.id;
    const grantKey = GRANT_CALL_PATTERN.exec(responded.toolCallId)?.[1] as AutomationKey | undefined;
    return scriptedStream(principal, thread, async (writer) => {
      // Continue the SAME assistant message the approval parked (the live
      // resume does the same through originalMessages).
      write(writer, { type: "start", messageId: message.id });
      write(writer, { type: "start-step" });
      if (grantKey !== undefined) {
        // An automation's standing-grant decision (cards c/e). The card
        // already decided the REAL guard approval over the wire — the
        // automations engine minted (or skipped) the grant; this leg settles
        // the parked tool part and streams the scripted continuation.
        await automationGrantResume({ writer, ctx, signal }, grantKey, responded.toolCallId, approved);
      } else if (!approved) {
        write(writer, { type: "tool-output-denied", toolCallId: responded.toolCallId });
        await streamText(writer, "No problem — I've cancelled it. Nothing moved, and the declined request is recorded in Activity.", signal);
      } else {
        const resolution = approvalId === undefined ? null : await parkedOutcome(approvalId, principal.subject);
        if (resolution?.state === "executed" && resolution.outcome !== undefined) {
          write(writer, { type: "tool-output-available", toolCallId: responded.toolCallId, output: resolution.outcome, dynamic: true });
          await confirmTransfer(writer, ctx, resolution.outcome, signal);
        } else {
          write(writer, { type: "tool-output-error", toolCallId: responded.toolCallId, errorText: "The approved call did not resume." });
          await streamText(writer, "Something interrupted the transfer — your accounts are untouched. Check Activity for the record.", signal);
        }
      }
      write(writer, { type: "finish-step" });
      write(writer, { type: "finish" });
    });
  }

  return null;
}
