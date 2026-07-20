import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  applyReshape,
  isPathBinding,
  isStateBinding,
  VENDO_TREE_FORMAT_V2,
  type Json,
  type PathBinding,
  type ToolOutcome,
  type TreeNode,
  type UIPayload,
} from "@vendoai/core";
import { convertV2Payload } from "./renderer-v2.js";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useVendoThemeOrDefault } from "../context.js";
import { themeCssVariables } from "../theme.js";
import type { InClientVenue, PinDrift } from "../wire-types.js";
import { resolvePointer } from "./bindings.js";
import { NodeErrorBoundary } from "./error-boundary.js";
import { FluidReveal } from "./fluid-reveal.js";
import { deriveFormShape, FormingSkeleton } from "./forming-skeleton.js";
import { InClientMount } from "./host-mount.js";
import { JailedComponent, type JailFurnishing } from "./jail/JailedComponent.js";
import { ContainedNotice } from "./notice.js";
import { KIT_COMPONENTS } from "../kit/registry.js";
import { PREWIRED_COMPONENTS } from "./primitives.js";

export interface TreeViewProps {
  tree: WalkTree;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  /**
   * 08-ui §5; 06-apps §6 — additive persistence hook for TreeView-local `$state`.
   * It fires with the complete state map after every jail `state-set` message.
   */
  onStateChange?(state: Record<string, Json>): void;
}

export interface PayloadRendererProps {
  payload: UIPayload;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  onStateChange?(state: Record<string, Json>): void;
}

type PayloadRenderer = ComponentType<PayloadRendererProps>;
const rendererRegistry = new Map<string, PayloadRenderer>();

/** 01-core §8; 08-ui §5 — additive format registration for stored future payloads. */
export function registerTreeRenderer(formatVersion: string, component: PayloadRenderer): void {
  rendererRegistry.set(formatVersion, component);
}

