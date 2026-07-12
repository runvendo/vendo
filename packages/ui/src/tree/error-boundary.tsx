import { Component, type ErrorInfo, type ReactNode } from "react";
import { ContainedNotice } from "./notice.js";

interface BoundaryProps {
  children: ReactNode;
  nodeId: string;
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
    if (previous.nodeId !== this.props.nodeId && this.state.error) this.setState({ error: undefined });
  }

  render() {
    if (this.state.error) {
      return (
        <ContainedNotice label="Node render error">
          {`Node "${this.props.nodeId}" could not render: ${this.state.error.message}`}
        </ContainedNotice>
      );
    }
    return this.props.children;
  }
}
