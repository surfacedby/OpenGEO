import React from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

/**
 * Contains a rendering failure to the view that produced it. Changing `resetKey` (the page or
 * website) clears the failure, so navigation keeps working without reloading saved work.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string; title?: string; fullScreen?: boolean },
  { failed: boolean; key?: string }
> {
  state: { failed: boolean; key?: string } = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey?: string }, state: { failed: boolean; key?: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className={"view-error" + (this.props.fullScreen ? " full-screen" : "")} role="alert">
        <TriangleAlert size={22} aria-hidden="true" />
        <h2>{this.props.title ?? "This view could not be displayed"}</h2>
        <p>Your saved projects, evidence and drafts remain on this device.</p>
        <button className="secondary" onClick={() => location.reload()}><RefreshCw size={15} />Reload</button>
      </section>
    );
  }
}
