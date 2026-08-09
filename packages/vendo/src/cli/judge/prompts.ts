import { schemaIsBlind, type ExtractedTool } from "@vendoai/actions";

/**
 * ALL prompt content for the judgment channel lives HERE — the judge pass and
 * the skeptic pass, and nothing else in the module composes model-facing text.
 *
 * The judge rules are the enrichment rules carried over with exactly three
 * changes, each one a consequence of the judgment layer replacing the
 * restrictive-only clamp:
 *
 * 1. risk may move in BOTH directions. Under the clamp a downgrade was refused
 *    and forgotten, so a model that correctly noticed a read-only handler graded
 *    destructive had no way to say so. It may now say so; the direction rule
 *    routes the claim to a human instead of discarding it.
 * 2. a wake-up (`disabled: false`) may be PROPOSED for a scanner-disabled tool.
 *    Same reasoning: fail-closed extraction disables what it cannot classify,
 *    and a model reading the handler is exactly the right thing to notice that
 *    the tool is a plain authenticated read.
 * 3. every proposal REQUIRES `evidence` — a verbatim quoted snippet from the
 *    handler. A grade with no evidence is an opinion, and opinions do not move
 *    capability. The skeptic pass then checks the quote against the real source,
 *    which is what makes the requirement bite rather than decorate.
 *
 * Nothing here is trusted. The rules tell the model what may land; the
 * deterministic direction rule in `@vendoai/actions` decides what actually does.
 *
 * The risk section also carries three LABELING-POLICY rules the mutation test
 * cannot derive on its own. Each one is here because a corpus row had to be
 * parked without it (PR #684): a catch-all URL is graded at its worst operation
 * because per-method reachability lives inside the dependency; `destructive`
 * needs bulk or irreversible loss, so a single re-creatable row delete is a
 * `write`; and an unrecallable outbound effect (mail sent, payment captured) is
 * a `write` with no row written. They are conventions, not derivations — a model
 * cannot guess them, so they have to be stated.
 */

