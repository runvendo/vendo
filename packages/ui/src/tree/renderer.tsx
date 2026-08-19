import {
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  applyReshape,
  isPathBinding,
  isStateBinding,
  VENDO_TREE_FORMAT,
  type ApprovalId,
  type Json,
  type PathBinding,
  type ToolOutcome,
  type TreeNode,
  type UIPayload,
} from "@vendoai/core";
import {
  KIT_COMPONENT_NAMES,
  KIT_OVERLAY_SPECS,
  SCREEN_TEXT_NODE,
  evaluateExpr,
  isExprBinding,
  warmExprRuntime,
} from "@vendoai/apps/contract";
import { convertPayload } from "./convert-payload.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useVendoThemeOrDefault } from "../context.js";
import { themeCssVariables } from "../theme.js";
import type { InClientVenue, SeedDrift } from "../wire-types.js";
import { resolvePointer } from "./bindings.js";
import { DISPLAY_BRICKS, SURFACE_CONTAINMENT, safeProps } from "./display-bricks.js";
import { NodeErrorBoundary } from "./error-boundary.js";
import { FluidReveal } from "./fluid-reveal.js";
import { deriveFormShape, FormingContext, FormingSkeleton, PendingLeaf } from "./forming-skeleton.js";
import { InClientMount, type InClientFurnishing } from "./host-mount.js";
import { ContainedNotice } from "./notice.js";
import { playNodeMotion, useMotionLayoutEffect, useRepaintMotion, type NodeMark } from "./repaint-motion.js";
import { KIT_COMPONENTS } from "../kit/registry.js";
import { ensureKitStyles } from "../kit/kit-css.js";
import { markHandlerCallback, screenEvent } from "../kit/handler.js";
import { useKeyedState } from "../kit/state.js";
import { useParkedApprovals } from "./parked-approvals.js";
import type { ScreenInteractive, ScreenQuery } from "./screen-engine.js";
import { useScreen, type ScreenBridge } from "./use-screen.js";

/** A press the guard sent to approval, announced through `onParked`. */
export interface ParkedPress {
  nodeId: string;
  approvalId: ApprovalId;
}

export interface TreeViewProps {
  tree: WalkTree;
  /**
   * Which app this tree belongs to — the `$state` and outcome namespace's
   * identity. A caller that can render a DIFFERENT app in the same position
   * passes it; see {@link TreeView} for what it buys.
   */
  appId?: string;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  /**
   * Fires the instant a press is PARKED on an approval. The tree resolves the
   * approval on its own (parked-approvals.ts) and repaints when it lands; this
   * is the seam for a surface that wants to put the decision in front of the
   * person instead of leaving them to go find it.
   */
  onParked?: (parked: ParkedPress) => void;
  /**
   * 08-ui §5; 06-apps §6 — additive persistence hook for TreeView-local `$state`.
   * It fires with the complete state map after every `vendo.setState` write.
   */
  onStateChange?(state: Record<string, Json>): void;
  /**
   * A component screen's live half: the compiled source and the query results it
   * was painted against. `tree` is that screen's FIRST paint and renders on its
   * own; supplying this additionally boots the screen behind it, so its
   * `{$handler}` props become real callbacks (use-screen.ts). Absent — every
   * payload before component screens — nothing boots and nothing changes.
   */
  interactive?: ScreenInteractive;
  /**
   * The wall a live screen's dates and money resolve against: a locale, and an
   * IANA zone. The screen engine carries no ICU, so both are answered by the
   * host's real `Intl` against these two — and unset they are `"en-US"` and
   * `"UTC"`, which is a server's wall. A surface that wants the VIEWER's says so:
   * `timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}`.
   */
  locale?: string;
  timeZone?: string;
}

export interface PayloadRendererProps {
  payload: UIPayload;
  /** As {@link TreeViewProps.appId}. */
  appId?: string;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  /** As {@link TreeViewProps.onParked}. */
  onParked?: (parked: ParkedPress) => void;
  onStateChange?(state: Record<string, Json>): void;
  /** As {@link TreeViewProps.locale} and {@link TreeViewProps.timeZone}. */
  locale?: string;
  timeZone?: string;
}

/**
 * The walk's input: the shared render mechanics' tree shape (nodes,
 * path-keyed resolved queries, grafted components, payload extras).
 * convert-payload converts the canonical tree into this shape (named
 * queries → "/" + name pointers).
 */
export interface WalkTree {
  root: string;
  nodes: TreeNode[];
  data?: Record<string, Json>;
  queries?: Array<{ path: string; tool: string; input?: Record<string, Json> }>;
  components?: Record<string, string>;
}

type WalkValidation =
  | { ok: true; tree: WalkTree }
  | { ok: false; error: { code: "provision"; message: string } };

const walkFail = (message: string): WalkValidation => ({ ok: false, error: { code: "provision", message } });

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The structural render-gate (per-render hot path): ids unique and rooted,
 *  node shapes sane, generated components present. Format-tag checks live one
 *  layer up (PayloadView dispatch + validateTree in convert-payload). */
