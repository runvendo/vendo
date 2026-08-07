/**
 * The rows a finished screen actually renders, fetched so the reviewer can check
 * the numbers on it.
 *
 * THE HOLE THIS CLOSES. Live 2026-08-06 (demo-bank, "a dashboard for my upcoming
 * bills and subscriptions"): two queries whose results overlapped were summed into
 * one headline, so the screen said $11,216 where the truth was ~$6,276. Every
 * mechanical check passed — the binding was well typed, the field existed, the tool
 * was real — because a double count is not a shape error. The reviewer is the only
 * check that could catch it, and it was reading the markup with no data behind it:
 * `AppsRuntime.validate` passed no `samples` at all, so the prompt's whole
 * "check the literals against the data you were given" half had nothing to check
 * against.
 *
 * So the queries are RUN. A `<Query>`'s input is literal JSON by law
 * (`queryInputIssues` — the runtime never resolves bindings inside it), which is
 * exactly what makes this possible: the same call the screen itself makes, through
 * the same guard-bound registry, with the caller's own authority. Read risk only —
 * judging an app must never be the thing that moves money.
 */
import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { treeOf } from "./facts.js";

/**
 * The queries whose results the reviewer is shown, at most.
 *
 * `TREE_MAX_QUERIES` is 16 and every one of them is a live host call, so this is
 * the same bound stated as a review budget: a screen at the cap does not turn one
 * model call into sixteen slow reads before it.
 */
const MAX_QUERIES = 8;

/**
 * Every read-risk query on a finished screen, executed, keyed by query name — the
 * shape `reviewerCheck`'s `samples` takes.
 *
 * FAIL-OPEN like the reviewer it feeds: a query that is denied, errors, parks at an
 * approval or names a tool this caller cannot see is simply absent from the answer.
 * Evidence that could not be fetched is a reviewer with less to go on, never a
 * reason a good app dies.
 */
export const queryEvidence = async (
  document: AppDocument,
  tools: ToolRegistry,
  ctx: RunContext,
): Promise<Record<string, unknown> | undefined> => {
  const tree = treeOf(document);
  const declared = tree?.queries ?? [];
  if (declared.length === 0) return undefined;
  const descriptors = await tools.descriptors(ctx).catch(() => []);
  const readable = new Set(descriptors.filter(({ risk }) => risk === "read").map(({ name }) => name));
  // Eligibility FIRST, then the budget. Capped the other way round, eight leading
  // `fn:` queries would eat the whole allowance and the reviewer would be handed
  // nothing at all — the very state this module exists to end.
  const queries = declared
    // `fn:` is the app's own server code, not a host tool — there is nothing on
    // the registry to call.
    .filter(({ tool }) => !tool.startsWith("fn:") && readable.has(tool))
    .slice(0, MAX_QUERIES);
  const results = await Promise.all(queries
    .map(async ({ name, tool, input }) => {
      const outcome = await tools.execute(
        { id: `call_${globalThis.crypto.randomUUID()}`, tool, args: input ?? {} },
        ctx,
      ).catch(() => undefined);
      return outcome?.status === "ok" ? ([name, outcome.output] as const) : undefined;
    }));
  const fetched = results.filter((entry): entry is readonly [string, unknown] => entry !== undefined);
  return fetched.length === 0 ? undefined : Object.fromEntries(fetched);
};
