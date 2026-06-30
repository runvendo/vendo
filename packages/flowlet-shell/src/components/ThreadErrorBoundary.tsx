import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bumped by the parent (e.g. on a new turn) to clear a prior crash and retry. */
  resetKey?: unknown;
}
interface State {
  hasError: boolean;
}

/**
 * Last-resort boundary around the chat transcript. Generated UI already renders
 * inside an egress-jailed iframe and each prewired impl has its own boundary, so
 * a crash here is unexpected — but if a host node (a Connect/App wrapper, a
 * malformed view) ever throws during render, this keeps the failure local: it
 * shows a small inline notice INSTEAD of unmounting the whole panel to a white
 * screen. The composer lives outside this boundary, so the user can always keep
 * typing and recover. `resetKey` (the live turn count) clears the error on the
 * next turn so one bad render doesn't wedge the thread forever.
 */
export class ThreadErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging without crashing; never rethrow.
    console.error("[flowlet] thread render error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fl-error" role="alert">
          This view couldn&apos;t be displayed. Keep chatting below — your conversation is fine.
        </div>
      );
    }
    return this.props.children;
  }
}