const validateWalkTree = (input: WalkTree): WalkValidation => {
  const ids = new Set<string>();
  if (!Array.isArray(input.nodes)) return walkFail("nodes must be an array");
  for (const node of input.nodes) {
    if (!isPlainRecord(node)) return walkFail("each node must be an object");
    if (typeof node.id !== "string" || node.id.length === 0) return walkFail("each node must have a non-empty string id");
    if (typeof node.component !== "string") return walkFail(`node "${node.id}" must have a string component`);
    if (node.source !== undefined && !["prewired", "host", "generated"].includes(node.source as string)) {
      return walkFail(`node "${node.id}" has an invalid source`);
    }
    if (node.children !== undefined
      && (!Array.isArray(node.children) || !node.children.every((child) => typeof child === "string"))) {
      return walkFail(`node "${node.id}" children must be an array of strings`);
    }
    if (node.props !== undefined && !isPlainRecord(node.props)) return walkFail(`node "${node.id}" props must be a plain object`);
    if (ids.has(node.id)) return walkFail(`duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  const components = input.components ?? {};
  // The compile bounds hold per render: Kit names can never be shadowed
  // and the 01-core §8 component caps apply even to payloads that bypassed
  // document validation (direct TreeView input).
  const names = Object.keys(components);
  if (names.length > TREE_MAX_GENERATED_COMPONENTS) {
    return walkFail(`too many generated components (max ${TREE_MAX_GENERATED_COMPONENTS})`);
  }
  let totalChars = 0;
  for (const name of names) {
    if (KIT_COMPONENT_NAMES.includes(name)) {
      return walkFail(`generated component "${name}" shadows a Kit component name`);
    }
    const source = components[name];
    if (typeof source !== "string") return walkFail(`generated component "${name}" source must be a string`);
    if (source.length > TREE_MAX_COMPONENT_SOURCE_CHARS) {
      return walkFail(`generated component "${name}" source is too large`);
    }
    totalChars += source.length;
  }
  if (totalChars > TREE_MAX_TOTAL_COMPONENT_CHARS) {
    return walkFail("generated component sources exceed the total size cap");
  }
  for (const node of input.nodes) {
    if (node.source === "generated" && !Object.prototype.hasOwnProperty.call(components, node.component)) {
      return walkFail(`node "${node.id}" references generated component "${node.component}" with no definition in components`);
    }
  }
  if (typeof input.root !== "string" || !ids.has(input.root)) {
    return walkFail(`root "${String(input.root)}" does not match any node id`);
  }
  return { ok: true, tree: input };
};

/** A payload's interactive half, read like every other payload extra: it is a
 *  wire value, so only a well-formed one speaks and a malformed one leaves the
 *  tree exactly as static as it was. */
const readInteractive = (payload: UIPayload): ScreenInteractive | undefined => {
  const value = (payload as { interactive?: unknown }).interactive;
  if (!isPlainRecord(value) || typeof value.compiledSource !== "string") return undefined;
  const plan = Array.isArray(value.queryPlan)
    ? value.queryPlan.filter((entry): entry is ScreenQuery => isPlainRecord(entry) && typeof entry.tool === "string")
    : [];
  return {
    compiledSource: value.compiledSource,
    queries: isPlainRecord(value.queries) ? value.queries : {},
    ...(plan.length === 0 ? {} : { queryPlan: plan }),
  };
};

/** A validated payload converts to the walk tree and renders through the same
 *  TreeView (convert-payload.ts documents the mapping). */
function VendoTreeRenderer({ payload, ...props }: PayloadRendererProps) {
  const converted = useMemo(() => convertPayload(payload), [payload]);
  const interactive = useMemo(() => readInteractive(payload), [payload]);
  if (!converted.ok) {
    // A mid-stream partial legitimately passes through shapes the validator
    // has not admitted yet — hold the forming skeleton; the notice is a
    // verdict reserved for FINAL payloads.
    if ((payload as { streaming?: unknown }).streaming === true) {
      return <FormingSkeleton name="StreamingTree" />;
    }
    return (
      <ContainedNotice label="Invalid UI tree" code={converted.error.code}>
        {`${converted.error.code}: ${converted.error.message}`}
      </ContainedNotice>
    );
  }
  return <TreeView tree={converted.tree} {...(interactive === undefined ? {} : { interactive })} {...props} />;
}

/** Dispatch is exclusively by the payload tag. */
export function PayloadView(props: PayloadRendererProps) {
  if (props.payload.formatVersion !== VENDO_TREE_FORMAT) {
    return (
      <ContainedNotice label="Unsupported UI format">
        {`No renderer is registered for "${props.payload.formatVersion}".`}
      </ContainedNotice>
    );
  }
  return <VendoTreeRenderer {...props} />;
}

interface ActionBinding {
  $action: string;
  payload?: Json;
}

/** 08-ui §5 — renderer-owned additive binding; action names stay opaque. */
export function isActionBinding(value: unknown): value is ActionBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $action?: unknown }).$action === "string";
}

interface HandlerBinding {
  $handler: string;
}

/** `isActionBinding`'s sibling: a component screen's event props name one of the
 *  screen's own handlers. Handler ids stay as opaque as action names — the
 *  renderer routes `"h3"` to the live screen and never reads it. */
export function isHandlerBinding(value: unknown): value is HandlerBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $handler?: unknown }).$handler === "string";
}

/**
 * A Kit element a screen wrote INTO a prop — a table column's `cell`, an
 * accordion item's `content`. It crosses the VM as data, stamped `$element`
 * (apps genui/component/vm-program.ts `emitValue`), and is reified here.
 */
interface ElementBinding {
  component: string;
  props?: Record<string, unknown>;
  children?: readonly unknown[];
}

const isElementNode = (value: unknown): value is ElementBinding =>
  isPlainRecord(value) && typeof value.component === "string";

/** The sigil rides on the prop's own element and on nothing else: a data object
 *  that happens to carry a `component` string is still data. */
const isElementBinding = (value: unknown): value is ElementBinding =>
  isElementNode(value) && (value as { $element?: unknown }).$element === true;

/** That element, back as an element: the Kit component or display brick it
 *  names — resolved exactly as `builtinContent` resolves a node, so a slot and a
 *  child admit the same vocabulary — its own props bound the same way, its
 *  children in order. An unknown name renders nothing rather than throwing —
 *  a slot fails soft, like every other node here. */
function reifyElement(node: ElementBinding, bind: (value: unknown) => unknown): ReactNode {
  const Implementation = (KIT_COMPONENTS[node.component] ?? DISPLAY_BRICKS[node.component]) as ComponentType<Record<string, unknown>> | undefined;
  if (Implementation === undefined) return null;
  // Only the prop's own element carries the sigil; the ones under it are nodes.
  const children = node.children?.map((child, index) => typeof child === "string"
    ? child
    : <Fragment key={index}>{isElementNode(child) ? reifyElement(child, bind) : null}</Fragment>);
  return <Implementation {...safeProps(bind(node.props ?? {}) as Record<string, unknown>)}>{children}</Implementation>;
}

/** The node's own handler dispatch, node-scoped by NodeRenderer. */
type HandlerDispatch = (handlerId: string, event?: unknown) => void;

/** Apply a binding's `$reshape` chain to the resolved value.
 *  `applyReshape` is total: absent data passes through (loading is not a
 *  mismatch); a real mismatch reports through `onMismatch` and binds
 *  `undefined`, and the node renders the contained data-shape notice. */
function resolveReshaped(
  resolved: Json | undefined,
  steps: PathBinding["$reshape"],
  onMismatch?: (reason: string) => void,
): unknown {
  if (steps === undefined) return resolved;
  const reshaped = applyReshape(resolved, steps);
  if (!reshaped.ok) {
    onMismatch?.(reshaped.reason);
    return undefined;
  }
  return reshaped.value;
}

function bindValue(
  value: unknown,
  data: Record<string, Json>,
  state: Record<string, Json>,
  action: (name: string, payload?: Json) => Promise<ToolOutcome>,
  handle: HandlerDispatch | undefined,
  onMismatch?: (reason: string) => void,
): unknown {
  if (isPathBinding(value)) return resolveReshaped(resolvePointer(data, value.$path), value.$reshape, onMismatch);
  if (isStateBinding(value)) return resolveReshaped(state[value.$state] as Json | undefined, value.$reshape, onMismatch);
  // A computed value is evaluated HERE, on every bind resolution, against the
  // data this render holds — so it re-computes the moment the query data
  // changes. Nothing about it is ever cached across renders. The expression is
  // JavaScript, run in a sealed interpreter that cannot reach this page.
  if (isExprBinding(value)) {
    const computed = evaluateExpr(value.$expr, data);
    if (!computed.ok) {
      onMismatch?.(computed.issue);
      return undefined;
    }
    return computed.value;
  }
  if (isActionBinding(value)) {
    const payload = bindValue(value.payload, data, state, action, handle, onMismatch) as Json;
    return () => action(value.$action, value.payload === undefined ? undefined : payload);
  }
  // With no screen behind it a handler becomes an INERT callback: the prop is a
  // callback SLOT, and a control that calls `onClick?.()` on the binding object
  // raises a TypeError no boundary catches. Unmarked, so the control keeps the
  // uncontrolled DOM it has — a marked no-op would freeze the box a person types
  // in (kit/handler.ts).
  if (isHandlerBinding(value)) {
    return handle === undefined
      ? () => undefined
      : markHandlerCallback((event?: unknown) => handle(value.$handler, screenEvent(event)));
  }
  if (isElementBinding(value)) {
    return reifyElement(value, (child) => bindValue(child, data, state, action, handle, onMismatch));
  }
  if (Array.isArray(value)) return value.map((item) => bindValue(item, data, state, action, handle, onMismatch));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      bindValue(child, data, state, action, handle, onMismatch),
    ]));
  }
  return value;
}

/** Binds a node's props, reporting the first reshape mismatch with its prop
 *  name: the region shows one contained notice, not a broken component. The
 *  bound props leave through {@link safeProps}, the one style door every node
 *  passes (display-bricks.tsx). */
function bindProps(
  props: Record<string, Json> | undefined,
  data: Record<string, Json>,
  state: Record<string, Json>,
  action: (name: string, payload?: Json) => Promise<ToolOutcome>,
  handle?: HandlerDispatch,
): { bound: Record<string, unknown> | undefined; mismatch: string | null } {
  if (props === undefined) return { bound: undefined, mismatch: null };
  let mismatch: string | null = null;
  let currentProp = "";
  const onMismatch = (reason: string): void => {
    if (mismatch === null) mismatch = `prop "${currentProp}": ${reason}`;
  };
  const bound = Object.fromEntries(Object.entries(props).map(([key, child]) => {
    currentProp = key;
    return [key, bindValue(child, data, state, action, handle, onMismatch)];
  }));
  return { bound: safeProps(bound), mismatch };
}

/** Single-flight: while one of this node's handlers has an intent in flight the
 *  control that fired it renders disabled, so the second click on a cancel button
 *  cannot send a second cancel. */
const handlerBusy = (props: Record<string, Json> | undefined, inFlight: ReadonlySet<string>): boolean =>
  props !== undefined
  && Object.values(props).some((value) => isHandlerBinding(value) && inFlight.has(value.$handler));

/** The contained data-shape notice: the region says the data
 *  didn't match instead of mounting the component with garbage props. While
 *  the payload is a mid-stream partial the mismatch is a transient (the
 *  binding may still be rewritten before ship), so the region holds the
 *  forming skeleton instead — the notice is a verdict for FINAL payloads. */
const dataShapeNotice = (mismatch: string, streaming: boolean, name: string): ReactNode => streaming
  ? <FormingSkeleton name={name} />
  : (
    <ContainedNotice label="Data shape">
      {`The data didn't match this component's binding — ${mismatch}.`}
    </ContainedNotice>
  );

function outcomeNotice(
  outcome: ToolOutcome | undefined,
  /** Re-raise this node's park. Absent when nobody is listening for one. */
  onReview?: (approvalId: ApprovalId) => void,
): ReactNode {
  if (!outcome || outcome.status === "ok") return null;
  if (outcome.status === "pending-approval") {
    // The ask can be dismissed (Esc closes the modal without deciding), and
    // this notice is the way back to it — the SAME box, now pressable, rather
    // than a second affordance nobody would find. The id stays a dev-mode aid.
    const approvalId = outcome.approvalId;
    return (
      <ContainedNotice
        label="Action pending approval"
        outcome={outcome.status}
        detail={`(${approvalId})`}
        {...(onReview === undefined ? {} : { onPress: () => onReview(approvalId) })}
      >
        {onReview === undefined ? "Waiting for your approval." : "Waiting for your approval — review"}
      </ContainedNotice>
    );
  }
  if (outcome.status === "blocked") {
    return <ContainedNotice label="Action blocked" outcome={outcome.status}>{outcome.reason}</ContainedNotice>;
  }
  if (outcome.status === "error") {
    return (
      <ContainedNotice label="Action error" outcome={outcome.status} code={outcome.error.code}>
        {outcome.error.message}
      </ContainedNotice>
    );
  }
  return null;
}

/**
 * An answer belongs to the node that fired the press — and a generated screen
 * routinely closes the confirm panel that node lived in, which used to take the
 * answer off the page with it (the button pressed, then nothing, forever). Node
 * ids are structural paths (apps/contract/genui/component/flatten.ts), so the
 * notice climbs instead: the longest dot-prefix that still names a live node
 * carries it, worst case the root. Two orphans that reach the same ancestor
 * both render, stacked in the order their slots were filled.
 */
function orphanedOutcomes(
  outcomes: Record<string, ToolOutcome | undefined>,
  nodes: ReadonlyMap<string, TreeNode>,
): ReadonlyMap<string, Array<[string, ToolOutcome]>> {
  const homed = new Map<string, Array<[string, ToolOutcome]>>();
  for (const [nodeId, outcome] of Object.entries(outcomes)) {
    if (outcome === undefined || nodes.has(nodeId)) continue;
    let host = nodeId;
    while (!nodes.has(host)) {
      const cut = host.lastIndexOf(".");
      if (cut < 0) break;
      host = host.slice(0, cut);
    }
    if (!nodes.has(host)) continue;
    const slot = homed.get(host);
    if (slot === undefined) homed.set(host, [[nodeId, outcome]]);
    else slot.push([nodeId, outcome]);
  }
  return homed;
}

interface NodeRendererProps {
  nodeId: string;
  ancestry: ReadonlySet<string>;
  nodes: ReadonlyMap<string, TreeNode>;
  generated: Record<string, string>;
  /** True ONLY when the payload's server-written verdict granted the venue. */
  inClientGranted: boolean;
  furnishings: Record<string, InClientFurnishing>;
  components: Record<string, ComponentType>;
  data: Record<string, Json>;
  state: Record<string, Json>;
  streaming: boolean;
  outcomes: Record<string, ToolOutcome | undefined>;
  /** Outcomes whose own node left the tree, re-homed on the nearest surviving
   *  ancestor by {@link orphanedOutcomes}: ancestor id → the fired ids it carries. */
  orphans: ReadonlyMap<string, Array<[string, ToolOutcome]>>;
  runAction(nodeId: string, action: string, payload?: Json): Promise<ToolOutcome>;
  /** Re-raise a node's park, so a dismissed ask can be asked again. Absent when
   *  the caller passed no `onParked` — there would be nowhere to raise it. */
  onReview?(nodeId: string, approvalId: ApprovalId): void;
  setViewState(key: string, value: Json): void;
  /** The live screen behind this tree, when there is one. */
  screen?: Pick<ScreenBridge, "fire" | "inFlight">;
  /** What this repaint moved, per node (repaint-motion.ts). Empty on a first paint. */
  marks: ReadonlyMap<string, NodeMark>;
}

const EMPTY_LAYOUT_COMPONENTS = new Set(["Stack", "Row", "Grid", "SplitPane"]);

/**
 * The `$expr` interpreter is a WebAssembly module that loads once. Evaluation
 * itself is synchronous, so the only thing this hook buys is ONE re-render when
 * the module lands — otherwise a computed value would stay empty until some
 * other state moved. It costs nothing in the common case: query data arrives
 * over the network, so a tree that has anything to compute is re-rendering
 * anyway by the time the boot finishes.
 */
const useExprRuntime = (): void => {
  const [, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void warmExprRuntime().then(() => {
      if (live) setReady(true);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, []);
};

const hasRenderableTreeContent = (tree: WalkTree, streaming: boolean): boolean => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const pending = [tree.root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    // A missing child renders the streaming skeleton, which is intentionally visible.
    if (node === undefined) return true;
    if (node.source === "host" || node.source === "generated") return true;
    // Mid-build a node arrives as bare geometry — props and `source` alike
    // stripped (apps `persistence/forming.ts`). Such a node either holds its own
    // silhouette (`builtinContent`) or is a container whose leaves do, so either
    // way something paints. Without this a forming tree of layout and `Text`
    // collapsed to a single skeleton and stopped growing on screen.
    if (streaming && node.source === undefined && node.props === undefined) return true;
    if (node.component === "Text") {
      const text = node.props?.text;
      if (text !== undefined && text !== null && String(text).trim() !== "") return true;
    } else if (!EMPTY_LAYOUT_COMPONENTS.has(node.component)) {
      return true;
    }
    pending.push(...(node.children ?? []));
  }
  return false;
};

/** What one node's content is built from, once {@link NodeRenderer} has settled
 *  the node, its children and the dispatchers they close over. */
interface NodeContent {
  props: NodeRendererProps;
  node: TreeNode;
  children: ReactNode;
  invoke: (action: string, payload?: Json) => Promise<ToolOutcome>;
  handle: HandlerDispatch | undefined;
}

/** 06-apps §9 — the approved venue: this exact version's content hash matched a
 *  stored approval, so generated code mounts in the host page. */
function inClientContent(
  { props, node, children, invoke, handle }: NodeContent,
  source: string,
): ReactNode {
  const { bound, mismatch } = bindProps(node.props, props.data, props.state, invoke, handle);
  if (mismatch !== null) {
    return <>{dataShapeNotice(mismatch, props.streaming, node.component)}{children}</>;
  }
  return (
    <>
      <InClientMount
        name={node.component}
        source={source}
        props={bound}
        furnishing={props.furnishings[node.component]}
        onAction={invoke}
        onStateSet={props.setViewState}
      />
      {children}
    </>
  );
}

/** The `source: "generated"` branch — human-approved code, mounted in the host
 *  page when the venue was granted. There is no second venue: an ungranted node
 *  drops back to a contained notice, never to a silent hole. */
function generatedContent(context: NodeContent): ReactNode {
  const { props, node } = context;
  const source = props.generated[node.component];
  const revealKey = source === undefined ? "forming" : "ready";
  let content: ReactNode;
  if (source === undefined) {
    content = props.streaming ? (
      <span data-streaming-component={node.component} style={{ display: "block", width: "100%" }}>
        <FormingSkeleton name={node.component} />
      </span>
    ) : (
      <ContainedNotice label="Unknown generated component">
        {`Generated component "${node.component}" has no source.`}
      </ContainedNotice>
    );
  } else if (props.inClientGranted) {
    content = inClientContent(context, source);
  } else {
    content = (
      <ContainedNotice label="Not approved for this page" outcome="blocked">
        {`"${node.component}" needs a host reviewer's approval before it can run here.`}
      </ContainedNotice>
    );
  }
  // ENG-205 render-slot morph: the streaming placeholder and the arrived
  // component share this wrapper, so the swap morphs instead of popping.
  // Pick A: a shape-derived silhouette already holds (approximately) the
  // final geometry, so its reveal crossfades in place (.fl-reveal-fill)
  // instead of running the rise/settle morph; slab fallbacks keep the morph.
  return (
    <FluidReveal
      stateKey={revealKey}
      className={deriveFormShape(node.component) === "slab" ? undefined : "fl-reveal-fill"}
    >
      {content}
    </FluidReveal>
  );
}

