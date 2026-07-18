import {
  isPathBinding,
  isStateBinding,
  validateTree,
  VENDO_TREE_FORMAT,
  type Json,
  type ToolOutcome,
  type Tree,
  type TreeNode,
  type UIPayload,
} from "@vendoai/core";
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
import { InClientMount } from "./host-mount.js";
import { JailedComponent, type JailFurnishing } from "./jail/JailedComponent.js";
import { ContainedNotice } from "./notice.js";
import { PREWIRED_COMPONENTS, Skeleton } from "./primitives.js";

export interface TreeViewProps {
  tree: Tree;
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

function VendoTreeRenderer({ payload, ...props }: PayloadRendererProps) {
  return <TreeView tree={payload as unknown as Tree} {...props} />;
}

registerTreeRenderer(VENDO_TREE_FORMAT, VendoTreeRenderer);

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

function bindValue(
  value: unknown,
  mode: BoundMode,
  data: Record<string, Json>,
  state: Record<string, Json>,
  action: (name: string, payload?: Json) => Promise<ToolOutcome>,
): unknown {
  if (isPathBinding(value)) return resolvePointer(data, value.$path);
  if (isStateBinding(value)) return state[value.$state];
  if (isActionBinding(value)) {
    const payload = bindValue(value.payload, mode, data, state, action) as Json;
    if (mode === "jail") {
      return { $action: value.$action, ...(value.payload === undefined ? {} : { payload }) };
    }
    return () => action(value.$action, value.payload === undefined ? undefined : payload);
  }
  if (Array.isArray(value)) return value.map((item) => bindValue(item, mode, data, state, action));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      bindValue(child, mode, data, state, action),
    ]));
  }
  return value;
}

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

const hasRenderableTreeContent = (tree: Tree): boolean => {
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
        <Skeleton height="72px" />
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
    <NodeErrorBoundary key={childId} nodeId={childId}>
      <NodeRenderer {...props} nodeId={childId} ancestry={ancestry} />
    </NodeErrorBoundary>
  ));

  let content: ReactNode;
  if (node.source === "generated") {
    const source = props.generated[node.component];
    const revealKey = source === undefined ? "forming" : "ready";
    if (source === undefined) {
      content = props.streaming ? (
        <span data-streaming-component={node.component} style={{ display: "block", width: "100%" }}>
          <Skeleton height="72px" />
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
      const bound = node.props === undefined
        ? undefined
        : bindValue(node.props, "host", props.data, props.state, invoke) as Record<string, unknown>;
      const jailFallback = (
        <JailedComponent
          name={node.component}
          source={source}
          props={node.props === undefined
            ? undefined
            : bindValue(node.props, "jail", props.data, props.state, invoke) as Record<string, unknown>}
          furnishing={props.furnishings[node.component]}
          themeVars={props.themeVars}
          onAction={invoke}
          onStateSet={props.setViewState}
        />
      );
      content = (
        <>
          <InClientMount
            name={node.component}
            source={source}
            props={bound}
            furnishing={props.furnishings[node.component]}
            fallback={jailFallback}
            onAction={invoke}
            onStateSet={props.setViewState}
          />
          {children}
        </>
      );
    } else {
      const bound = node.props === undefined
        ? undefined
        : bindValue(node.props, "jail", props.data, props.state, invoke) as Record<string, unknown>;
      content = (
        <>
          <JailedComponent
            name={node.component}
            source={source}
            props={bound}
            furnishing={props.furnishings[node.component]}
            themeVars={props.themeVars}
            onAction={invoke}
            onStateSet={props.setViewState}
          />
          {children}
        </>
      );
    }
    // ENG-205 render-slot morph: the streaming placeholder and the arrived
    // component share this wrapper, so the swap morphs instead of popping.
    content = <FluidReveal stateKey={revealKey}>{content}</FluidReveal>;
  } else {
    const primitive = PREWIRED_COMPONENTS[node.component];
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
      const bound = bindValue(node.props ?? {}, "host", props.data, props.state, invoke) as Record<string, unknown>;
      content = <Implementation {...bound}>{children}</Implementation>;
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
 * 08-ui §5 — render a validated `vendo-genui/v1` tree.
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
  const streaming = (tree as Tree & { streaming?: unknown }).streaming === true;
  const furnishings = (tree as Tree & { furnishings?: Record<string, JailFurnishing> }).furnishings ?? {};
  const inClient = (tree as Tree & { inClient?: InClientVenue }).inClient;
  // Tolerate a malformed field (like every other payload extra): only an
  // array of well-formed entries renders the notice.
  const pinDriftRaw = (tree as Tree & { pinDrift?: unknown }).pinDrift;
  const pinDrift = (Array.isArray(pinDriftRaw) ? pinDriftRaw : [])
    .filter((entry): entry is PinDrift =>
      typeof entry === "object" && entry !== null && typeof (entry as PinDrift).slot === "string");
  // The host-page mount unlocks on EXACTLY `granted === true` — the value only
  // the server's hash-pin verification writes. Everything else stays jailed.
  const inClientGranted = inClient?.granted === true;
  // A partial stream may close a generated node before its top-level source
  // string closes. Supply validator-only placeholders, then keep the real map
  // empty so NodeRenderer paints a skeleton until the source arrives.
  const validation = validateTree(streaming ? {
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
    <NodeErrorBoundary nodeId={validation.tree.root}>
      {dropBackNotice}
      {driftNotice}
      <NodeRenderer
        nodeId={validation.tree.root}
        ancestry={new Set()}
        nodes={nodes}
        generated={streaming ? tree.components ?? {} : validation.tree.components ?? {}}
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
