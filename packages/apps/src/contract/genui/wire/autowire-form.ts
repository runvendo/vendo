/**
 * Internal: the form-submit autowire post-pass (runs beside checkBindingShapes
 * in compile.ts's `finishResult`).
 *
 * `<Form onSubmit="cancel_transfer"><Select .../></Form>` is the shape a writer
 * reaches for constantly, and until now it compiled to a DEAD button: nothing
 * routed a field's value into the action's arguments, so the renderer sent
 * exactly the payload the wire declared — nothing — and the tool refused the
 * call for a missing required argument. Every mechanical check passed; only a
 * browser press could see it. Seven of seven observed failures of this kind were
 * this one shape.
 *
 * The fix is the compiler's, not the writer's: a required argument the payload
 * does not name, and a field inside the form that can supply it, is a wire the
 * compiler can draw with certainty. It gives that field the HTML `name` of the
 * argument; the Kit's `Form` submits its own `FormData` and the renderer passes
 * those values as the call's arguments (`ui/src/kit/forms/form.tsx`,
 * `ui/src/tree/renderer.tsx`). Plain HTML form semantics, so what submits is
 * what the form is showing — no state slot, no change handler, nothing to seed.
 *
 * Deliberately narrow: it never invents a value, never names an argument the
 * tool did not ask for, and when no field clearly owns a key it leaves the form
 * alone rather than guess.
 */

import { defineOwn, isPlainObject, type Json, type TreeNode } from "@vendoai/core";

/** The Kit fields whose DOM control carries a submittable value. Checkbox is
 *  out: `FormData` omits an unchecked box entirely, so a boolean argument would
 *  go missing exactly half the time. */
const FIELD_COMPONENTS: ReadonlySet<string> = new Set(["Select", "Input", "DatePicker", "Textarea"]);

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/** Fields under a form, in document order — the whole subtree, so a field
 *  inside a `<Row>` or `<Surface>` still counts. */
const descendantFields = (form: TreeNode, byId: ReadonlyMap<string, TreeNode>): TreeNode[] => {
  const found: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    for (const childId of node.children ?? []) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      if (FIELD_COMPONENTS.has(child.component)) found.push(child);
      walk(child);
    }
  };
  walk(form);
  return found;
};

/** A field is claimable only while it carries no `name` of its own — a writer
 *  who named it has already said which argument it fills. */
const claimable = (field: TreeNode): boolean => field.props === undefined || own(field.props, "name") === undefined;

/**
 * The one certainty rule: a `<Select valueField="id">` says outright that its
 * value IS the `id`; otherwise a single unclaimed field in a form missing a
 * single argument has nowhere else its value could be going. Anything less
 * certain gets no wire.
 */
const pickField = (fields: readonly TreeNode[], key: string, missingCount: number): TreeNode | undefined => {
  const named = fields.find((field) =>
    claimable(field) && field.props !== undefined && own(field.props, "valueField") === key);
  if (named !== undefined) return named;
  const free = fields.filter(claimable);
  return missingCount === 1 && free.length === 1 ? free[0] : undefined;
};

/**
 * Names each Form field after the required submit argument it supplies. Mutates
 * `nodes` in place; `toolInputs` maps tool name → its JSON-schema input (the
 * host's own declaration).
 */
export const autowireFormSubmits = (
  nodes: readonly TreeNode[],
  toolInputs: Readonly<Record<string, unknown>>,
): void => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.component !== "Form" || node.props === undefined) continue;
    const submit = own(node.props, "onSubmit");
    if (!isPlainObject(submit) || typeof submit.action !== "string") continue;
    const schema = own(toolInputs as Record<string, unknown>, submit.action);
    if (!isPlainObject(schema) || !Array.isArray(schema.required)) continue;
    // A payload the writer wrote is a decision the renderer already honours over
    // anything the form submits, so those arguments are not missing.
    const declared = isPlainObject(submit.payload) ? submit.payload : {};
    const missing = schema.required.filter((key): key is string =>
      typeof key === "string" && own(declared, key) === undefined);
    if (missing.length === 0) continue;

    const fields = descendantFields(node, byId);
    for (const key of missing) {
      const field = pickField(fields, key, missing.length);
      if (field === undefined) continue;
      if (field.props === undefined) field.props = {};
      defineOwn<Json>(field.props, "name", key);
    }
  }
};