/** Which implementation wins for a built-in node. An explicit `source: "host"`
 *  means the host brand won the name. An undefined (or "prewired") source keeps
 *  the built-in first, so a stored app whose node collides with a host catalog
 *  name still renders the built-in it was written against. */
function resolveBuiltin(node: TreeNode, components: NodeRendererProps["components"]): ComponentType<Record<string, unknown>> | undefined {
  const kit = (KIT_COMPONENTS[node.component] ?? DISPLAY_BRICKS[node.component]) as ComponentType<Record<string, unknown>> | undefined;
  const host = components[node.component] as ComponentType<Record<string, unknown>> | undefined;
  return node.source === "host" ? host ?? kit : kit ?? host;
}

/**
 * Whether this node renders one of OUR overlay bricks — decided by the SAME
 * resolution that picks the implementation, never by the component's name.
 *
 * Hosts name their own components, and a host `Modal` is an ordinary in-flow
 * component: classifying it by name alone handed it a shell that generates no
 * box, and it lost its layout box. (A GENERATED `Modal` needs no clause here —
 * `validateWalkTree` refuses a generated name that shadows a Kit one.)
 */
function rendersKitOverlay(node: TreeNode, components: NodeRendererProps["components"]): boolean {
  if (KIT_OVERLAY_SPECS[node.component] === undefined) return false;
  return resolveBuiltin(node, components) === KIT_COMPONENTS[node.component];
}

