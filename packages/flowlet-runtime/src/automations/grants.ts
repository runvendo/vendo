/**
 * Scope-hashed pre-authorization grants (spec section b, amendment 6).
 *
 * A grant covers ONE tool on ONE version and is hashed over the tool
 * descriptor and the spec scope (trigger + top-level guard + the granting
 * step's UNRESOLVED input mapping). Any drift — a manifest republish changing
 * the tool, or an edit changing the scope — makes the hashes mismatch, and the
 * step pauses for approval instead of running unattended.
 *
 * Hashes are drift detectors, not security primitives (the store is trusted),
 * so a fast pure-JS FNV-1a keeps the runtime dependency-free and portable.
 */
import type { ToolDescriptor } from "../descriptor";
import type { AutomationSpec, AutomationStep } from "./schema";
import type { AutomationGrant } from "./store";
import { canonicalJson, fnv1a64 } from "../hashing";

export { canonicalJson, fnv1a64 };

/**
 * Hash the GRANT-RELEVANT projection of a descriptor, not the whole struct
 * (ENG-193 review 2026-07-04). `{name, source, annotations, executor}` is the
 * tool's safety identity — what it is, where it came from, what it claims
 * about danger, and where it executes. `hasExecute`/`kind` are runtime
 * mechanics that legitimately differ between a consent-time static resolver
 * and the live ingested tool (e.g. a Composio tool statically described with
 * no execute vs. the live `@composio/vercel` object that has one); hashing
 * them made every such grant silently never match. Annotation differences
 * still lapse grants — that IS the drift semantics this hash exists for.
 * `executor` is normalized (absent means "server" by the ToolDescriptor
 * contract) so hand-authored descriptors that omit it hash identically to
 * `buildDescriptor` output.
 */
export function hashDescriptor(descriptor: ToolDescriptor): string {
  const identity = {
    name: descriptor.name,
    source: descriptor.source,
    annotations: descriptor.annotations,
    executor: descriptor.executor ?? "server",
  };
  return fnv1a64(canonicalJson(identity));
}

/**
 * Ancestor control-flow context on the path to a step: every branch predicate
 * (with which arm) and every for_each (items + guard) enclosing it. A grant
 * hashed without these would survive an edit that, say, widens the enclosing
 * branch condition — a scope change in every sense that matters.
 */
function ancestryOf(
  steps: readonly AutomationStep[],
  targetId: string,
): unknown[] | undefined {
  for (const s of steps) {
    if (s.id === targetId) return [];
    if (s.type === "branch") {
      const thenPath = ancestryOf(s.then, targetId);
      if (thenPath) return [{ branch: s.id, if: s.if, arm: "then" }, ...thenPath];
      const elsePath = s.else ? ancestryOf(s.else, targetId) : undefined;
      if (elsePath) return [{ branch: s.id, if: s.if, arm: "else" }, ...elsePath];
    } else if (s.type === "for_each") {
      const childPath = ancestryOf(s.steps, targetId);
      if (childPath) {
        return [{ forEach: s.id, items: s.items, if: s.if ?? null }, ...childPath];
      }
    }
  }
  return undefined;
}

/**
 * The scope a grant covers — the FULL effective execution context (review
 * adjudication): trigger + top-level guard, the ancestor control-flow path,
 * and the granted step's whole definition (its own guard, input mapping, and
 * for agent steps goal/tools/maxToolCalls). Agentic mode (step = null) hashes
 * the execution block itself.
 */
export function hashScope(spec: AutomationSpec, step: AutomationStep | null): string {
  const ancestry =
    step !== null && spec.execution.mode === "steps"
      ? (ancestryOf(spec.execution.steps, step.id) ?? null)
      : null;
  return fnv1a64(
    canonicalJson({
      trigger: spec.trigger,
      guard: spec.if ?? null,
      ancestry,
      // The whole step object: covers tool+input+if for tool steps and
      // goal+tools+output+maxToolCalls for agent steps.
      step: step ?? null,
      execution: step === null && spec.execution.mode === "agent" ? spec.execution : null,
    }),
  );
}

export function computeGrant(args: {
  tool: string;
  descriptor: ToolDescriptor;
  spec: AutomationSpec;
  /** null for fully agentic mode (the grant covers the allowlisted tool). */
  step: AutomationStep | null;
  now: string;
}): AutomationGrant {
  return {
    tool: args.tool,
    descriptorHash: hashDescriptor(args.descriptor),
    scopeHash: hashScope(args.spec, args.step),
    grantedAt: args.now,
  };
}

/** A step runs unattended only when a grant exists AND both hashes still match. */
export function hasValidGrant(
  grants: readonly AutomationGrant[],
  args: {
    tool: string;
    descriptor: ToolDescriptor;
    spec: AutomationSpec;
    step: AutomationStep | null;
  },
): boolean {
  const descriptorHash = hashDescriptor(args.descriptor);
  const scopeHash = hashScope(args.spec, args.step);
  return grants.some(
    (g) =>
      g.tool === args.tool &&
      g.descriptorHash === descriptorHash &&
      g.scopeHash === scopeHash,
  );
}