/**
 * v2 spec §6 — the walk's input: the SHARED render mechanics' tree shape
 * (nodes, path-keyed resolved queries, grafted components, payload extras).
 * The v1 format surface around it is gone; renderer-v2 converts the
 * canonical v2 tree into this shape (named queries → "/" + name pointers).
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

/** The structural render-gate the v1 validator used to provide (per-render
 *  hot path): ids unique and rooted, node shapes sane, generated components
 *  present. Format-tag checks live one layer up (PayloadView dispatch +
 *  validateTreeV2 in renderer-v2). */
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
  // The jail-compile bounds the v1 walk enforced per render survive here:
  // reserved names can never be shadowed and the §8 component caps hold even
  // for payloads that bypassed document validation (direct TreeView input).
  const names = Object.keys(components);
  if (names.length > TREE_MAX_GENERATED_COMPONENTS) {
    return walkFail(`too many generated components (max ${TREE_MAX_GENERATED_COMPONENTS})`);
  }
  let totalChars = 0;
  for (const name of names) {
    if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
      return walkFail(`generated component "${name}" shadows a reserved primitive name`);
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

/** v2 spec §1 — a validated v2 payload converts to the v1 tree shape and
 *  walks the SAME TreeView (renderer-v2.tsx documents the mapping). The
 *  registration lives here, in PayloadView's own module: the package is
 *  `sideEffects: false`, so a registration-only import would be tree-shaken
 *  out of host bundles. */
function VendoTreeV2Renderer({ payload, ...props }: PayloadRendererProps) {
  const converted = useMemo(() => convertV2Payload(payload), [payload]);
  if (!converted.ok) {
    return (
      <ContainedNotice label="Invalid UI tree" code={converted.error.code}>
        {`${converted.error.code}: ${converted.error.message}`}
      </ContainedNotice>
    );
  }
  return <TreeView tree={converted.tree} {...props} />;
}

registerTreeRenderer(VENDO_TREE_FORMAT_V2, VendoTreeV2Renderer);

/** 01-core §8 — renderer dispatch is exclusively by the payload tag. */
export function PayloadView(props: PayloadRendererProps) {
  const Renderer = rendererRegistry.get(props.payload.formatVersion);
  if (!Renderer) {
    return (
      <ContainedNotice label="Unsupported UI format">
        {`No renderer is registered for "${props.payload.formatVersion}".`}
      </ContainedNotice>
    );
  }
  return <Renderer {...props} />;
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

type BoundMode = "host" | "jail";

/** v2 spec §3 — apply a binding's `$reshape` chain to the resolved value.
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
  mode: BoundMode,
  data: Record<string, Json>,
  state: Record<string, Json>,
  action: (name: string, payload?: Json) => Promise<ToolOutcome>,
  onMismatch?: (reason: string) => void,
): unknown {
  if (isPathBinding(value)) return resolveReshaped(resolvePointer(data, value.$path), value.$reshape, onMismatch);
  if (isStateBinding(value)) return resolveReshaped(state[value.$state] as Json | undefined, value.$reshape, onMismatch);
  if (isActionBinding(value)) {
    const payload = bindValue(value.payload, mode, data, state, action, onMismatch) as Json;
    if (mode === "jail") {
      return { $action: value.$action, ...(value.payload === undefined ? {} : { payload }) };
    }
    return () => action(value.$action, value.payload === undefined ? undefined : payload);
  }
  if (Array.isArray(value)) return value.map((item) => bindValue(item, mode, data, state, action, onMismatch));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      bindValue(child, mode, data, state, action, onMismatch),
    ]));
  }
  return value;
}

/** Binds a node's props, reporting the first reshape mismatch with its prop
 *  name (v2 spec §3 — the region shows one contained notice, not a broken
 *  component). */
function bindProps(
  props: Record<string, Json> | undefined,
  mode: BoundMode,
  data: Record<string, Json>,
  state: Record<string, Json>,
  action: (name: string, payload?: Json) => Promise<ToolOutcome>,
): { bound: Record<string, unknown> | undefined; mismatch: string | null } {
  if (props === undefined) return { bound: undefined, mismatch: null };
  let mismatch: string | null = null;
  let currentProp = "";
  const onMismatch = (reason: string): void => {
    if (mismatch === null) mismatch = `prop "${currentProp}": ${reason}`;
  };
  const bound = Object.fromEntries(Object.entries(props).map(([key, child]) => {
    currentProp = key;
    return [key, bindValue(child, mode, data, state, action, onMismatch)];
  }));
  return { bound, mismatch };
}

/** v2 spec §3 — the contained data-shape notice: the region says the data
 *  didn't match instead of mounting the component with garbage props. */
const dataShapeNotice = (mismatch: string): ReactNode => (
  <ContainedNotice label="Data shape">
    {`The data didn't match this component's binding — ${mismatch}.`}
  </ContainedNotice>
);

function outcomeNotice(outcome: ToolOutcome | undefined): ReactNode {
  if (!outcome || outcome.status === "ok") return null;
  if (outcome.status === "pending-approval") {
    return (
      <ContainedNotice label="Action pending approval" outcome={outcome.status}>
        {`Action is waiting for approval (${outcome.approvalId}).`}
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
 * 06-apps §9 — the additive in-client venue verdict a tree payload may carry.
 * SERVER-AUTHORITATIVE: the apps runtime strips any document-carried value and
 * attaches this only from its own hash-pin verification, so `granted: true`
 * here is exactly "a stored approval matches the CURRENT version's content
 * hash". A missing field is the universal default: jailed. One declaration —
 * the wire type — re-exported here so tree consumers see the same shape the
 * client and the parity test cover.
 */
export type { InClientVenue } from "../wire-types.js";

/**
 * 06-apps §8 — the additive pin-drift report a tree payload may carry
 * (`payload.pinDrift`). SERVER-AUTHORITATIVE: the apps runtime strips any
 * document-carried value and attaches this only from its own baseline
 * comparison. Re-exported from the wire type so tree consumers see the same
 * shape the client and the parity test cover.
 */
export type { PinDrift } from "../wire-types.js";

interface NodeRendererProps {
  nodeId: string;
  ancestry: ReadonlySet<string>;
  nodes: ReadonlyMap<string, TreeNode>;
  generated: Record<string, string>;
  /** W4b — the payload's compiler-stamped per-island tool manifests. Absent
   *  (legacy/streaming) means JailedComponent derives from source host-side. */
  componentTools?: Record<string, string[]>;
  /** True ONLY when the payload's server-written verdict granted the venue. */
  inClientGranted: boolean;
  furnishings: Record<string, JailFurnishing>;
  themeVars: Record<string, string>;
  components: Record<string, ComponentType>;
  data: Record<string, Json>;
  state: Record<string, Json>;
  streaming: boolean;
  outcomes: Record<string, ToolOutcome | undefined>;
  runAction(nodeId: string, action: string, payload?: Json): Promise<ToolOutcome>;
  setViewState(key: string, value: Json): void;
}

const EMPTY_LAYOUT_COMPONENTS = new Set(["Stack", "Row", "Grid"]);

const hasRenderableTreeContent = (tree: WalkTree): boolean => {
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

function NodeRenderer(props: NodeRendererProps) {
  const node = props.nodes.get(props.nodeId);
  if (!node) {
    return (
      <span data-dangling-node={props.nodeId} style={{ display: "block", width: "100%" }}>
        <FormingSkeleton name={props.nodeId} />
      </span>
    );
  }
  if (props.ancestry.has(node.id)) {
    return <ContainedNotice label="Cyclic tree node">{`Node "${node.id}" forms a cycle.`}</ContainedNotice>;
  }

  const ancestry = new Set(props.ancestry);
  ancestry.add(node.id);
  const invoke = (action: string, payload?: Json) => props.runAction(node.id, action, payload);
  const children = node.children?.map((childId) => (
    <NodeErrorBoundary key={childId} nodeId={childId} retryKey={props.data}>
      <NodeRenderer {...props} nodeId={childId} ancestry={ancestry} />
    </NodeErrorBoundary>
  ));

  let content: ReactNode;
  if (node.source === "generated") {
    const source = props.generated[node.component];
    const revealKey = source === undefined ? "forming" : "ready";
    // Stamped era: a missing entry means "this island calls no tools" (least
    // privilege). No stamping at all: undefined, so JailedComponent derives
    // the manifest from the source the host holds.
    const toolManifest = props.componentTools === undefined
      ? undefined
      : props.componentTools[node.component] ?? [];
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
      // 06-apps §9 — the approved venue: this exact version's content hash
      // matched a stored approval, so generated code mounts in the host page.
      // The jail element stays wired as the drop-back for any mount failure.
      const hostBind = bindProps(node.props, "host", props.data, props.state, invoke);
      const jailBind = bindProps(node.props, "jail", props.data, props.state, invoke);
      // Reshape mismatches are mode-independent, so both binds report the same one.
      const mismatch = hostBind.mismatch;
      if (mismatch !== null) {
        content = <>{dataShapeNotice(mismatch)}{children}</>;
      } else {
        const jailFallback = (
          <JailedComponent
            name={node.component}
            source={source}
            props={jailBind.bound}
            furnishing={props.furnishings[node.component]}
            themeVars={props.themeVars}
            toolManifest={toolManifest}
            onAction={invoke}
            onStateSet={props.setViewState}
          />
        );
        content = (
          <>
            <InClientMount
              name={node.component}
              source={source}
              props={hostBind.bound}
              furnishing={props.furnishings[node.component]}
              fallback={jailFallback}
              onAction={invoke}
              onStateSet={props.setViewState}
            />
            {children}
          </>
        );
      }
    } else {
      const { bound, mismatch } = bindProps(node.props, "jail", props.data, props.state, invoke);
      content = mismatch !== null ? <>{dataShapeNotice(mismatch)}{children}</> : (
        <>
          <JailedComponent
            name={node.component}
            source={source}
            props={bound}
            furnishing={props.furnishings[node.component]}
            themeVars={props.themeVars}
            toolManifest={toolManifest}
            onAction={invoke}
            onStateSet={props.setViewState}
          />
          {children}
        </>
      );
    }
    // ENG-205 render-slot morph: the streaming placeholder and the arrived
    // component share this wrapper, so the swap morphs instead of popping.
    // Pick A: a shape-derived silhouette already holds (approximately) the
    // final geometry, so its reveal crossfades in place (.fl-reveal-fill)
    // instead of running the rise/settle morph; slab fallbacks keep the morph.
    content = (
      <FluidReveal
        stateKey={revealKey}
        className={deriveFormShape(node.component) === "slab" ? undefined : "fl-reveal-fill"}
      >
        {content}
      </FluidReveal>
    );
  } else {
    // W3 Kit adoption — legacy prewired names keep their implementations
    // (retirement is Wave 5); the Kit fills the names the legacy set lacks
    // (Money, DateTime, DataTable, charts, Form, Disclaimer, …).
    const primitive = PREWIRED_COMPONENTS[node.component]
      ?? (KIT_COMPONENTS[node.component] as ComponentType<Record<string, unknown>> | undefined);
    const host = props.components[node.component] as ComponentType<Record<string, unknown>> | undefined;
    // v2 spec §2 — an explicit `source: "host"` resolution means the host
    // brand won the name; only an undefined source keeps the historical
    // primitive-first order.
    const Implementation = node.source === "host" ? host ?? primitive : primitive ?? host;
    if (!Implementation) {
      content = (
        <ContainedNotice label="Unknown component">
          {`Unknown component "${node.component}".`}
        </ContainedNotice>
      );
    } else {
      const { bound, mismatch } = bindProps(node.props ?? {}, "host", props.data, props.state, invoke);
      // The notice replaces only the mis-bound component, never its subtree —
      // a container (Stack/Grid) with one bad prop must not swallow its valid
      // children (same containment scope as the generated paths above).
      content = mismatch !== null
        ? <>{dataShapeNotice(mismatch)}{children}</>
        : <Implementation {...bound}>{children}</Implementation>;
    }
  }

  const outcome = props.outcomes[node.id];
  return (
    <div data-vendo-node-id={node.id} data-vendo-outcome={outcome?.status === "ok" ? undefined : outcome?.status}>
      {content}
      {outcomeNotice(outcome)}
    </div>
  );
}

/**
 * 08-ui §5 — render a validated walk tree (the shared render mechanics, v2 spec §6).
 *
 * `$state` is local to this TreeView. Generated code can write through its
 * in-jail `vendo.setState(key, value)` bridge; `onStateChange`, when supplied,
 * receives the complete state map after every change for app-state persistence.
 */
function StatefulTreeView({
  tree,
  components,
  data,
  onAction,
  onStateChange,
}: TreeViewProps) {
  const theme = useVendoThemeOrDefault();
  const themeVars = useMemo(() => themeCssVariables(theme), [theme]);
  const streaming = (tree as WalkTree & { streaming?: unknown }).streaming === true;
  const furnishings = (tree as WalkTree & { furnishings?: Record<string, JailFurnishing> }).furnishings ?? {};
  // W4b — the stamped per-island tool manifests ride the payload beside the
  // component sources (a payload extra, like furnishings).
  const componentTools = (tree as WalkTree & { componentTools?: Record<string, string[]> }).componentTools;
  const inClient = (tree as WalkTree & { inClient?: InClientVenue }).inClient;
  // Tolerate a malformed field (like every other payload extra): only an
  // array of well-formed entries renders the notice.
  const pinDriftRaw = (tree as WalkTree & { pinDrift?: unknown }).pinDrift;
  const pinDrift = (Array.isArray(pinDriftRaw) ? pinDriftRaw : [])
    .filter((entry): entry is PinDrift =>
      typeof entry === "object" && entry !== null && typeof (entry as PinDrift).slot === "string");
  // The host-page mount unlocks on EXACTLY `granted === true` — the value only
  // the server's hash-pin verification writes. Everything else stays jailed.
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
  const [viewState, setViewState] = useState<Record<string, Json>>({});
  const stateRef = useRef(viewState);
  const [outcomes, setOutcomes] = useState<Record<string, ToolOutcome | undefined>>({});

  const updateState = useCallback((key: string, value: Json) => {
    const next = { ...stateRef.current, [key]: value };
    stateRef.current = next;
    setViewState(next);
    onStateChange?.(next);
  }, [onStateChange]);

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
    return outcome;
  }, [onAction]);

  const nodes = useMemo(
    () => new Map(validation.ok ? validation.tree.nodes.map((node) => [node.id, node]) : []),
    [validation.ok ? validation.tree.nodes : validation.error.message],
  );

  if (!validation.ok) {
    return (
      <ContainedNotice label="Invalid UI tree" code={validation.error.code}>
        {`${validation.error.code}: ${validation.error.message}`}
      </ContainedNotice>
    );
  }

  if (!hasRenderableTreeContent(validation.tree)) {
    return (
      <ContainedNotice label="Empty UI tree">
        The app view has no renderable content.
      </ContainedNotice>
    );
  }

  // 06-apps §9 — a version change under an existing approval must be LOUD: the
  // surface drops back to the sandbox and says so, in-surface, above the tree.
  const dropBackNotice = inClient !== undefined && inClient.granted === false
    ? (
      <ContainedNotice label="In-client approval invalidated" outcome="blocked">
        This app changed since it was approved for the host page. It is running in the sandbox again until the new version is re-approved.
      </ContainedNotice>
    )
    : null;

  // 06-apps §8 — a host update under a remixed pin must be LOUD too: the fork
  // keeps rendering (nothing is mutated without the user), but the surface
  // says the host component moved on and a rebase is available.
  const driftNotice = pinDrift.length > 0
    ? (
      <ContainedNotice label="Remixed component out of date">
        {`The host updated ${pinDrift.map((pin) => `"${pin.slot}"`).join(", ")} since ${pinDrift.length === 1 ? "it was" : "they were"} remixed here. Ask the agent to rebase the remix onto the updated component.`}
      </ContainedNotice>
    )
    : null;

  return (
    <NodeErrorBoundary nodeId={validation.tree.root} retryKey={data ?? validation.tree.data}>
      {dropBackNotice}
      {driftNotice}
      <NodeRenderer
        nodeId={validation.tree.root}
        ancestry={new Set()}
        nodes={nodes}
        generated={streaming ? tree.components ?? {} : validation.tree.components ?? {}}
        {...(componentTools === undefined ? {} : { componentTools })}
        inClientGranted={inClientGranted}
        furnishings={furnishings}
        themeVars={themeVars}
        components={components}
        data={data ?? validation.tree.data ?? {}}
        state={viewState}
        streaming={streaming}
        outcomes={outcomes}
        runAction={runAction}
        setViewState={updateState}
      />
    </NodeErrorBoundary>
  );
}

/** A new tree identity owns a fresh `$state` and outcome namespace. */
export function TreeView(props: TreeViewProps) {
  return <StatefulTreeView key={props.tree.root} {...props} />;
}