/**
 * How much box a node's shell may generate — decided, like the overlay clause
 * above, by the resolution that picks the implementation and never by the
 * component's name.
 *
 * "contents" is an overlay brick: it paints on the body-level host, so an empty
 * div left where it was written is still a flex item and takes a whole gap out
 * of the Stack around it. It keeps its element, because that element is how the
 * node is addressed (`data-vendo-node-id`).
 *
 * "none" is a table row, which may not have an element AT ALL: `<tr>` admits
 * only cells, so even a boxless div is invalid there and React says so in every
 * host developer's dev console. Nothing is lost by dropping it — no `src` reads
 * `data-vendo-node-id`, and `playNodeMotion` animates height/opacity/transform,
 * every one of which is inert on a shell that generates no box.
 */
function shellBox(node: TreeNode, components: NodeRendererProps["components"]): "box" | "contents" | "none" {
  if (resolveBuiltin(node, components) === KIT_COMPONENTS.TableRow) return "none";
  return rendersKitOverlay(node, components) ? "contents" : "box";
}

/** V4 — one component family: the Kit is the only built-in set, plus the display
 *  bricks, which resolve exactly like one. A brick's tag is lowercase and a Kit
 *  or catalog name is an identifier, so the two can never collide. */
function builtinContent({ props, node, children, invoke, handle }: NodeContent): ReactNode {
  const Implementation = resolveBuiltin(node, props.components);
  if (!Implementation) {
    // Mid-stream, an unresolved name is a transient (the defining island or
    // a corrected reference may still arrive) — hold the silhouette; the
    // notice is a verdict for FINAL payloads.
    return props.streaming ? (
      <span data-streaming-component={node.component} style={{ display: "block", width: "100%" }}>
        <FormingSkeleton name={node.component} />
      </span>
    ) : (
      <ContainedNotice label="Unknown component">
        {`Unknown component "${node.component}".`}
      </ContainedNotice>
    );
  }
  // Bare GEOMETRY — a name and a place, and nothing else: no props, nothing
  // under it, and no `source`, which is exactly what a forming shape carries
  // (apps `persistence/forming.ts`). The component resolves, so it would render
  // its empty self and an empty `Text` is an empty line; the silhouette is what
  // lets the tree GROW on screen as the build lands nodes.
  if (props.streaming && node.source === undefined && node.props === undefined && (node.children?.length ?? 0) === 0) {
    return (
      <span data-streaming-component={node.component} style={{ display: "block", width: "100%" }}>
        <FormingSkeleton name={node.component} />
      </span>
    );
  }
  const { bound, mismatch } = bindProps(node.props ?? {}, props.data, props.state, invoke, handle);
  // The notice replaces only the mis-bound component, never its subtree —
  // a container (Stack/Grid) with one bad prop must not swallow its valid
  // children (same containment scope as the generated paths above).
  const screen = props.screen;
  return mismatch !== null
    ? <>{dataShapeNotice(mismatch, props.streaming, node.component)}{children}</>
    : (
      <Implementation
        {...bound}
        {...(screen !== undefined && handlerBusy(node.props, screen.inFlight) ? { disabled: true } : {})}
      >
        {children}
      </Implementation>
    );
}

