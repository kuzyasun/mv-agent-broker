import { Component, type ComponentChildren, type JSX } from "preact";

interface ErrorBoundaryProps {
  children?: ComponentChildren;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static override getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: unknown): void {
    console.error("Operator UI ErrorBoundary caught error:", error, errorInfo);
  }

  override render(): JSX.Element | ComponentChildren {
    if (this.state.hasError) {
      return (
        <div className="flex-1 p-6 bg-[#f8f9fa] flex items-center justify-center">
          <div className="border border-[#dc2626] bg-white p-6 max-w-lg w-full space-y-4">
            <h2 className="text-sm font-semibold text-[#dc2626]">
              Rendering Error Occurred
            </h2>
            <p className="text-xs text-[#434655]">
              An unexpected error prevented this section from rendering properly.
            </p>
            {this.state.error && (
              <pre className="text-xs font-mono bg-[#f8f9fa] p-3 border border-[#c4c5d7] overflow-x-auto text-[#141b2b]">
                {this.state.error.message || String(this.state.error)}
              </pre>
            )}
            <button
              type="button"
              className="h-8 px-4 bg-[#1d4ed8] text-white text-xs font-medium cursor-pointer"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              Reload Operator UI
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
