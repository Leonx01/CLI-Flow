import { Box, Text } from 'ink';
import { COLORS } from '../core/status.js';

interface InteractTabBarProps {
  tabs: Array<{ id: string; label: string }>;
  activeId: string | null;
}

export function InteractTabBar({ tabs, activeId }: InteractTabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <Box paddingX={1}>
      {tabs.length > 1 && <Text color={COLORS.dim}>{'←  '}</Text>}
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeId;
        return (
          <Text key={tab.id}>
            {i > 0 ? '   ' : ''}
            {isActive
              ? <Text color={COLORS.purple}>[{tab.label}]</Text>
              : <Text color={COLORS.dim}>{tab.label}</Text>
            }
          </Text>
        );
      })}
      {tabs.length > 1 && <Text color={COLORS.dim}>{'  →'}</Text>}
    </Box>
  );
}

/** 从 InteractRequest 提取 tab 标签 */
export function extractTabLabel(req: { id: string; stepName?: string; tabLabel?: string }): { id: string; label: string } {
  return { id: req.id, label: req.tabLabel || req.stepName || req.id };
}