function NodeRenderer(props: NodeRendererProps) {
  const node = props.nodes.get(props.nodeId);
  if (!node) {
    return (
      <span data-dangling-node={props.nodeId} data-vendo-wet="1" style={{ display: "block", width: "100%" }}>
        <FormingSkeleton name={props.nodeId} />
      </span>
    );
  }
  if (props.ancestry.has(node.id)) {
    return <ContainedNotice label="Cyclic tree node">{`Node "${node.id}" forms a cycle.`}</ContainedNotice>;
  }
  // A run of text — the screen engine's own node kind, minted for every string
  // child a component wrote (`<Callout>Three invoices are overdue.</Callout>`).
  // It is not a component anybody registered, so it renders as the text itself,
  // with no wrapper: a div around a word would break the line it belongs to.
  if (node.component === SCREEN_TEXT_NODE) {
    return <>{String(node.props?.text ?? "")}</>;
  }
  // The plan's skeleton (packages/apps generation/skeleton.ts) prewires one
  // `pending` placeholder per plan leaf and a fill worker later replaces it
  // with the real component. Until then the node holds the same shape-derived
  // shimmer a streaming node holds — the app's real geometry arriving in
  // pieces, never a spinner over the whole surface. This runs BEFORE component
  // resolution on purpose: a placeholder for a name that resolves later (an
  // island the plan declared) shimmers instead of reading as unknown.
  if (node.props?.pending === true) {
    return (
      <div data-vendo-node-id={node.id} data-vendo-pending="" data-vendo-wet="1" aria-busy="true">
        <PendingLeaf name={node.component} />
      </div>
    );
  }

  const ancestry = new Set(props.ancestry);
  ancestry.add(node.id);
  const invoke = (action: string, payload?: Json) => props.runAction(node.id, action, payload);
  const screen = props.screen;
  const handle = screen === undefined
    ? undefined
    : (handlerId: string, event?: unknown) => screen.fire(node.id, handlerId, event);
  const children = node.children?.map((childId) => (
    <NodeErrorBoundary key={childId} nodeId={childId} retryKey={props.data} streaming={props.streaming}>
      <NodeRenderer {...props} nodeId={childId} ancestry={ancestry} />
    </NodeErrorBoundary>
  ));

  const context: NodeContent = { props, node, children, invoke, handle };
  const content = node.source === "generated" ? generatedContent(context) : builtinContent(context);

  const outcome = props.outcomes[node.id];
  const review = props.onReview;
  // Re-raising a park names the node that FIRED it, never the one carrying the
  // notice — an orphan's press is still that press.
  const notice = (firedId: string, settled: ToolOutcome | undefined): ReactNode =>
    outcomeNotice(settled, review === undefined ? undefined : (approvalId) => review(firedId, approvalId));
  return (
    <NodeShell
      nodeId={node.id}
      outcome={outcome}
      mark={props.marks.get(node.id)}
      shell={shellBox(node, props.components)}
      wet={props.streaming}
    >
      {content}
      {notice(node.id, outcome)}
      {props.orphans.get(node.id)?.map(([firedId, orphan]) => (
        <Fragment key={firedId}>{notice(firedId, orphan)}</Fragment>
      ))}
    </NodeShell>
  );
}

