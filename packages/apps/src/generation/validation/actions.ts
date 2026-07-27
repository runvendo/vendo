/**
 * Law 2 — action-wiring honesty. A mutating action with no payload has
 * nothing to change; a submit button wired to a read tool or to nothing at
 * all is a fake affordance; an action must name a REAL host tool and its
 * payload must carry the tool's REAL input parameters. Owned here so the
 * structured-repair fix space and the create/edit validation share ONE
 * detector (actionFaults); actionIssues renders the repair-facing messages.
 */
import type { Tree } from "@vendoai/core";
import type { HostToolInfo } from "../engine.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Button labels that promise a state change. A Button carrying one of these
 *  is a submit/primary affordance: it must DO something (a mutating host tool
 *  bound to real context) or honestly say it can't — a no-op submit is the
 *  facade class. Read-only verbs (view/show/open) and dismiss verbs
 *  (cancel/clear/close) are deliberately excluded. */
export const SUBMIT_LABEL = /\b(submit|save|create|add|send|remind|reminder|transfer|pay|confirm|update|delete|remove|apply|schedule|book|post|approve|generate|register|enroll|invite|assign)\b/i;

export const isMutatingRisk = (risk: string | undefined): boolean => risk === "write" || risk === "destructive";

export const hasPayload = (payload: unknown): boolean =>
  isRecord(payload) ? Object.keys(payload).length > 0 : payload !== undefined && payload !== null;

const isActionBinding = (value: unknown): boolean =>
  isRecord(value) && typeof value.action === "string";

/** Every {action,payload?} binding reachable in a node's props, with the prop
 *  it sits under (actions can nest inside arrays/objects, not just top-level
 *  on* attributes). */
export const actionBindingsInProps = (
  props: Record<string, unknown>,
): Array<{ prop: string; action: string; payload: unknown }> => {
  const found: Array<{ prop: string; action: string; payload: unknown }> = [];
  const walk = (prop: string, value: unknown): void => {
    if (isActionBinding(value)) {
      const record = value as Record<string, unknown>;
      found.push({ prop, action: record.action as string, payload: record.payload });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(prop, item);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) walk(prop, child);
    }
  };
  for (const [prop, value] of Object.entries(props)) walk(prop, value);
  return found;
};

/** One structured action-honesty failure (the string rendering lives in
 *  actionIssues below; this shape feeds the repair fix space). The law-2
 *  grounding kinds: an action must name a REAL tool, and its payload fields
 *  must be the tool's REAL input parameters. */
export interface ActionFault {
  nodeId: string;
  kind: "dead-submit" | "missing-payload" | "read-only-submit" | "unknown-tool" | "ungrounded-payload";
  prop?: string;
  action?: string;
  label?: string;
  /** ungrounded-payload — the payload keys the tool's input schema does not declare. */
  unknownFields?: string[];
  /** ungrounded-payload — the tool's real input parameter names. */
  allowedFields?: string[];
  /** ungrounded-payload — REQUIRED input parameters absent from the payload. */
  missingFields?: string[];
}

export const actionFaults = (
  tree: Tree,
  tools: readonly HostToolInfo[] | undefined,
): ActionFault[] => {
  const byName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
  const faults: ActionFault[] = [];
  for (const node of tree.nodes) {
    const props = node.props;
    const buttonLabel = node.component === "Button" && typeof props?.label === "string" ? props.label : "";
    // Law 2 — a Kit <Form> IS a submit affordance whatever its label says.
    const isForm = node.component === "Form";
    const label = isForm
      ? (typeof props?.submitLabel === "string" ? props.submitLabel : "Submit")
      : buttonLabel;
    const submitLike = isForm || (buttonLabel !== "" && SUBMIT_LABEL.test(buttonLabel));
    const bindings = props === undefined ? [] : actionBindingsInProps(props);
    if (submitLike && bindings.length === 0) {
      faults.push({ nodeId: node.id, kind: "dead-submit", label });
    }
    for (const { prop, action, payload } of bindings) {
      if (action.startsWith("fn:")) continue;
      const tool = byName.get(action);
      if (tool === undefined) {
        // Law 2 — grounding is checkable only when the registry is known.
        if (byName.size > 0) faults.push({ nodeId: node.id, kind: "unknown-tool", prop, action, label });
        continue;
      }
      if (isMutatingRisk(tool.risk) && !hasPayload(payload)) {
        faults.push({ nodeId: node.id, kind: "missing-payload", prop, action });
      }
      if (submitLike && tool.risk === "read") {
        faults.push({ nodeId: node.id, kind: "read-only-submit", prop, action, label });
      }
      // Law 2 — payload fields must be the tool's real input parameters, and
      // every REQUIRED parameter must be present (a nonempty partial payload
      // would otherwise invoke the tool without e.g. its invoiceId).
      if (hasPayload(payload) && isRecord(payload)) {
        const schema = tool.inputSchema;
        const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
        const open = isRecord(schema) && schema.additionalProperties === true;
        if (properties !== undefined && !open) {
          const allowed = Object.keys(properties);
          const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
          const required = isRecord(schema) && Array.isArray(schema.required)
            ? schema.required.filter((field): field is string => typeof field === "string")
            : [];
          const missing = required.filter((field) => !(field in payload));
          if (unknown.length > 0 || missing.length > 0) {
            faults.push({ nodeId: node.id, kind: "ungrounded-payload", prop, action, unknownFields: unknown, allowedFields: allowed, missingFields: missing });
          }
        }
      }
    }
  }
  return faults;
};

/** The repair-facing message for each action fault. Each routes to repair,
 *  where the model binds the row/form context — or, when the host has no
 *  tool for the ask, replaces the dead button with an honest disclaimer. */
export const actionIssues = (tree: Tree, tools: readonly HostToolInfo[] | undefined): string[] =>
  actionFaults(tree, tools).map((fault) => {
    if (fault.kind === "dead-submit") {
      return `node "${fault.nodeId}" is a submit affordance ("${fault.label}") with no action — a submit that does nothing is a fake affordance. Wire its action to a host tool that performs it, binding the form/row context into payload; or if NO host tool can perform it, replace it with an honest disclaimer that the action isn't available.`;
    }
    if (fault.kind === "missing-payload") {
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes mutating tool "${fault.action}" with no payload — bind the context it acts on (a per-row id, or the form field values) into payload:{...} so the action has something to change.`;
    }
    if (fault.kind === "unknown-tool") {
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes unknown tool "${fault.action}" — law 2: an action must name a REAL host tool from the HOST TOOLS list (or fn:<name>). Pick the real tool, or render an honest disclaimer if the host has none.`;
    }
    if (fault.kind === "ungrounded-payload") {
      const unknown = fault.unknownFields ?? [];
      const missing = fault.missingFields ?? [];
      const parts = [
        ...(unknown.length === 0 ? [] : [`sends payload field(s) ${unknown.map((field) => `"${field}"`).join(", ")} the tool does not declare`]),
        ...(missing.length === 0 ? [] : [`omits the tool's REQUIRED input parameter(s) ${missing.map((field) => `"${field}"`).join(", ")}`]),
      ];
      return `node "${fault.nodeId}" prop "${fault.prop}" invokes tool "${fault.action}" but ${parts.join(" and ")} — law 2: the payload must carry exactly the tool's real input parameters (${(fault.allowedFields ?? []).join(", ")}).`;
    }
    return `node "${fault.nodeId}" submit affordance ("${fault.label}") prop "${fault.prop}" is wired to read-only tool "${fault.action}" — a submit that only reads is a fake affordance. Wire it to a mutating host tool with a payload, or render an honest disclaimer if the host has none.`;
  });
