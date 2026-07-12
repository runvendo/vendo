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
import { resolvePointer } from "./bindings.js";
import { NodeErrorBoundary } from "./error-boundary.js";
import { JailedComponent } from "./jail/JailedComponent.js";
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
  return (
    <ContainedNotice label="Action error" outcome={outcome.status} code={outcome.error.code}>
      {outcome.error.message}
    </ContainedNotice>
  );
}

interface NodeRendererProps {
  nodeId: string;
  ancestry: ReadonlySet<string>;
  nodes: ReadonlyMap<string, TreeNode>;
  generated: Record<string, string>;
  components: Record<string, ComponentType>;
  data: Record<string, Json>;
  state: Record<string, Json>;
  outcomes: Record<string, ToolOutcome | undefined>;
  runAction(nodeId: string, action: string, payload?: Json): Promise<ToolOutcome>;
  setViewState(key: string, value: Json): void;
}

function NodeRenderer(props: NodeRendererProps) {
  const node = props.nodes.get(props.nodeId);
  if (!node) {
    return (
      <span data-dangling-node={props.nodeId}>
        <Skeleton />
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
    if (source === undefined) {
      content = (
        <ContainedNotice label="Unknown generated component">
          {`Generated component "${node.component}" has no source.`}
        </ContainedNotice>
      );
    } else {
      const bound = bindValue(node.props ?? {}, "jail", props.data, props.state, invoke) as Record<string, unknown>;
      content = (
        <>
          <JailedComponent
            name={node.component}
            source={source}
            props={bound}
            onAction={invoke}
            onStateSet={props.setViewState}
          />
          {children}
        </>
      );
    }
  } else {
    const primitive = PREWIRED_COMPONENTS[node.component];
    const host = props.components[node.component] as ComponentType<Record<string, unknown>> | undefined;
    const Implementation = primitive ?? host;
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
export function TreeView({
  tree,
  components,
  data,
  onAction,
  onStateChange,
}: TreeViewProps) {
  const validation = validateTree(tree);
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

  return (
    <NodeErrorBoundary nodeId={validation.tree.root}>
      <NodeRenderer
        nodeId={validation.tree.root}
        ancestry={new Set()}
        nodes={nodes}
        generated={validation.tree.components ?? {}}
        components={components}
        data={data ?? validation.tree.data ?? {}}
        state={viewState}
        outcomes={outcomes}
        runAction={runAction}
        setViewState={updateState}
      />
    </NodeErrorBoundary>
  );
}