export const JUDGE_OUTPUT_RULES = [
  "Rules:",
  "- Reply with ONLY one fenced json block matching:",
  '  { "tools": [{ "name", "evidence", "reason"?, "description"?, "title"?, "risk"?, "confirmEach"?,',
  '    "disabled"?, "audience"?, "semantics"?, "inputSchema"?, "outputSchema"? }], "narrative": string }',
  "- tools: include ONLY names from the catalog above. You may not add, rename, or rebind tools;",
  "  bindings are machine-owned and ignored if you send them.",
  "- evidence: REQUIRED on every entry — a short snippet quoted VERBATIM from the handler source",
  "  you actually read, copied character for character (<= 500 chars). A second reviewer will",
  "  look for this exact string in the file; an entry whose evidence is paraphrased, invented, or",
  "  absent is rejected outright and changes nothing. Quote the lines that justify your grades.",
  "- reason: one sentence on what that snippet proves. <= 300 chars.",
  "- description: rewrite so an agent choosing tools understands what the handler actually does",
  "  (read the source). <= 300 chars.",
  '- title: the short human label a PERSON sees for this tool in an MCP client\'s menu or an',
  '  approval card — imperative, sentence case, no tool name, no punctuation ("Send payment",',
  '  "List recent transactions"). <= 60 chars. Describe only what the tool actually does; a',
  "  title that promises more than the handler delivers is a lie, not a label. Write one for",
  "  every tool you touch.",
  "- risk: read -> write -> destructive. A tool listed as `ungraded` is one NOBODY has graded yet —",
  "  the scanner only asserts protocol facts — so every ungraded tool you read needs a grade.",
  "  The test is MUTATION OF STORED STATE — does calling this",
  "  handler change data that outlives the request? `write` creates or updates stored state;",
  "  `destructive` deletes it or changes it irreversibly; `read` does not change stored state.",
  "  The following are NOT mutations and must be graded read, however much work they do:",
  "  cache invalidation or revalidation; pure computation; serialization, formatting, or",
  "  reshaping of data already fetched; and protocol metadata (handshakes, capability or schema",
  "  listings, presigned-URL issuance that stores nothing). \"Not an application read\" is not a",
  "  reason to call something a write — the only question is whether stored state changes.",
  "  Stored state is not only your own database. An OUTBOUND side effect the caller cannot take",
  "  back is a write even when no row is written: an email or SMS sent, a webhook or push",
  "  delivered, a payment captured, an external checkout or billing-portal session created.",
  "  DESTRUCTIVE is reserved for BULK OR IRREVERSIBLE loss: a delete that spans many records",
  "  (deleteMany, truncate, purge, reset), or the loss of something that cannot be re-created",
  "  (an account and its history, an uploaded original, an audit trail). A hard delete of ONE",
  "  easily re-created row or object — remove a member, cancel an invite, remove an image — is",
  "  `write`. If every delete were destructive the top grade would mean nothing and people would",
  "  click through the one warning that matters.",
  "  A CATCH-ALL route is graded at its WORST operation. When one URL fronts many operations",
  "  (`[...nextauth]`, `[trpc]`, an upload or OAuth SDK handler), which method reaches which",
  "  operation is usually decided inside the dependency, not in this repo's source. Do not guess",
  "  a benign method split: grade the tool at the most dangerous operation reachable behind that",
  "  URL, and when you cannot determine from source which operations it exposes, grade at the",
  "  worst PLAUSIBLE one and say so in the reason.",
  "  You may move risk in BOTH directions: RAISE it when the handler mutates more than its label",
  "  admits, and LOWER it when it mutates nothing. A raise applies immediately; a lowering is",
  "  queued for a human. Do NOT hedge upward to be safe: an over-tight grade silently breaks a",
  "  working product, so hedging is not caution, it is a wrong answer.",
  "  SELF-CONSISTENCY: your grade must agree with your own reason. If your reason asserts the",
  '  handler changes no stored state, then risk must be "read". A write or destructive grade that',
  "  contradicts its own reason is dropped and reported — you gain nothing by it.",
  "  Mark irreversible operations confirmEach: true.",
  "- confirmEach / disabled: confirmEach: true and disabled: true harden the tool and apply immediately.",
  "  You may also propose the reverse — confirmEach: false, or disabled: false to WAKE a tool the",
  "  scanner disabled because it could not classify it statically. Those are queued for a human",
  "  to approve, never applied by you, and they cost the same verbatim evidence.",
  '- audience: who the handler\'s own auth admits — "end-user" (a signed-in customer acting on',
  '  their own data), "operator" (admin/staff consoles), or "internal" (machine-to-machine:',
  "  webhooks, cron, service tokens). Read the auth checks, not the route name. Narrowing",
  "  (end-user -> operator -> internal) applies and disables the tool by default; widening is",
  "  queued for a human.",
  '- semantics: response-field meanings keyed by collapsed dot path (arrays collapse:',
  '  "data.amountCents"), each one of: { "kind": "money", "unit": "cents"|"dollars", "currency"? }',
  '  | { "kind": "date", "format": "iso"|"epoch" } | { "kind": "enum", "labels": {value: label} }',
  '  | { "kind": "id", "entity"? } | { "kind": "percent", "scale": "ratio"|"0-100" } |',
  '  { "kind": "plain" }. Only include fields you read evidence for in the handler code/types.',
  '- inputSchema / outputSchema: JSON Schema for what the handler READS from the request and what it',
  '  RETURNS on success. Send one ONLY for a tool the catalog above flags "inputSchemaUnknown": true /',
  '  "outputSchemaUnknown": true. Every other slot is already filled by the host\'s own contract',
  "  (an OpenAPI spec, a tRPC .output(), a typed server action) and a proposal for it is refused",
  "  outright and counted — you gain nothing by sending it.",
  "  Describe the SHAPE THE HANDLER ACTUALLY PRODUCES, envelope included: if it returns",
  '  `Response.json({ data: rows })`, the outputSchema is the object with a `data` array, not the',
  "  array. Read the response construction and the types it is built from — never the route name.",
  "  Include enum values wherever the code constrains a field to a closed set; an enum erased to a",
  "  bare string is worse than no schema at all. Omit any field you are not sure of, and omit the",
  "  whole slot if you cannot read it: a wrong schema is a confident lie the next agent binds to.",
  "  Your evidence quote must cover the schema too — quote the response construction or the type.",
  "- narrative: a short human-readable story of what you read and what you changed — anything",
  "  suspicious especially. Plain prose, <= 30 lines.",
].join("\n");

