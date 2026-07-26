import type TS from "typescript";

type Ts = typeof TS;

/**
 * Version-tolerant accessors for TypeScript compiler APIs that the host may
 * not have: extraction loads the host's own TypeScript (see `loadTypescript`),
 * so APIs newer than the host's version must be probed before use (#551).
 * Mirrors the `decoratorsOf` fallback in graphql.ts.
 */

/** Modifiers of `node`, via TS 4.8 `canHaveModifiers`/`getModifiers` when
 * available, else the legacy `node.modifiers` property. */
export function modifiersOf(ts: Ts, node: TS.Node): readonly TS.Modifier[] {
  const modern = ts as unknown as {
    canHaveModifiers?: (node: TS.Node) => boolean;
    getModifiers?: (node: TS.Node) => readonly TS.Modifier[] | undefined;
  };
  if (modern.canHaveModifiers && modern.getModifiers) {
    return modern.canHaveModifiers(node) ? modern.getModifiers(node) ?? [] : [];
  }
  const legacy = (node as { modifiers?: readonly TS.Modifier[] }).modifiers;
  return legacy ?? [];
}

/** `ts.isSatisfiesExpression` appeared in TS 4.9. Hosts older than that
 * cannot parse `satisfies` at all, so a missing API means `node` is not one. */
export function isSatisfiesExpressionNode(ts: Ts, node: TS.Node): node is TS.SatisfiesExpression {
  const modern = ts as unknown as {
    isSatisfiesExpression?: (node: TS.Node) => node is TS.SatisfiesExpression;
  };
  return modern.isSatisfiesExpression ? modern.isSatisfiesExpression(node) : false;
}
