import {
  declaredMoneyUnit,
  type Json,
  type JsonSchema,
  USE_SERVICE_TOOL,
} from "@vendoai/core";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import { useVendoProvider } from "../context.js";
import { developmentMode } from "./dev-mode.js";
import { memberSchema, type CardFieldRow } from "./field-rows.js";
import { argValue, humanizeToolName, toolTitle, type ToolMeta } from "./humanize.js";
import type { VendoBeat } from "./run-activity.js";

/**
 * The thread's in-progress presentation speaks in the product's voice: each
 * tool call renders as a quiet human "beat" — a checklist line with a pulsing
 * orb while working and a tick when done. Labels come from the ENG-216
 * humanization pipeline (host `ToolMeta` wins, else the prettified tool id —
 * never the raw slug or a lifecycle string). The mechanical record stays in
 * the audit trail.
 */

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

function rawToolName(part: AnyToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

/** Connector tools ("slack_SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL") → toolkit slug. */
function toolkitFromToolName(name: string): string | undefined {
  const match = /^([a-z]+)_[A-Z0-9_]+$/.exec(name) ?? /^([A-Z]+)_[A-Z0-9_]+$/.exec(name);
  return match ? match[1]!.toLowerCase() : undefined;
}

/** Toolkit marks come from Composio's logo CDN, which covers its full catalog
    (chrome surfaces only — the jail blocks remote images). Unknown slugs get
    Composio's neutral placeholder rather than a 404, so `onError` fallbacks
    only fire on real network failures. */
export function toolkitLogoUrl(toolkit: string): string {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`;
}

/**
 * The consent-surface presentation of one tool call, layered on the ENG-216
 * pipeline: the title is the humanized tool label (host meta wins), the
 * question is the ask a person answers, and the description explains what
 * granting means in plain words — host meta first, else synthesized from the
 * inputs, never invented beyond them.
 */
export interface ToolPresentation {
  title: string;
  description?: string;
  /** Short toast byline for the post-approve notification. */
  sub?: string;
  toolkit?: string;
  logoUrl?: string;
  /** The ask as a QUESTION, with the one key value inline ("Send $47.50 to
      Acme Utilities?"). Synthesized ONLY from the real inputs (same honesty
      rule as `description`); absent when the inputs don't support a truthful
      one, and a consent card asks with the tool's own label instead. */
  question?: string;
  /** The input KEYS the question already names — the TOP-LEVEL arg keys,
      verbatim, so each one identifies its own `CardFieldRow.key` exactly.
      Never a substring scan of the question (a boolean input renders "No", and
      "No" lives inside plenty of innocent sentences), and never the humanized
      LABEL: `humanizeToolName` is many-to-one, so labelling `recipient_name`
      as consumed also hid a real `recipientName` the question never printed. */
  questionKeys?: string[];
  /** When approving takes effect and whose authority it runs on ("Sends now,
      as you"), in the ask's own verb — the promise under the question. */
  agency: string;
}

const agencyLine = (verb: string, trigger?: string): string => `${verb} ${trigger ?? "now"}, as you`;

/** Fields whose value can NAME the other side of an action, most specific
    first. Only these: a sentence may never guess who the counterparty is. */
const TARGET_FIELDS = ["recipient_name", "recipient", "payee", "to", "destination", "merchant", "channel"];

/**
 * The plain-words line when NOTHING truthful can be synthesized: no host
 * description, no authored one, no sentence the real inputs support.
 *
 * THE GRADE IS THE ONLY VOTER. Yousef's ruling (risk-grading redesign, D1) is
 * categorical: no code path may conclude anything from a tool's NAME. Two
 * generations of name inference lived here and both lied on a consent card —
 * first keyword regexes over the whole humanized name (a brokerage price
 * lookup, `host_getSharePrice`, matched `share` and said "This sends a message,
 * as you."), then a narrower leading-verb token, which still guessed from a
 * word list that English guarantees will miss things. A miss is silent, and a
 * hit reads as coverage. Both are gone.
 *
 * What may speak instead, in `consentWords`' order: the host's own sentence
 * (`ToolMeta.description`), the consequence synthesized from the REAL inputs,
 * and — last — this line, which says only what the GRADE licenses plus the one
 * thing always true of a Vendo call (it runs as the person approving it).
 *
 * An UNGRADED ask gets the cautious wording, never the safest-sounding one:
 * defaulting the unknown to "This reads your data" is precisely the false
 * safety the ruling exists to kill.
 */
const CLASS_LINE: Record<string, string> = {
  read: "This reads your data, as you.",
  write: "This changes something in your account, as you.",
  destructive: "This makes a change you can’t undo, as you.",
};

export function consentClassLine(risk: string): string {
  return CLASS_LINE[risk] ?? "This hasn’t been checked, so we can’t say what it changes — it runs as you.";
}

/** The M1 consent ask: the question a person answers, and the quiet notes under
    it. A card renders the notes dot-separated on one muted line. */
export interface ConsentAsk {
  question: string;
  notes: string[];
}

/** The grade in plain words, where it changes what a person should weigh. A
    read or an ordinary write is already covered by the agency phrase. */
const GRADE_NOTE: Record<string, string[]> = {
  destructive: ["Can’t be undone"],
  ungraded: ["Nobody has checked what this changes"],
};

/**
 * RULING 14 in M1's shape — the ONE plain-words ladder, shared by the approval
 * card and its queue row so a card and its row can never say different things
 * about one ask.
 *
 * The question is the ask; the notes are what approving DOES (§16 law 3 lives
 * across the pair). Precedence, most local authority first:
 *   1. the question synthesized from the REAL inputs (names the actual money and
 *      counterparty), else the ask's own humanized label as a question;
 *   2. the HOST's own sentence for this tool (in-code `ToolMeta.description`) —
 *      the only human-authored copy in the system;
 *   3. the agency phrase — when it happens, and that it happens as the person
 *      approving;
 *   4. the consequence CLASS (`consentClassLine`) when neither 1 nor 2 spoke —
 *      never the tool's own label, and it already ends "as you", so it stands
 *      alone.
 *
 * A DESCRIPTOR's description is not on this ladder at any rung. It is authored
 * for the MODEL (demo-bank's "Amounts are integer cents (e.g. 285000 =
 * $2,850.00): divide by 100…") or minted by extraction ("POST /api/demo/pin"),
 * and both reached a bank customer's consent card. Ruling 11 tried to admit a
 * "clean" descriptor sentence through a regex vocabulary; ruling 14 reversed
 * that — a regex set admitted raw JSON and exceptions while deleting good host
 * copy, so it cannot be the runtime authority for what a person may read.
 */
export function consentAsk(
  risk: string,
  presentation: ToolPresentation,
  rows: readonly CardFieldRow[],
  meta?: ToolMeta,
): ConsentAsk {
  const host = meta?.description?.trim();
  const authored = host !== undefined && host.length > 0 && host !== presentation.title ? host : undefined;
  const question = presentation.question ?? `${presentation.title}?`;
  const does = authored === undefined && presentation.question === undefined
    ? [consentClassLine(risk)]
    : [...(authored === undefined ? [] : [authored]), presentation.agency, ...(GRADE_NOTE[risk] ?? [])];
  // Rung 3 of the old description ladder — `presentation.description` — is
  // deliberately NOT read here, and the drop is loud on purpose: it is either
  // the host's `ToolMeta.description` (already `authored` above, read from the
  // host's own meta) or the connector sentence `toolPresentation` composes
  // ("Vendo will post to #renewals on your behalf, running as you."), which
  // says the question over again in weaker words. It still rides the surfaces
  // that have no question — the standing-access rows (`grant-set-card.tsx`).
  //
  // The dedupe is IDENTITY: `questionKeys` are top-level arg keys and so is
  // `CardFieldRow.key`, so a consumed input drops its own row and nothing
  // else's. Matching on the humanized LABEL hid `recipientName: "Bob Smith"`
  // when the question named `recipient_name` — a real input, displayed nowhere,
  // which is exactly what the honesty law forbids.
  const named = new Set(presentation.questionKeys ?? []);
  return {
    question,
    // THE HONESTY LAW (card-shell.tsx L37) — every real input is displayed,
    // always. The question carries the key ones; the rest are here, visible by
    // default, never behind a fold.
    notes: [
      ...rows.filter(row => !named.has(row.key)).map(row => `${row.label}: ${row.value}`),
      ...does,
    ],
  };
}

/**
 * The ONE amount an ask is about, or nothing.
 *
 * THE DEFECT this closes: this took the first numeric field whose DISPLAY
 * differed from its raw value, which is not the same question as "is this
 * money". Two ways it lied:
 *   · `{ fee_cents: 199, amount_cents: 4750 }` → "Sends $1.99 to Acme
 *     Utilities". The fee came first in the object, and the card then folded
 *     the true rows behind Details — the sentence replaced them.
 *   · a host `formatField` that formats a RATE ("5" → "5%") made that field
 *     look like money, because any changed display counted.
 *
 * Money is now `declaredMoneyUnit`'s answer (01-core: the field's own
 * declaration, never the value's magnitude), and a sentence is synthesized only
 * when EXACTLY ONE such field exists — with two, there is no single amount the
 * ask is about, so the card says no sentence and keeps every row in sight.
 * The host's formatter still supplies the DISPLAY for that one field.
 */
function moneyValue(
  args: Record<string, unknown>,
  meta?: ToolMeta,
  inputSchema?: JsonSchema,
): { key: string; shown: string } | undefined {
  const declared: { path: string[]; value: number; schema: JsonSchema | undefined }[] = [];
  collectMoney(args, inputSchema, declared);
  if (declared.length !== 1) return undefined;
  const { path, value, schema } = declared[0]!;
  // The question may only name an input that OWNS A ROW, because dropping the
  // row it named is the only way the amount prints exactly once. A NESTED
  // amount has no row of its own — `{ charge: { amount_cents: 1850 } }` is one
  // "Charge: Amount cents: $18.50" row, whose siblings would go dark if the
  // whole row were dropped — so it earns no question, and every input stays in
  // sight once. (The descent above still COUNTS at any depth: two amounts
  // anywhere means no single amount the ask is about.)
  if (path.length !== 1) return undefined;
  const key = path[0]!;
  const shown = meta?.formatField?.(key, value as Json)
    ?? argValue(key, value, schema === undefined ? undefined : { [key]: schema });
  // An undeclared unit says so out loud; that is not a question.
  return shown.includes("unit not specified") ? undefined : { key, shown };
}

/**
 * H-7 — every DECLARED money value in the args, AT ANY DEPTH.
 *
 * THE DEFECT: this counted top-level fields only, while `field-rows`' `display`
 * formats money at any depth. So `{ amount_cents: 4750, extras: { tip_cents:
 * 2500 } }` looked like exactly one amount, synthesized "Sends $47.50 to Acme
 * Utilities — now, as you.", and then FOLDED the rows behind Details — putting
 * the $25.00 tip the person was also approving one disclosure away, under a
 * sentence that did not mention it. The fold is only earned when the sentence
 * accounts for every amount in the ask; anything else and the card says no
 * sentence and keeps every row in sight.
 *
 * The descent is `display`'s own (`memberSchema`), so the sentence and the rows
 * can never disagree about what counts as money.
 */
function collectMoney(
  value: unknown,
  schema: JsonSchema | undefined,
  found: { path: string[]; value: number; schema: JsonSchema | undefined }[],
  /** The keys walked to get here — the LAST is the field's own name (what
      declares the unit), the FIRST is the row it would print on. */
  path: readonly string[] = [],
): void {
  const key = path[path.length - 1] ?? "";
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      // An array's members share their parent's name, schema and row.
      for (const item of value) collectMoney(item, memberSchema(schema, key), found, path);
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      collectMoney(item, memberSchema(schema, child), found, [...path, child]);
    }
    return;
  }
  if (typeof value === "number" && Number.isFinite(value) && declaredMoneyUnit(key, schema) !== undefined) {
    found.push({ path: [...path], value, schema });
  }
}

export function toolPresentation(
  name: string,
  args?: unknown,
  meta?: ToolMeta,
  /** The descriptor's authored label, when the caller has the descriptor
      (approval surfaces do; a bare tool beat does not). */
  descriptorTitle?: string,
  /** The declared input schema, when the caller has the descriptor: money in
      the synthesized sentence is only ever a DECLARED unit. */
  inputSchema?: JsonSchema,
): ToolPresentation {
  const flat = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  // A connector dispatch names its real action in `slug`, never in the tool
  // name: one name stands in for the broker's whole catalog, so presenting the
  // name would read "Use an outside service" for every service in it — and two
  // permissions on one consent card would be indistinguishable. The authored
  // title is dropped with it, for the same reason.
  const slug = name === USE_SERVICE_TOOL && typeof flat.slug === "string" ? flat.slug : undefined;
  const presented = slug ?? name;
  const toolkit = toolkitFromToolName(presented);
  const logoUrl = toolkit ? toolkitLogoUrl(toolkit) : undefined;
  const trigger = typeof flat.trigger === "string" ? flat.trigger
    : typeof flat.every === "string" ? `every ${flat.every}`
    : typeof flat.schedule === "string" ? flat.schedule
    : undefined;
  const title = slug === undefined
    ? toolTitle(name, meta, descriptorTitle)
    : toolTitle(slug, meta);

  let description = meta?.description;
  let sub: string | undefined;
  let question: string | undefined;
  let questionKeys: string[] | undefined;
  // The neutral promise, for an ask whose inputs name no verb of their own.
  let agency = agencyLine("Runs", trigger);
  // The host's own display for a field is its display EVERYWHERE a person reads
  // it — most of all inside the QUESTION, which is the one place the field's row
  // no longer prints. Interpolating the raw value instead put the formatted one
  // nowhere on the card: with `formatField("recipient_name") → "Maple Savings"`,
  // the ask read "Send $47.50 to acct_8820?" and the name the host wrote was
  // gone. (`moneyValue` already reads the formatter for the amount.)
  const shown = (key: string, value: string): string => meta?.formatField?.(key, value) ?? value;
  if (toolkit === "slack" && typeof flat.channel === "string") {
    const channel = shown("channel", flat.channel);
    description ??= trigger
      ? `Vendo will post to ${channel} on your behalf, ${trigger}. It runs as you.`
      : `Vendo will post to ${channel} on your behalf, running as you.`;
    sub = trigger ? `Posts to ${channel} ${trigger}` : `Posts to ${channel} as you`;
    if (typeof flat.message === "string" && flat.message.trim().length > 0) {
      question = `Post “${shown("message", flat.message)}” to ${channel}?`;
      questionKeys = ["message", "channel"];
      agency = agencyLine("Posts", trigger);
    }
  } else if (toolkit === "gmail" && typeof flat.to === "string") {
    const to = shown("to", flat.to);
    description ??= `Vendo will send this email as you${trigger ? `, ${trigger}` : ""}.`;
    sub = `Emails ${to} as you`;
    // Gmail used to synthesize nothing, because a sentence naming only `to`
    // would have FOLDED the subject/body/copied recipients out of sight. M1
    // retired the fold: every input the question doesn't name rides the quiet
    // line beneath it, visible by default — so naming the recipient in the
    // question hides nothing.
    question = `Send an email to ${to}?`;
    questionKeys = ["to"];
    agency = agencyLine("Sends", trigger);
  } else {
    // The general money case — the same idea as the Slack branch, for the asks
    // that actually gate money: a DECLARED amount plus a named counterparty is
    // enough for one truthful question ("Send $47.50 to Acme Utilities?"),
    // which is what the robotic `Vendo will run Send money as you.` replaced.
    //
    // The INPUTS decide, not the name. This branch used to be gated on the
    // tool's verb class being "money" — name inference, which the grading
    // ruling forbids outright. The gate is gone and nothing weakened: the
    // sentence still requires EXACTLY ONE field the host's own schema declares
    // as money (`moneyValue` → `declaredMoneyUnit`) AND a field from
    // `TARGET_FIELDS` naming the counterparty. That input shape IS the money
    // movement; a word list was never what made the sentence true.
    const money = moneyValue(flat, meta, inputSchema);
    const target = TARGET_FIELDS
      .map(field => [field, flat[field]] as const)
      .find((entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0);
    if (money !== undefined && target !== undefined) {
      const to = shown(target[0], target[1]);
      question = `Send ${money.shown} to ${to}?`;
      questionKeys = [money.key, target[0]];
      agency = agencyLine("Sends", trigger);
      sub ??= trigger
        ? `Sends ${money.shown} to ${to} ${trigger}`
        : `Sends ${money.shown} to ${to} as you`;
    }
  }
  return { title, description, sub, toolkit, logoUrl, question, questionKeys, agency };
}

/** Live elapsed clock for an in-flight line; 0 (never ticking) under
    prefers-reduced-motion, where a counting number is itself motion. */
function useElapsedSeconds(): number {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return elapsed;
}

/** The between-steps gap, spoken in the transcript's own beat vocabulary — a
    checklist line, not a separate pill (2026-08-06 polish: the WorkingRibbon
    shell was a second visual language for "in progress"; the beat already is
    one). Mounts at the transcript tail while the turn is busy with no live
    call and nothing streaming; the next real beat replaces it. */
export function WorkingBeat({ label = "Working" }: { label?: string }) {
  const elapsed = useElapsedSeconds();
  return (
    <div className="fl-beat fl-beat-working" role="status" aria-live="polite">
      <BeatLine mark="working" label={`${label}…`} />
      {elapsed >= 0.1 ? <span className="fl-beat-result">· {elapsed.toFixed(1)}s</span> : null}
    </div>
  );
}

/** How a beat's mark reads: in flight, parked on the user, settled, failed, or
    refused. */
type BeatMark = "working" | "waiting" | "done" | "error" | "declined";

/**
 * The ONE beat line — its mark and its words, nothing else.
 *
 * Extracted so the accumulating workspace rail and the transcript's per-tool
 * beat are literally the same line. A second beat visual would be a second
 * vocabulary for the same idea, and the two would drift on the first change.
 */
function BeatLine({ mark, label }: { mark: BeatMark; label: string }) {
  return (
    <>
      {mark === "error" || mark === "declined" ? (
        // Same glyph, different register: the error beat is danger-colored
        // (.fl-beat-error), a decline quiets to muted like any settled line.
        <span className={`fl-beat-ic${mark === "error" ? " fl-beat-x" : ""}`} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      ) : mark === "done" ? (
        <BeatTick />
      ) : (
        // The orb is a static position marker (§8 build calm). A beat PARKED on
        // the user is the one exception: nothing on our side moves, so the
        // marker turns instead — the launcher's indeterminate arc, at orb size.
        <span className={`fl-beat-orb${mark === "waiting" ? " fl-beat-ring" : ""}`} aria-hidden="true" />
      )}
      <span className="fl-beat-label">{label}</span>
    </>
  );
}

/**
 * §3.4 + §10.2 — the accumulating rail a heavy build is watched through, on the
 * EXISTING split-view stage. Quiet dot→tick lines in a vertical list, never a
 * spinner: the newest beat is the live one, everything above it has settled.
 *
 * It is NOT a live region. The between-steps ribbon beside the composer already
 * announces the latest beat, and the transcript's own beats have never
 * announced — two live regions saying the same words is the duplication the
 * ribbon/card ruling (D1) exists to prevent.
 *
 * `phase` and `appId` ride as machine affordances only. A phase is a slug, and
 * a slug is not something a person reads (the same answer `data-vendo-tool`
 * gives for a raw tool name); the label already carries the words.
 */
export function BeatRail({ beats }: { beats: readonly VendoBeat[] }) {
  if (beats.length === 0) return null;
  const active = beats.length - 1;
  return (
    <div className="fl-beatrail">
      <p className="fl-beatrail-head">Building</p>
      <ol className="fl-beats">
        {beats.map((beat, index) => (
          <li
            key={`${index}:${beat.label}`}
            className={`fl-beat ${index === active ? "fl-beat-working" : "fl-beat-done"}`}
            {...(beat.phase === undefined ? {} : { "data-vendo-phase": beat.phase })}
            {...(beat.appId === undefined ? {} : { "data-vendo-app": beat.appId })}
          >
            <BeatLine mark={index === active ? "working" : "done"} label={beat.label} />
          </li>
        ))}
      </ol>
      <p className="fl-beatrail-cap">You can close this and keep working. It carries on in the background.</p>
    </div>
  );
}

/** The settled tick — shared by a done beat and the turn's summary row. */
function BeatTick() {
  return (
    <span className="fl-beat-ic fl-beat-tick" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 12 4 4L19 6" />
      </svg>
    </span>
  );
}

/**
 * Spec §1 — the short result a settled beat earned ("Reading transactions ·
 * 142 transactions").
 *
 * Only a COUNT rides here, named by the output's own key. An arbitrary string
 * off a tool's output is the TOOL's voice (and often a raw slug or an id), and
 * this line sits in the product's own transcript — so anything we can't say in
 * plain words is simply absent, exactly like the humanization pipeline's rule
 * for labels.
 */
export function toolResultSummary(output: unknown): string | undefined {
  if (Array.isArray(output)) return countLabel(output.length, "results");
  if (typeof output !== "object" || output === null) return undefined;
  for (const [key, value] of Object.entries(output)) {
    // Identifier-shaped keys only: a key we can't humanize into words would
    // put a slug on the line.
    if (!Array.isArray(value) || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    const noun = humanizeToolName(key).toLowerCase();
    // M24 — the noun has to be a THING. A container key is the shape of the
    // payload, not what is in it, so `{ data: [6] }` read "· 6 data" and
    // `{ rows: [1] }` read "· 1 row" — the developer's word for the envelope,
    // counted like a noun. Keep looking; if no key names anything, the beat
    // says nothing (a settled tick is already the reassurance).
    if (CONTAINER_KEYS.has(noun)) continue;
    return countLabel(value.length, noun);
  }
  const count = (output as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count)
    ? countLabel(count, "results")
    : undefined;
}

/** Keys that name the ENVELOPE, never its contents (M24). */
const CONTAINER_KEYS = new Set([
  "data", "rows", "row", "items", "item", "results", "result", "records", "record",
  "values", "value", "list", "entries", "entry", "output", "outputs", "response",
  "payload", "body", "content", "contents", "nodes", "elements", "objects",
]);

/** "142 transactions" / "1 transaction"; nothing at all for an empty result —
    "0 rows" is noise on a line whose job is reassurance. */
function countLabel(count: number, noun: string): string | undefined {
  if (count <= 0) return undefined;
  const singular = count === 1 && noun.endsWith("s") ? noun.slice(0, -1) : noun;
  return `${count.toLocaleString()} ${singular}`;
}

/** M32 — the beat's `title` carried the raw slug too, and it is the surface a
    reader hovers. Same answer: dev-mode only, `data-vendo-tool` for machines. */
export function BuildBeat({
  part,
  risk,
  count = 1,
}: {
  part: AnyToolPart;
  risk: string;
  /** Collapsed-run repeat count (ENG-216) — shown as a ×N suffix. */
  count?: number;
}) {
  const { tools } = useVendoProvider();
  const name = rawToolName(part);
  const error = part.state === "output-error";
  const done = part.state === "output-available";
  const waiting = part.state === "approval-requested";
  // A refused ask is a settled outcome with a ✕, not a failure and not a
  // heartbeat: without this, a declined call's beat sat in the finished turn
  // still saying "…", as if it were about to happen.
  const declined = part.state === "output-denied";
  const label = toolTitle(name, tools[name]);
  const result = done ? toolResultSummary(part.output) : undefined;
  const mark: BeatMark = error ? "error" : declined ? "declined" : done ? "done"
    : waiting ? "waiting" : "working";
  const state = mark === "error" ? "fl-beat-error"
    : mark === "done" || mark === "declined" ? "fl-beat-done"
    : "fl-beat-working";
  return (
    <div
      className={`fl-beat ${state}`}
      data-vendo-approval={risk}
      data-vendo-tool={name}
      {...(developmentMode() ? { title: name } : {})}
    >
      <BeatLine
        mark={mark}
        label={waiting ? `${label} — waiting for your approval`
          : error ? `${label} — couldn't finish`
          : declined ? `${label} — you declined it`
          : done ? label
          : `${label}…`}
      />
      {result ? <span className="fl-beat-result">· {result}</span> : null}
      {/* M30 — `aria-label` on a plain <span> is ignored by screen readers, so a
          collapsed run announced only "×3". A role makes the label the element's
          accessible name: `img` (a graphic conveying one fact) rather than
          `group`, so the raw "×3" text is not read out after it. */}
      {count > 1 ? (
        <span className="fl-beat-count" role="img" aria-label={`repeated ${count} times`}>×{count}</span>
      ) : null}
    </div>
  );
}

/**
 * Spec §1 — the settled turn's ONE reopenable row: "✓ Did 4 things · 7.1s".
 *
 * Beats are the live record of the work; once the turn closes, history has to
 * stay scannable, so the whole checklist folds into this line and reopens on
 * click. `seconds` is the turn's measured wall time and is absent for a turn
 * nobody watched work (restored history carries no per-part timestamps, and an
 * invented duration would be a lie on a receipt).
 */
export function BeatSummary({ steps, seconds, open, onToggle }: {
  steps: number;
  seconds?: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="fl-beatsummary"
      aria-expanded={open}
      onClick={onToggle}
    >
      <BeatTick />
      <span className="fl-beatsummary-label">
        Did {steps} thing{steps === 1 ? "" : "s"}
        {seconds === undefined ? "" : ` · ${seconds.toFixed(1)}s`}
      </span>
    </button>
  );
}