/** The coverage question, asked once on the LAST chunk. Its answer is surfaced
 *  to the operator as a WARNING and written nowhere: adding tools is the
 *  scanner's job, and a model naming a surface is a lead, not a fact. */
const COVERAGE_QUESTION = [
  "One more thing, on this last batch only: is there any API surface in this repo that produced",
  "ZERO tools in the catalog — a router, controller directory, or endpoint family that should have",
  "been extracted and was not? Name each one (path + why) in an extra top-level key:",
  '  "missedSurfaces": [string]',
  "Name only surfaces you actually looked at. This list is shown to a human as a lead; it never",
  "adds a tool.",
].join("\n");

/** The per-tool projection the model reasons over: judgment fields only, never
 *  the machine skeleton. Schemas stay on disk where the model can read them if
 *  it needs to — putting them in the prompt only invites restatement. */
export function judgmentFacts(tools: ExtractedTool[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    binding: `${tool.binding.kind}${"method" in tool.binding && "path" in tool.binding ? ` ${String(tool.binding.method)} ${String(tool.binding.path)}` : ""}`,
    risk: tool.risk,
    ...(tool.confirmEach === true ? { confirmEach: true } : {}),
    ...(tool.disabled === true ? { disabled: true } : {}),
    ...(tool.audience === undefined ? {} : { audience: tool.audience }),
    ...(tool.title === undefined ? {} : { title: tool.title }),
    // The fill gate, stated as a FACT about each tool rather than as a rule
    // the model has to apply: a slot that is not flagged here is already
    // filled by the host's own contract and any proposal for it is refused.
    ...(schemaIsBlind(tool.inputSchemaSource) ? { inputSchemaUnknown: true } : {}),
    ...(schemaIsBlind(tool.outputSchemaSource) ? { outputSchemaUnknown: true } : {}),
    description: tool.description,
  })), null, 2);
}

export interface JudgeChunkInput {
  appName: string;
  /** The chunk's candidates, each already carrying its standing judgment (the
   *  EFFECTIVE state — otherwise the model re-proposes what already holds). */
  tools: ExtractedTool[];
  /** Tool names with HUMAN overrides — read-only context. */
  overrideNames: string[];
  chunk: { index: number; total: number };
  /** The last chunk carries the coverage question. */
  last: boolean;
}

export function composeJudgeInstructions(input: JudgeChunkInput): string {
  const { index, total } = input.chunk;
  return [
    "You are Vendo's judgment agent. A deterministic scanner already extracted this product's API",
    "tools into the catalog below; your pass adds the judgment the scanner cannot: real",
    "descriptions, risk/audience/confirmEach corrections, response-field semantics. READ THE HANDLER",
    "SOURCE for every tool you grade (Read/Glob/Grep only) — this pass is worthless guessed from",
    "names, and every grade you return has to carry a quote from the code.",
    "",
    `Product/package name: ${input.appName}`,
    ...(total > 1 ? [`This is batch ${index + 1} of ${total}. Judge only the tools listed here.`] : []),
    "",
    "Tools to judge (current effective state — skeleton plus any standing judgment):",
    judgmentFacts(input.tools),
    "",
    ...(input.overrideNames.length > 0 ? [
      "Read-only context — tools with HUMAN overrides in .vendo/overrides.json (their overrides",
      "always win over anything you write; do not restate them):",
      JSON.stringify([...input.overrideNames].sort(), null, 2),
      "",
    ] : []),
    JUDGE_OUTPUT_RULES,
    ...(input.last ? ["", COVERAGE_QUESTION] : []),
  ].join("\n");
}

