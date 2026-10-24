import { AlertTriangle, Inbox, RefreshCw, WifiOff } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAllocation } from "@/api/hooks";
import { useUi } from "@/store/ui";

import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";

/** Plain-English line for whatever a failed request threw. */
export function whyFailed(e: unknown): string {
  if (e instanceof ApiError) return e.status === 404 ? "The server does not have this project." : e.message;
  if (e instanceof TypeError) return "The server did not answer.";
  return e instanceof Error && e.message ? e.message : "Something unexpected happened.";
}

/** A data page whose request failed: say so, say why, and offer the retry. Never a blank page. */
export function PageError({ title, error, onRetry }: { title: string; error?: unknown; onRetry?: () => void }) {
  const offline = error instanceof TypeError;
  return (
    <div className="grid h-full place-items-center p-6" role="alert" data-testid="page-error">
      <div className="card-surface max-w-[460px] p-6 text-center">
        {offline ? <WifiOff className="mx-auto size-8 text-warn" /> : <AlertTriangle className="mx-auto size-8 text-warn" />}
        <h2 className="mt-3 text-[16px] font-semibold">{title}</h2>
        <p className="mt-1 text-muted-foreground">{whyFailed(error)}</p>
        <div className="mt-4 flex justify-center gap-2">
          {onRetry && <Button size="sm" className="gap-1.5" onClick={onRetry}><RefreshCw className="size-3.5" />Try again</Button>}
          <Button asChild size="sm" variant="outline"><Link to="/">Go Home</Link></Button>
        </div>
      </div>
    </div>
  );
}

/** A project with nothing in it yet: what is missing and the one button that fixes it. */
export function EmptyState({ title, body, to, action }: { title: string; body: string; to?: string; action?: string }) {
  return (
    <div className="grid h-full place-items-center p-6" data-testid="page-empty">
      <div className="card-surface max-w-[460px] p-6 text-center">
        <Inbox className="mx-auto size-8 text-brand" />
        <h2 className="mt-3 text-[16px] font-semibold">{title}</h2>
        <p className="mt-1 text-muted-foreground">{body}</p>
        {to && action && <Button asChild size="sm" className="mt-4"><Link to={to}>{action}</Link></Button>}
      </div>
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

/** Last line of defence: a render error shows this screen instead of a white page. `inline` keeps the shell around it. */
export class ErrorBoundary extends Component<{ children: ReactNode; inline?: boolean; resetKey?: string }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[optislot] render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.inline ? "grid h-full place-items-center p-6" : "bg-world grid h-full place-items-center p-6"} role="alert" data-testid="error-boundary">
        <div className="card-surface max-w-[480px] p-6 text-center">
          <AlertTriangle className="mx-auto size-9 text-warn" />
          <h1 className="mt-3 text-[18px] font-semibold">Something went wrong</h1>
          <p className="mt-1 text-muted-foreground">
            This screen hit an unexpected problem. Your project and every allocation are safe — nothing was changed. Reload to try again, or go back Home.
          </p>
          <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={this.state.error.message}>{this.state.error.message}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => window.location.reload()}><RefreshCw className="size-3.5" />Reload</Button>
            <Button size="sm" variant="outline" onClick={() => window.location.assign("/")}>Go Home</Button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Pages that draw the allocation: when the server answers with an error for it (unknown project, broken run), show what
 * happened and the way out instead of an endless skeleton. Loading stays with each page's own skeleton.
 */
export function AllocationGate({ children }: { children: ReactNode }) {
  const q = useAllocation();
  const pid = useUi((s) => s.projectId);
  if (q.data || !q.isError) return <>{children}</>;
  const missing = q.error instanceof ApiError && q.error.status === 404;
  if (missing) {
    return (
      <div className="grid h-full place-items-center p-6" data-testid="page-empty">
        <div className="card-surface max-w-[460px] p-6 text-center">
          <Inbox className="mx-auto size-8 text-brand" />
          <h2 className="mt-3 text-[16px] font-semibold">Project “{pid}” is not on this server</h2>
          <p className="mt-1 text-muted-foreground">It may have been created on another machine or removed. Open the demo project, or import an MDB to start a new allocation.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" variant="outline" asChild><Link to="/import">Import an MDB</Link></Button>
            <Button size="sm" onClick={() => useUi.getState().setProject("demo")}>Open the demo project</Button>
          </div>
        </div>
      </div>
    );
  }
  return <PageError title="The allocation could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
}