/**
 * Every node's box, and the one thing a repaint can animate. A mark arrives on
 * the render that carries the change and never on a first paint, so the effect
 * plays exactly one beat per node per repaint (repaint-motion.ts).
 */
function NodeShell({ nodeId, outcome, mark, shell, wet, children }: {
  nodeId: string;
  outcome: ToolOutcome | undefined;
  mark: NodeMark | undefined;
  /** How much box this shell may generate (`shellBox`). */
  shell: "box" | "contents" | "none";
  /** This node belongs to a payload that is still streaming, so nothing about it
   *  is final yet — not the component that resolved, not the props still to come.
   *  The shell is the one box that survives the swap from silhouette to real
   *  component, so dropping the attribute here is what lets the region transition
   *  to full ink instead of popping. Nested wet shells do not compound; the CSS
   *  resets all but the outermost. Only a "box" can carry it — "none" emits no
   *  element and "contents" generates none, and a shell with no box is one that
   *  opacity and filter are both inert on. */
  wet: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useMotionLayoutEffect(() => {
    if (mark !== undefined && box.current !== null) playNodeMotion(box.current, mark);
  }, [mark]);
  // A row's cells belong to their `<tr>` and nothing else may stand between
  // them — not even a boxless div, which is invalid table nesting and warns.
  if (shell === "none") return <>{children}</>;
  return (
    <div
      ref={box}
      data-vendo-node-id={nodeId}
      {...(shell === "contents" ? { style: { display: "contents" } } : {})}
      data-vendo-outcome={outcome?.status === "ok" ? undefined : outcome?.status}
      {...(wet && shell === "box" ? { "data-vendo-wet": "1" } : {})}
      {...(mark?.kind === "exit" ? { "aria-hidden": true, "data-vendo-departing": "" } : {})}
    >
      {children}
    </div>
  );
}

/**
 * 08-ui §5 — render a validated walk tree.
 *
 * `$state` is local to this TreeView. Generated code can write through its
 * `vendo.setState(key, value)` bridge; `onStateChange`, when supplied,
 * receives the complete state map after every change for app-state persistence.
 */
function StatefulTreeView({
  tree: painted,
  components,
  data,
  onAction,
  onParked,
  onStateChange,
  interactive,
  locale,
  timeZone,
}: TreeViewProps) {
  // The surface is its own theme boundary. A host mounts one wherever it likes
  // — demo-bank's Apps page is a bare AppFrame on a host page, outside any
  // ChromeRoot — and the brand tokens the Kit and the display bricks paint with
  // (`var(--vendo-color-accent)`) resolve to nothing unless an ANCESTOR set
  // them. Same mapping ChromeRoot applies, off the same provider theme, so a
  // surface nested in chrome restates identical values and cannot disagree.
  const theme = useVendoThemeOrDefault();
  useExprRuntime();
  // The surface is also the only place every Kit brick passes through, so the
  // Kit's pseudo-class sheet is injected here rather than from the overlay host
  // alone — a screen with a Button and no Modal has hover and focus states too.
  useEffect(ensureKitStyles, []);
  // The keyed `$state` store lives in the Kit bundle, shared with code-land's
  // `useVendoState` (kit/state.ts) — one implementation, two venues.
  const [viewState, updateState] = useKeyedState(onStateChange);
  const [outcomes, setOutcomes] = useState<Record<string, ToolOutcome | undefined>>({});

  const runAction = useCallback(async (nodeId: string, action: string, payload?: Json) => {
    let outcome: ToolOutcome;
    try {
      outcome = await onAction({ nodeId, action, ...(payload === undefined ? {} : { payload }) });
    } catch (error) {
      outcome = {
        status: "error",
        error: {
          code: "action",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    setOutcomes((current) => ({ ...current, [nodeId]: outcome.status === "ok" ? undefined : outcome }));
    if (outcome.status === "pending-approval") onParked?.({ nodeId, approvalId: outcome.approvalId });
    return outcome;
  }, [onAction, onParked]);

  // Pressing the pending notice raises the SAME park again, down the SAME
  // channel — so whichever surface answered the first announcement (the modal)
  // presents the ask again after an Esc. Nothing to raise it to, no affordance.
  const onReview = useMemo(
    () => onParked === undefined
      ? undefined
      : (nodeId: string, approvalId: ApprovalId) => onParked({ nodeId, approvalId }),
    [onParked],
  );

  // A screen's own failure (a VM that will not boot, a handler that threw) lands
  // in the same per-node slot a failed action does — one place a region reports
  // that something didn't work.
  const failNode = useCallback((nodeId: string, message: string) => {
    setOutcomes((current) => ({ ...current, [nodeId]: { status: "error", error: { code: "screen", message } } }));
  }, []);
  // What the screen may render: the Kit plus whatever this host registered.
  const catalog = useMemo(() => [...KIT_COMPONENT_NAMES, ...Object.keys(components)], [components]);
  const screen = useScreen({ interactive, base: painted, catalog, locale, timeZone, runAction, onFailure: failNode });
  // Every press still waiting on an approval, read straight off the outcome
  // slots that hold its notice — resolving one clears the slot, which is also
  // what stops the watch.
  const parked = useMemo(() => new Map(Object.entries(outcomes).flatMap(([nodeId, outcome]) =>
    outcome?.status === "pending-approval" ? [[nodeId, outcome.approvalId] as [string, string]] : [])), [outcomes]);
  // The approval's answer lands in the SAME per-node slot the press itself
  // fills, and EVERY terminal answer re-reads the screen — but the two kinds of
  // answer want different things from that re-read. An EXECUTED call moved the
  // data, and the screen keeps its own state: a supply re-renders what is already
  // standing, so a draft, a dialog and a selection all survive. A REFUSAL —
  // declined, or expired unanswered — moved nothing, and the only thing that
  // needs undoing is the screen's own `useState`: the "Sending…" flag a generated
  // handler sets before it awaits, which used to leave a declined press locked
  // forever. That one boots fresh. A tree with no query plan (a plain action tree)
  // has nothing to re-read; its notice still settles.
  useParkedApprovals(parked, (nodeId, resolution) => {
    const settled: ToolOutcome = resolution.state === "executed" ? resolution.outcome : {
      status: "blocked",
      reason: resolution.state === "expired"
        ? "This needed approval and nobody answered in time — nothing was sent."
        : "This wasn’t approved — nothing was sent.",
    };
    // The stale pending notice goes now; the refusal's own notice lands AFTER
    // the repaint, because the re-read's reads run through `runAction` and an
    // ok read clears this very slot.
    setOutcomes((current) => ({ ...current, [nodeId]: undefined }));
    void screen.refresh(nodeId, resolution.state !== "executed").then(() => {
      if (settled.status !== "ok") setOutcomes((current) => ({ ...current, [nodeId]: settled }));
    });
  });
  // The served paint until a handler moves the screen, and the screen's own tree
  // after — one walk, so validation, bindings, `$state` and outcomes are the ones
  // already here rather than a second renderer for interactive trees.
  const tree = screen.tree ?? painted;
  const streaming = (tree as WalkTree & { streaming?: unknown }).streaming === true;
  const furnishings = (tree as WalkTree & { furnishings?: Record<string, InClientFurnishing> }).furnishings ?? {};
  const inClient = (tree as WalkTree & { inClient?: InClientVenue }).inClient;
  // Tolerate a malformed field (like every other payload extra): only an
  // array of well-formed entries renders the notice.
  const seedDriftRaw = (tree as WalkTree & { seedDrift?: unknown }).seedDrift;
  const seedDrift = typeof seedDriftRaw === "object" && seedDriftRaw !== null
    && typeof (seedDriftRaw as SeedDrift).component === "string"
    ? seedDriftRaw as SeedDrift
    : null;
  // The host-page mount unlocks on EXACTLY `granted === true` — the value only
  // the server's hash-pin verification writes. Everything else stays unmounted.
  const inClientGranted = inClient?.granted === true;
  // A partial stream may close a generated node before its top-level source
  // string closes. Supply validator-only placeholders, then keep the real map
  // empty so NodeRenderer paints a skeleton until the source arrives.
  const validation = validateWalkTree(streaming ? {
    ...tree,
    components: Object.fromEntries([
      ...Object.entries(tree.components ?? {}),
      ...tree.nodes
        .filter((node) => node.source === "generated")
        .map((node) => [node.component, tree.components?.[node.component] ?? ""]),
    ]),
  } : tree);

  const nodes = useMemo(
    () => new Map(validation.ok ? validation.tree.nodes.map((node) => [node.id, node]) : []),
    [validation.ok ? validation.tree.nodes : validation.error.message],
  );

  // A repaint of a screen that is already on the page — a handler moved it, or a
  // successful tool made its data stale and the refresh brought new rows back —
  // is the one paint that animates. A served first paint, every streaming chunk
  // and every non-interactive payload swap instantly, as they always have.
  const repaint = useRepaintMotion(nodes, interactive !== undefined && !streaming);
  // Against the map that is actually WALKED, so a re-homed notice always lands
  // on a node this render mounts.
  const orphans = useMemo(() => orphanedOutcomes(outcomes, repaint.nodes), [outcomes, repaint.nodes]);

  // A review-kind version awaiting the host reviewer renders NOTHING but its
  // standing, checked BEFORE tree validation:
  // the server ships no executable fork source with `pending-review` (its
  // generated nodes have no components to validate against), so instead of an
  // invalid-tree verdict or skeletons of stripped components
  // the surface says "sent for review" — or carries the reviewer's rejection
  // note back to the user.
  if (inClient !== undefined && inClient.granted === false && inClient.reason === "pending-review") {
    const standing = inClient.review;
    if (standing?.status === "rejected") {
      return (
        <ContainedNotice label="Remix rejected" outcome="blocked">
          {`The host reviewer rejected this remix — "${standing.note}". Edit the remix to resubmit it for review.`}
        </ContainedNotice>
      );
    }
    return (
      <ContainedNotice label="Sent for review">
        This remix was sent to the host for review. The original component stays in place until a reviewer approves it.
      </ContainedNotice>
    );
  }

  if (!validation.ok) {
    return (
      <ContainedNotice label="Invalid UI tree" code={validation.error.code}>
        {`${validation.error.code}: ${validation.error.message}`}
      </ContainedNotice>
    );
  }

  if (!hasRenderableTreeContent(validation.tree, streaming)) {
    // A partial stream legitimately passes through content-less shapes on its
    // way to the full tree — hold a quiet skeleton; the notice is a verdict
    // reserved for FINAL payloads.
    if (streaming) {
      return <FormingSkeleton name="StreamingTree" />;
    }
    return (
      <ContainedNotice label="Empty UI tree">
        The app view has no renderable content.
      </ContainedNotice>
    );
  }

  // 06-apps §9 — a version change under an existing approval must be LOUD: the
  // surface says so, in-surface, above the tree. Every ungranted reason except
  // review-kind's pending-review (returned above) keeps this notice, so an
  // unknown future reason still says SOMETHING.
  const dropBackNotice = inClient !== undefined && inClient.granted === false
    // The payload is a wire value, so a FUTURE ungranted reason this union
    // does not know yet must still drop back loudly, not silently.
    && (inClient.reason as string) !== "pending-review"
    ? (
      <ContainedNotice label="In-client approval invalidated" outcome="blocked">
        This app changed since it was approved for the host page. Its generated components stay unrendered until the new version is re-approved.
      </ContainedNotice>
    )
    : null;

  // 06-apps §8 — the host moved on under a remix. This has to be LOUD and it has
  // to be HONEST: updating REPLAYS every change the person asked for onto the
  // new version, and names the ones that no longer fit rather than dropping
  // them. The copy promised a fresh copy that replaced their changes, which was
  // written in the window before that replay existed.
  const driftNotice = seedDrift !== null
    ? (
      <ContainedNotice label="Newer version available">
        {`"${seedDrift.component}" has changed in the app since you made this. Updating replays every change you asked for onto the new version, and tells you about any that no longer fit. Nothing happens until you ask for it.`}
      </ContainedNotice>
    )
    : null;

  // The drift notice's OTHER promise, kept. An update replays every wish and
  // says which ones the new version could not take; the server records exactly
  // those (`seed.unapplied`), and until this notice existed only the chat ever
  // heard them — so a change the person asked for disappeared out of an Update
  // that reported nothing at all. Phrased as the LAST update's verdict, which
  // stays true until the next one replays them.
  const unappliedRaw = (tree as WalkTree & { seedUnapplied?: unknown }).seedUnapplied;
  const unapplied = Array.isArray(unappliedRaw)
    ? unappliedRaw.filter((wish): wish is string => typeof wish === "string")
    : [];
  const unappliedNotice = unapplied.length > 0
    ? (
      <ContainedNotice label="Not carried over" outcome="blocked">
        {`The last update couldn’t carry every change you asked for onto the new version. These are still on record, so you can ask for them again: ${unapplied.map(wish => `“${wish}”`).join(", ")}.`}
      </ContainedNotice>
    )
    : null;

  // The view settled without the data it asked for (render-seam.ts writes this when
  // a query fails). Every unresolved binding renders "—" or an empty state, so a
  // silent settle reads as "you have no spending". SERVER-AUTHORITATIVE like
  // `inClient` and `seedDrift`: a document-carried value is stripped, and only
  // exactly `true` speaks.
  //
  // The marker fires when ANY query failed, so the copy has to hold when the rest
  // succeeded — a view with one live number in it cannot be told "the values below
  // are blank" while that number is on screen.
  const dataNotice = (tree as WalkTree & { dataUnavailable?: unknown }).dataUnavailable === true
    ? (
      <ContainedNotice label="Data didn't load" outcome="error">
        {"Some values below couldn't load — that isn't your data being empty. Try opening it again in a moment."}
      </ContainedNotice>
    )
    : null;

  return (
    // A Kit empty state deep in the walk reads `streaming` off this provider:
    // mid-build it holds a skeleton instead of claiming "No data".
    <FormingContext.Provider value={streaming}>
      <div data-vendo-surface="" style={{ ...themeCssVariables(theme), ...SURFACE_CONTAINMENT } as CSSProperties}>
        <NodeErrorBoundary nodeId={validation.tree.root} retryKey={data ?? validation.tree.data} streaming={streaming}>
          {dataNotice}
          {dropBackNotice}
          {driftNotice}
          {unappliedNotice}
          <NodeRenderer
            nodeId={validation.tree.root}
            ancestry={new Set()}
            nodes={repaint.nodes}
            marks={repaint.marks}
            generated={streaming ? tree.components ?? {} : validation.tree.components ?? {}}
            inClientGranted={inClientGranted}
            furnishings={furnishings}
            components={components}
            data={data ?? validation.tree.data ?? {}}
            state={viewState}
            streaming={streaming}
            outcomes={outcomes}
            orphans={orphans}
            runAction={runAction}
            {...(onReview === undefined ? {} : { onReview })}
            setViewState={updateState}
            {...(interactive === undefined ? {} : { screen })}
          />
        </NodeErrorBoundary>
      </div>
    </FormingContext.Provider>
  );
}

/**
 * A new app owns a fresh `$state` and outcome namespace.
 *
 * The identity is `appId`. It cannot be the tree: the compiler roots EVERY
 * compiled app at the same synthetic `root` node (core/genui/wire/compile.ts),
 * so keying on `tree.root` reused one instance across two different apps and
 * app B rendered app A's `$state`. Nor can it be the tree's contents — a
 * streaming tree changes on every chunk, and wiping `$state` mid-stream would
 * throw away what the user just typed.
 *
 * Without `appId` the key falls back to `tree.root`, which is exactly the
 * behavior every existing caller already had.
 */
export function TreeView(props: TreeViewProps) {
  return <StatefulTreeView key={props.appId ?? props.tree.root} {...props} />;
}