/** One proposal put in front of the skeptic: the tool as it stands, the moves
 *  proposed on it, and the evidence those moves rest on. */
export interface SkepticSubject {
  tool: ExtractedTool;
  moves: Array<{ field: string; from: unknown; to: unknown }>;
  evidence: string;
  reason?: string;
}

export function composeSkepticInstructions(input: {
  appName: string;
  subjects: SkepticSubject[];
  /** The single re-ask covering whatever the first look left unexamined. */
  reask?: boolean;
}): string {
  return [
    "You are Vendo's judgment SKEPTIC. Another agent read this codebase and proposed the changes",
    "below to the product's tool catalog. You are not here to improve them — you are here to",
    "decide, one field at a time, whether the CODE actually supports each claim.",
    "",
    `Product/package name: ${input.appName}`,
    ...(input.reask === true ? [
      "",
      "This is a re-ask: your previous reply did not return a verdict for the (tool, field) pairs",
      "below. This is the FINAL look — anything you leave without a verdict is rejected.",
    ] : []),
    "",
    "For each proposal:",
    "- Find and read the handler yourself (Read/Glob/Grep only). Do not trust the summary below.",
    "- Check the evidence quote against that source, character for character. When the quote",
    "  does not appear in the source — paraphrased, reformatted, or invented — REJECT every",
    "  field resting on it.",
    "- REJECT any field the code does not support, in EITHER direction. A hardening you cannot",
    "  justify is as wrong as a loosening you cannot justify: an over-tight grade silently breaks",
    "  a working product, and a loosening hands out capability. Uphold only what you verified.",
    "- Judge each field on its own. Upholding one field of a proposal does not uphold the others.",
    "",
    "Proposals:",
    JSON.stringify(input.subjects.map((subject) => ({
      name: subject.tool.name,
      binding: `${subject.tool.binding.kind}${"method" in subject.tool.binding && "path" in subject.tool.binding ? ` ${String(subject.tool.binding.method)} ${String(subject.tool.binding.path)}` : ""}`,
      current: {
        risk: subject.tool.risk,
        ...(subject.tool.confirmEach === true ? { confirmEach: true } : {}),
        ...(subject.tool.disabled === true ? { disabled: true } : {}),
        ...(subject.tool.audience === undefined ? {} : { audience: subject.tool.audience }),
        ...(schemaIsBlind(subject.tool.inputSchemaSource) ? { inputSchemaUnknown: true } : {}),
        ...(schemaIsBlind(subject.tool.outputSchemaSource) ? { outputSchemaUnknown: true } : {}),
      },
      proposed: subject.moves.map((move) => ({ field: move.field, from: move.from, to: move.to })),
      evidence: subject.evidence,
      ...(subject.reason === undefined ? {} : { reason: subject.reason }),
    })), null, 2),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "verdicts": [{ "name", "field", "verdict": "uphold" | "reject", "reason"? }] }',
    "- Return exactly one verdict for EVERY (name, field) pair listed above. A pair you omit is",
    "  treated as rejected.",
    '- An "inputSchema" or "outputSchema" field is a claim about the handler like any other: REJECT it',
    "  unless the source really produces that shape, envelope and enum values included. A schema that",
    "  is merely plausible is a reject — the next agent binds to it as if it were the contract.",
    "- reason: one sentence, required on a reject, saying what the code actually shows. <= 300 chars.",
  ].join("\n");
}
