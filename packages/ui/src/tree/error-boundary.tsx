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
    if (
      (previous.nodeId !== this.props.nodeId
        || previous.retryKey !== this.props.retryKey
        // A latched mid-stream error retries on EVERY new prefix (partials
        // arrive throttled, so the retry loop is bounded), and the flip to
        // the final payload re-evaluates fresh instead of inheriting a
        // transient crash from the stream.
        || previous.streaming === true)
      && this.state.error
    ) this.setState({ error: undefined });
  }

  render() {
    if (this.state.error) {
      if (this.props.streaming === true) {
        return <FormingSkeleton name={this.props.nodeId} />;
      }
      return (
        <ContainedNotice label="Node render error">
          {`Node "${this.props.nodeId}" could not render: ${this.state.error.message}`}
        </ContainedNotice>
      );
    }
    return this.props.children;
  }
}
