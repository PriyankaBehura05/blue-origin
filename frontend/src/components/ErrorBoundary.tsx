import { Component, type ErrorInfo, type ReactNode } from 'react';

// Keeps a failing page from blanking the whole app: shows the error with a way to recover instead.
// Give it key={pathname} so moving to another page starts fresh.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed to render', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const resetFilters = () => {
      try {
        localStorage.removeItem('bo_network_filters');
      } catch {
        /* nothing stored */
      }
      window.location.reload();
    };
    return (
      <div className="card card-pad setup">
        <h2>This page could not be shown</h2>
        <p className="note">{error.message}</p>
        <div className="toolbar">
          <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn" onClick={resetFilters}>Reset dashboard filters and reload</button>
        </div>
      </div>
    );
  }
}
