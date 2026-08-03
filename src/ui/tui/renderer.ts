/**
 * Ink TUI renderer entry point — used by cli.ts to launch the Ink-based workflow UI.
 */
import type { WorkflowCallbacks, TraceEvent } from '../../schema/types.js';
import { log } from '../../util/utils.js';

export interface InkRendererHandle {
  getCallbacks(): WorkflowCallbacks;
  unmount(): void;
  waitForEnd(): Promise<void>;
  getOutputPaths(): string[];
}

export interface WorkflowDef {
  name: string;
  steps: Record<string, {
    adapter?: string;
    workflow?: string;
    foreach?: string;
    depends_on?: string[];
    description?: string;
    timeout?: number;
    on_error?: string;
  }>;
}

export async function createInkRenderer(
  def: WorkflowDef,
  onTraceEvent?: (stepName: string, event: TraceEvent) => void,
): Promise<InkRendererHandle> {
  try {
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./App.js');
    const { InkAdapter } = await import('../core/adapter.js');

    const adapter = new InkAdapter(def, onTraceEvent);
    const instance = render(React.createElement(App, { adapter }));

    return {
      getCallbacks: () => adapter.getCallbacks(),
      unmount: () => {
        instance.unmount();
      },
      waitForEnd: () => adapter.waitForUserExit(),
      getOutputPaths: () => adapter.getOutputPaths(),
    };
  } catch (err) {
    log.warn?.(`Ink TUI failed to load, falling back to headless mode: ${err instanceof Error ? err.message : String(err)}`);
    return {
      getCallbacks: () => ({}),
      unmount: () => {},
      waitForEnd: () => Promise.resolve(),
      getOutputPaths: () => [],
    };
  }
}
