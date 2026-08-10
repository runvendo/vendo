/**
 * The person's real data, resolved BEFORE the model's first step.
 *
 * WHAT THIS BUYS. A screen's numbers come from host reads, and until now the
 * only way the writer could see one was to CALL it — and a call is a model step
 * out of `SCREEN_STEPS`, paid at model latency, to learn something the deployment
 * could have handed over for free. The two baselines it loses to are both handed
 * their data in the prompt and neither spends a turn fetching it. So the reads a
 * screen can need are resolved once, up front, in parallel, and printed on the
 * tool card the model is already reading.
 *
 * THE HONEST LIMIT. Only a read whose input schema says it needs no arguments can
 * be resolved before the document exists. A query with real arguments — a limit, a
 * date range, an account id — is an argument the MODEL chooses while writing, and
 * calling with `{}` to fill this section would answer a different question than the
 * screen asks and print the answer as though it were the same one. Those tools get
 * no line here and the loop calls them exactly as it does today; that is the
 * degrade, and it is why the eligibility test below is a schema test and never a
 * guess. A blind schema (`inputSchemaIsBlind`) is not a no-argument tool either —
 * that is the whole reason core distinguishes them.
 *
 * The calls go through the turn's own tools, so the guard decides them, the audit
 * records them, and a read this person may not make is simply absent.
 */
import {
  inputSchemaIsBlind,
  isVendoAppsTool,
  type JsonSchema,
  type ToolListing,
  type TurnTools,
} from "@vendoai/core";

/**
 * How many reads one screen resolves up front, and how much of the brief they may
 * take.
 *
 * The count is `queryEvidence`'s `MAX_QUERIES` for the same reason it is 8 there: a
 * tree may declare 16 queries, and a budget stated as a bound is what keeps one
 * model call from waiting on a host's entire read surface. The character bounds are
 * the brief's protection — a host read that answers with ten thousand rows is not
 * knowledge, it is the whole brief — and a result over the per-tool bound is
 * DROPPED rather than truncated: a half-printed list read as a whole one is how a
 * total ends up short, and the screen agent already knows how to call a tool.
 */
export const PREFETCH_READS = 8;
export const PREFETCH_TOOL_CHARS = 4_000;
export const PREFETCH_TOTAL_CHARS = 12_000;

/** The values one prefetch resolved: tool name → its result as compact JSON, in
 *  the same bytes the tool answered with. */
export type PrefetchedReads = ReadonlyMap<string, string>;

/** Does the host's own schema say this tool can be called with no arguments? A
 *  declared object with nothing required does; a blind slot does not, and neither
 *  does one with a required argument only the document can choose. */
const takesNoArguments = (schema: JsonSchema | undefined): boolean => {
  if (inputSchemaIsBlind(schema)) return false;
  const required = schema?.["required"];
  return !Array.isArray(required) || required.length === 0;
};

/**
 * The host reads that can be resolved before a document exists.
 *
 * `reserved` is the assembly loop's own verbs (`ASSEMBLY_TOOLS`) — asking Vendo's
 * verbs for their values up front resolves nothing about the product — and Vendo's
 * app tools go out by prefix for the same reason.
 */
export function prefetchableReads(
  listings: readonly ToolListing[],
  reserved: readonly string[],
): ToolListing[] {
  return listings
    .filter((listing) => listing.risk === "read")
    .filter((listing) => !isVendoAppsTool(listing.name) && !reserved.includes(listing.name))
    .filter((listing) => takesNoArguments(listing.inputSchema))
    .slice(0, PREFETCH_READS);
}

/**
 * Resolve them, in parallel, and keep what fits.
 *
 * Nothing here can fail a screen: a read that is denied, errors or throws is
 * absent, which is exactly the state the loop is in today. The budget is applied in
 * LISTING order after every call has settled, so the section does not change with
 * the order the host happened to answer in.
 */
export async function prefetchReads(
  tools: Pick<TurnTools, "call">,
  listings: readonly ToolListing[],
  reserved: readonly string[],
): Promise<PrefetchedReads> {
  const settled = await Promise.all(prefetchableReads(listings, reserved).map(async (listing) => {
    const result = await tools.call(listing.name, {}).catch(() => undefined);
    // `Json` is `unknown`, so an ok answer with nothing in it stringifies to
    // `undefined` — that is a tool with no values to hand over, not a value.
    const json = result?.status === "ok" ? JSON.stringify(result.output) : undefined;
    return json === undefined ? undefined : ([listing.name, json] as const);
  }));
  const resolved = new Map<string, string>();
  let spent = 0;
  for (const entry of settled) {
    if (entry === undefined) continue;
    const [name, json] = entry;
    if (json.length > PREFETCH_TOOL_CHARS || spent + json.length > PREFETCH_TOTAL_CHARS) continue;
    resolved.set(name, json);
    spent += json.length;
  }
  return resolved;
}

/**
 * What the values ARE, said once, above the tool card that carries them.
 *
 * The last sentence is the load-bearing one. These are values, not the screen's
 * data: the paint path re-runs every `<Query>` on its own, so a number typed into
 * the markup is a screenshot of one moment that goes wrong on the next open. The
 * writer is being handed the arithmetic, the ordering and the empty states — not
 * permission to stop binding.
 */
export const PREFETCH_NOTE = `Lines below with \`read just now:\` carry this person's REAL current data, already
fetched for you — you do not have to call those tools to see what they return. Use
it to get the totals, the ordering and the empty states right, and to say in words
when a result is empty. Keep declaring the \`<Query>\` and binding to it anyway: the
screen re-reads the tool every time it paints, so a number typed into the markup is
stale the next time the person opens it. A tool with no \`read just now:\` line was
not fetched — call it yourself if you need its values.`;
