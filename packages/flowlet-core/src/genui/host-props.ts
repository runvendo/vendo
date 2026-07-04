/** Server-side host-component prop validation (ENG-186 follow-up).
 *
 *  The stage already validates host-node props at genui resolution (contained
 *  placeholder) and again in the adapter — but by then the turn is over and the
 *  user sees a degraded node. Running the same check server-side, BEFORE the
 *  payload streams, turns a schema violation into a correctable tool error the
 *  model can repair, exactly like `validateGeneratedPayload`'s structural errors.
 *
 *  Semantics mirror the stage's `validateHostProps`: only SYNCHRONOUS schemas
 *  are validated; `$path` bindings are resolved against `data` first. Two
 *  server-only differences: an unknown host name is an issue here (the stage
 *  renders a visible notice instead — it cannot ask the model to retry), and a
 *  node with any `$state`-bound prop skips schema validation entirely (the
 *  state value exists only client-side; validating a binding object against
 *  the prop's schema would be a false rejection).
 */
import type { RegisteredComponent } from "../registry";
import { isPropBinding, type GeneratedPayload } from "./format";
import { resolvePointer } from "./pointer";

export interface HostPropIssue {
  nodeId: string;
  component: string;
  kind: "unknown-component" | "invalid-props";
  /** Repair-ready description, safe to hand back to the model verbatim. */
  message: string;
}

const isStateBinding = (v: unknown): boolean =>
  typeof v === "object" && v !== null && typeof (v as { $state?: unknown }).$state === "string";

const formatPath = (path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined): string => {
  if (!path || path.length === 0) return "";
  const keys = path.map((seg) =>
    typeof seg === "object" && seg !== null && "key" in seg ? String(seg.key) : String(seg),
  );
  return `${keys.join(".")}: `;
};

/** Validate every `source:"host"` node of a payload against the registry. */
export function hostPropIssues(
  payload: GeneratedPayload,
  components: readonly RegisteredComponent[],
): HostPropIssue[] {
  const byName = new Map(components.map((c) => [c.name, c]));
  const hostNames = components.filter((c) => c.source === "host").map((c) => c.name);
  const data = payload.data ?? {};
  const issues: HostPropIssue[] = [];

  for (const node of payload.nodes) {
    if (node.source !== "host") continue;

    const descriptor = byName.get(node.component);
    if (descriptor === undefined) {
      issues.push({
        nodeId: node.id,
        component: node.component,
        kind: "unknown-component",
        message:
          `node "${node.id}": unknown host component "${node.component}" — ` +
          (hostNames.length > 0 ? `registered host components: ${hostNames.join(", ")}` : "no host components are registered"),
      });
      continue;
    }

    const props = node.props ?? {};
    const values = Object.values(props);
    if (values.some(isStateBinding)) continue;

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      resolved[key] = isPropBinding(value) ? resolvePointer(data, value.$path) : value;
    }

    const result = descriptor.propsSchema["~standard"].validate(resolved);
    if (result instanceof Promise) continue; // sync-only, mirroring the stage
    if (result.issues) {
      const detail = result.issues
        .slice(0, 4)
        .map((issue) => `${formatPath(issue.path)}${issue.message}`)
        .join("; ");
      issues.push({
        nodeId: node.id,
        component: node.component,
        kind: "invalid-props",
        message: `node "${node.id}": props for host component "${node.component}" do not match its schema — ${detail}`,
      });
    }
  }

  return issues;
}
