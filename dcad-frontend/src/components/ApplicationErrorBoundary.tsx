import { Component, type ReactNode } from 'react';
import { reportApplicationRenderFailure } from '@/lib/applicationErrorTelemetry';

type Props = {
  children: ReactNode;
};

type State = {
  failed: boolean;
};

export default class ApplicationErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error('[application] uncaught render error');
    void reportApplicationRenderFailure(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="hn-app-shell grid place-items-center px-6">
        <section className="hn-workspace-surface w-full max-w-md overflow-hidden rounded-3xl border p-8">
          <p className="hn-eyebrow text-xs tracking-[0.22em]">HomeNode</p>
          <h1 className="mt-3 text-2xl font-semibold text-slate-950">Workspace recovery required</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            This page could not finish loading. Previously saved appraisal data is unchanged; reload the workspace to recover.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="hn-action-primary mt-7 w-full rounded-xl px-5 py-3 font-semibold transition"
          >
            Reload workspace
          </button>
        </section>
      </main>
    );
  }
}
