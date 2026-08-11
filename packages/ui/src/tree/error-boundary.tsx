import { Component, type ErrorInfo, type ReactNode } from "react";
import { FormingSkeleton } from "./forming-skeleton.js";
import { ContainedNotice } from "./notice.js";

interface BoundaryProps {
  children: ReactNode;
  nodeId: string;
  /** When this identity changes (streamed data arriving, an upgraded
   *  payload), a latched error clears and the node re-renders — a crash on
   *  absent mid-stream data must not survive the data. */
  retryKey?: unknown;
  /** True while the payload is a mid-stream partial: a crash is a transient
   *  (the node's props/data may still be rewritten before ship), so the loud
   *  notice yields to the forming skeleton and the latch retries on every
   *  new prefix. The notice is a verdict for FINAL payloads only. */
  streaming?: boolean;
}

interface BoundaryState {
  error?: Error;
}

/** 08-ui §5 — one node may fail without taking its siblings with it. */
export class NodeErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {};

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // React reports the captured error; containment is the behavior required here.
  }

  componentDidUpdate(previous: BoundaryProps): void {
    // Every arm must be an INPUT change. Clearing on `streaming === true`
    // alone is true of the boundary's own error re-render too, so the latch
    // clears itself, the child throws again, and the loop only ends when
    // React's nested-update guard crashes the surface the boundary exists to
    // contain. A new prefix arrives as a new `retryKey`; the flip to the
    // final payload arrives as a `streaming` change.
    if (
      (previous.nodeId !== this.props.nodeId
        || previous.retryKey !== this.props.retryKey
        || previous.streaming !== this.props.streaming)
      && this.state.error
    ) this.setState({ error: undefined });
  }

  render() {
    if (this.state.error) {
      if (this.props.streaming === true) {
        return <FormingSkeleton name={this.props.nodeId} />;
      }
      return (
        // M36 — the exception's own message is generated-component code talking
        // ("Cannot read properties of undefined (reading 'map')"), and the node
        // id is our plumbing. Both are the developer's half; a person reads the
        // one honest sentence.
        <ContainedNotice
          label="Node render error"
          detail={`Node "${this.props.nodeId}": ${this.state.error.message}`}
        >
          Part of this view didn’t load.
        </ContainedNotice>
      );
    }
    return this.props.children;
  }
}
