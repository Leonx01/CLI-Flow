import { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { InkAdapter } from '../core/adapter.js';
import { WorkflowTree } from './WorkflowTree.js';
import { InteractOverlay } from './InteractOverlay.js';
import type { ResolvedInteractSpec } from '../../schema/types.js';
import { flatten, toggleCollapsed, cycleForeachExpand } from '../core/tree.js';
import { deriveProgress, deriveStatus, formatDuration, COLORS } from '../core/status.js';
import type { WorkflowNode, InteractRequest } from '../core/types.js';
import { InteractTabBar, extractTabLabel } from './InteractTabBar.js';
import { getLocale } from '../../util/locale.js';
import { openInFileManager } from '../../util/open-file.js';
import { log } from '../../util/utils.js';

// ---------------------------------------------------------------------------
// StatusBar — bottom status indicator
// ---------------------------------------------------------------------------

interface StatusBarProps {
  root: WorkflowNode;
  interactDismissed?: boolean;
  interactCount?: number;
  overlayVisible?: boolean;
  activeInteractSpec?: ResolvedInteractSpec;
  hasMultipleTabs?: boolean;
  hasOutputPaths?: boolean;
}

function StatusBar({ root, interactDismissed, interactCount, overlayVisible, activeInteractSpec, hasMultipleTabs, hasOutputPaths }: StatusBarProps) {
  const status = deriveStatus(root);
  const running = status === 'running' || status === 'interacting';
  const failed = status === 'failed';

  const barColor = running ? COLORS.orange : failed ? COLORS.red : COLORS.green;
  const locale = getLocale();

  const divider = '━'.repeat(48);

  let hint: string;
  if (overlayVisible && activeInteractSpec) {
    const parts: string[] = [];
    if (activeInteractSpec.type === 'multi-select') parts.push(locale.hint_space_select);
    parts.push(locale.hint_move);
    if (hasMultipleTabs) parts.push(locale.hint_switch_tabs);
    parts.push(locale.hint_enter);
    parts.push(locale.hint_esc_hide);
    hint = parts.join(' · ');
  } else if (interactDismissed) {
    hint = `${locale.hint_move} · ${locale.hint_reopen_interact}(${interactCount ?? 0}) · ${locale.hint_esc_exit}`;
  } else {
    hint = `${locale.hint_move} · ${locale.hint_fold}`;
    if (hasOutputPaths) hint += ` · ${locale.hint_open_output}`;
    hint += ` · ${locale.hint_esc_exit}`;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={barColor}>{divider}</Text>
      <Box>
        <Text color={COLORS.dim}>{hint}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App — root component
// ---------------------------------------------------------------------------

interface AppProps {
  adapter: InkAdapter;
}

export function App({ adapter }: AppProps) {
  const { exit } = useApp();
  const [root, setRoot] = useState<WorkflowNode>(() => adapter.getRoot());
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [interacts, setInteracts] = useState<InteractRequest[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [interactDismissed, setInteractDismissed] = useState(false);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [workflowFinished, setWorkflowFinished] = useState(false);

  // Flatten tree into rows
  const rows = useMemo(() => flatten(root), [root]);

  // Subscribe to adapter tree updates
  useEffect(() => {
    const unsub = adapter.subscribe((newRoot) => {
      setRoot(newRoot);
      const s = deriveStatus(newRoot);
      if (s === 'done' || s === 'failed') {
        setWorkflowFinished(true);
      }
    });
    return unsub;
  }, [adapter]);

  // Subscribe to interact requests
  useEffect(() => {
    const unsub = adapter.onInteractRequest((reqs) => {
      setInteracts(reqs);
      setActiveTabId((prev) => {
        // If previous active tab is still in queue, keep it
        if (prev && reqs.some(r => r.id === prev)) return prev;
        // Otherwise activate the first one (or null if empty)
        return reqs.length > 0 ? reqs[0].id : null;
      });
      if (reqs.length > 0) setInteractDismissed(false);
    });
    return unsub;
  }, [adapter]);

  // Spinner animation (80ms)
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerTick((t) => t + 1);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Elapsed time (computed from adapter.startedAt)
  useEffect(() => {
    if (workflowFinished) return;
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - adapter.startedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [adapter, workflowFinished]);

  // Clamp selection when row count changes
  useEffect(() => {
    setSelectedIndex((i) => i < 0 ? i : Math.min(Math.max(1, i), Math.max(1, rows.length - 1)));
  }, [rows.length]);

  // Keyboard navigation
  useInput((input, key) => {
    const overlayVisible = interacts.length > 0 && !interactDismissed;

    // Overlay-specific keys when overlay is visible
    if (overlayVisible) {
      if (key.escape) {
        setInteractDismissed(true);
        return;
      }
      if (key.rightArrow && interacts.length > 1) {
        const ids = interacts.map(r => r.id);
        const idx = ids.indexOf(activeTabId ?? '');
        const nextId = ids[(idx + 1) % ids.length];
        setActiveTabId(nextId);
        const nextReq = interacts.find(r => r.id === nextId);
        if (nextReq) {
          const rowIdx = rows.findIndex(r => r.node.id === nextReq.stepName);
          if (rowIdx >= 0) setSelectedIndex(rowIdx);
        }
        return;
      }
      if (key.leftArrow && interacts.length > 1) {
        const ids = interacts.map(r => r.id);
        const idx = ids.indexOf(activeTabId ?? '');
        const nextId = ids[(idx - 1 + ids.length) % ids.length];
        setActiveTabId(nextId);
        const nextReq = interacts.find(r => r.id === nextId);
        if (nextReq) {
          const rowIdx = rows.findIndex(r => r.node.id === nextReq.stepName);
          if (rowIdx >= 0) setSelectedIndex(rowIdx);
        }
        return;
      }
      // up/down/enter/space handled by overlay prompt components
      return;
    }

    // Tree navigation (only when overlay is NOT visible)
    if (key.upArrow) {
      setSelectedIndex((i) => i < 0 ? 1 : Math.max(1, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => i < 0 ? 1 : Math.min(rows.length - 1, i + 1));
      return;
    }

    // Tree mode keys (no overlay visible)
    if (key.escape || (key.ctrl && input === 'c')) {
      if (workflowFinished) {
        adapter.resolveUserExit();
      } else {
        adapter.resolveUserExit();
        process.kill(process.pid, 'SIGINT');
      }
      exit();
      return;
    }

    if (key.return && interactDismissed && interacts.length > 0) {
      setInteractDismissed(false);
      return;
    }

    const current = rows[selectedIndex];
    if (!current) return;

    const isForeach =
      current.node.meta?.foreachProgress !== undefined ||
      current.node.meta?.foreachSource !== undefined;

    if (key.rightArrow) {
      if (isForeach) {
        setRoot((r) => cycleForeachExpand(r, current.path, 'expand'));
      } else if (current.node.children && current.node.children.length > 0 && current.node.collapsed) {
        setRoot((r) => toggleCollapsed(r, current.path));
      }
      return;
    }

    if (key.leftArrow) {
      if (isForeach) {
        setRoot((r) => cycleForeachExpand(r, current.path, 'collapse'));
      } else if (current.node.children && current.node.children.length > 0 && !current.node.collapsed) {
        setRoot((r) => toggleCollapsed(r, current.path));
      }
      return;
    }

    if (key.return) {
      if (current.node.children && current.node.children.length > 0) {
        setRoot((r) => toggleCollapsed(r, current.path));
      }
      return;
    }

    if (input === ' ') {
      if (current.node.children && current.node.children.length > 0) {
        setRoot((r) => toggleCollapsed(r, current.path));
      }
    }

    // 'o' — reveal selected step's output files in the OS file manager.
    // Only when the workflow has finished, so we don't open half-written files.
    if (input === 'o' && workflowFinished) {
      const outputs = current.node.meta?.outputPaths;
      if (outputs && outputs.length > 0) {
        for (const p of outputs) {
          openInFileManager(p).catch((err: unknown) => {
            log.warn?.(`Failed to open ${p}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    }
  }, { isActive: true });

  // Handle interact completion
  const handleInteractComplete = (answer: unknown) => {
    const active = interacts.find(r => r.id === activeTabId);
    if (active) {
      active.resolve(answer);
    }
  };

  // Compute progress
  const progress = deriveProgress(root);
  const wfStatus = deriveStatus(root);

  const activeInteract = interacts.find(r => r.id === activeTabId) ?? null;
  const tabs = interacts.map(extractTabLabel);

  // Whether the currently selected node has output files to reveal ('o' key)
  const selectedOutputPaths = rows[selectedIndex]?.node.meta?.outputPaths;
  const hasOutputPaths = workflowFinished && !!selectedOutputPaths && selectedOutputPaths.length > 0;

  return (
    <Box flexDirection="column">
      <WorkflowTree
        rows={rows}
        selectedIndex={selectedIndex}
        spinnerTick={spinnerTick}
        workflowName={root.label}
        elapsedMs={elapsedMs}
        progress={progress}
        workflowStatus={wfStatus}
        interactDismissed={interactDismissed && interacts.length > 0}
      />
      {interacts.length > 0 && !interactDismissed && (
        <Text color={COLORS.purple}>{'─'.repeat(48)}</Text>
      )}
      {interacts.length > 0 && !interactDismissed && (
        <InteractTabBar tabs={tabs} activeId={activeTabId} />
      )}
      {activeInteract && !interactDismissed && (
        <Box marginTop={1}>
          <InteractOverlay
            key={activeTabId}
            spec={activeInteract.spec as ResolvedInteractSpec}
            onComplete={handleInteractComplete}
            hasMultipleTabs={interacts.length > 1}
          />
        </Box>
      )}
      <Box>
        <StatusBar
          root={root}
          interactDismissed={interactDismissed && interacts.length > 0}
          interactCount={interacts.length}
          overlayVisible={interacts.length > 0 && !interactDismissed}
          activeInteractSpec={activeInteract?.spec as ResolvedInteractSpec}
          hasMultipleTabs={interacts.length > 1}
          hasOutputPaths={hasOutputPaths}
        />
      </Box>
    </Box>
  );
}
