import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS } from '../core/status.js';
import type { ResolvedInteractSpec } from '../../schema/types.js';
import { getLocale } from '../../util/locale.js';

const CHECK_GREEN = '#4EC9B0';
const VISIBLE_WINDOW = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InteractOverlayProps {
  spec: ResolvedInteractSpec;
  onComplete: (answer: unknown) => void;
  hasMultipleTabs?: boolean;
}

// ---------------------------------------------------------------------------
// ConfirmPrompt
// ---------------------------------------------------------------------------

function ConfirmPrompt({ spec, onComplete }: InteractOverlayProps) {
  const defaultValue = 'defaultValue' in spec ? spec.defaultValue : true;
  const [cursor, setCursor] = useState(defaultValue === false ? 1 : 0);
  const locale = getLocale();

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      setCursor((c) => (c === 0 ? 1 : 0));
    } else if (key.return) {
      onComplete(cursor === 0);
    }
  });

  const options = [locale.confirm_yes, locale.confirm_no];

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={`confirm-${i}`} color={i === cursor ? COLORS.purple : COLORS.dim}>
          {i === cursor ? '❯ ' : '  '}{i + 1}. {opt}
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// AuthPrompt
// ---------------------------------------------------------------------------

function AuthPrompt({ spec, onComplete }: InteractOverlayProps) {
  const [cursor, setCursor] = useState(0);
  const locale = getLocale();

  const options = [
    { label: locale.auth_open_browser, value: 'login' },
    { label: locale.auth_skip, value: 'skip' },
    { label: locale.auth_abort, value: 'abort' },
  ];

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(options.length - 1, c + 1));
    } else if (key.return) {
      onComplete(options[cursor].value);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={`auth-${i}`} color={i === cursor ? COLORS.purple : COLORS.dim}>
          {i === cursor ? '❯ ' : '  '}{i + 1}. {opt.label}
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SelectPrompt
// ---------------------------------------------------------------------------

function SelectPrompt({ spec, onComplete }: InteractOverlayProps) {
  const options = 'options' in spec ? spec.options : [];
  const defaultIdx = 'defaultValue' in spec && spec.defaultValue !== undefined
    ? options.findIndex(o => o.value === spec.defaultValue)
    : -1;
  const [cursor, setCursor] = useState(defaultIdx >= 0 ? defaultIdx : 0);
  const [windowStart, setWindowStart] = useState(0);
  const needsScroll = options.length > VISIBLE_WINDOW;

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        if (needsScroll && next < windowStart) setWindowStart(next);
        return next;
      });
    } else if (key.downArrow) {
      setCursor((c) => {
        const next = Math.min(options.length - 1, c + 1);
        if (needsScroll && next >= windowStart + VISIBLE_WINDOW) setWindowStart(next - VISIBLE_WINDOW + 1);
        return next;
      });
    } else if (key.return) {
      onComplete(options[cursor]?.value);
    }
  });

  const visibleOptions = needsScroll ? options.slice(windowStart, windowStart + VISIBLE_WINDOW) : options;
  const aboveCount = windowStart;
  const belowCount = options.length - windowStart - (needsScroll ? VISIBLE_WINDOW : options.length);

  return (
    <Box flexDirection="column">
      {needsScroll && aboveCount > 0 && (
        <Text color={COLORS.dim}>  ↑ {aboveCount} more</Text>
      )}
      {visibleOptions.map((option, i) => {
        const realIndex = windowStart + i;
        return (
          <Box key={`choice-${realIndex}`} flexDirection="column">
            <Text color={realIndex === cursor ? COLORS.purple : COLORS.dim}>
              {realIndex === cursor ? '❯ ' : '  '}{realIndex + 1}. {option.label}
            </Text>
          </Box>
        );
      })}
      {needsScroll && belowCount > 0 && (
        <Text color={COLORS.dim}>  ↓ {belowCount} more</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MultiSelectPrompt
// ---------------------------------------------------------------------------

function MultiSelectPrompt({ spec, onComplete }: InteractOverlayProps) {
  const options = 'options' in spec ? spec.options : [];
  const defaultIndices = 'defaultValues' in spec && Array.isArray(spec.defaultValues)
    ? new Set(
        spec.defaultValues
          .map(v => options.findIndex(o => o.value === v))
          .filter(i => i >= 0),
      )
    : new Set<number>();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(defaultIndices);
  const [windowStart, setWindowStart] = useState(0);
  const needsScroll = options.length > VISIBLE_WINDOW;

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        if (needsScroll && next < windowStart) setWindowStart(next);
        return next;
      });
    } else if (key.downArrow) {
      setCursor((c) => {
        const next = Math.min(options.length - 1, c + 1);
        if (needsScroll && next >= windowStart + VISIBLE_WINDOW) setWindowStart(next - VISIBLE_WINDOW + 1);
        return next;
      });
    } else if (input === ' ') {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) {
          next.delete(cursor);
        } else {
          next.add(cursor);
        }
        return next;
      });
    } else if (key.return) {
      const values = options
        .filter((_, i) => selected.has(i))
        .map((o) => o.value);
      onComplete(values);
    }
  });

  const visibleOptions = needsScroll ? options.slice(windowStart, windowStart + VISIBLE_WINDOW) : options;
  const aboveCount = windowStart;
  const belowCount = options.length - windowStart - (needsScroll ? VISIBLE_WINDOW : options.length);

  return (
    <Box flexDirection="column">
      {needsScroll && aboveCount > 0 && (
        <Text color={COLORS.dim}>  ↑ {aboveCount} more</Text>
      )}
      {visibleOptions.map((option, i) => {
        const realIndex = windowStart + i;
        const isCursor = realIndex === cursor;
        const isSelected = selected.has(realIndex);
        const checkMark = isSelected ? '✔' : ' ';
        const checkColor = isSelected ? CHECK_GREEN : (isCursor ? COLORS.purple : COLORS.dim);
        const textColor = isCursor ? COLORS.purple : COLORS.dim;
        return (
          <Text key={`choice-${realIndex}`} color={textColor}>
            {isCursor ? '❯ ' : '  '}{realIndex + 1}. [<Text color={checkColor}>{checkMark}</Text>] {option.label}
          </Text>
        );
      })}
      {needsScroll && belowCount > 0 && (
        <Text color={COLORS.dim}>  ↓ {belowCount} more</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InputPrompt
// ---------------------------------------------------------------------------

function InputPrompt({ spec, onComplete }: InteractOverlayProps) {
  const defaultVal = 'default' in spec ? (spec.default as string) ?? '' : '';
  const [value, setValue] = useState<string>(defaultVal);

  useInput((input, key) => {
    if (key.return) {
      onComplete(value);
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
    } else if (!key.ctrl && !key.meta && input) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLORS.white}>{value}</Text>
        <Text color={COLORS.purple}>{'█'}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InteractOverlay — root overlay component
// ---------------------------------------------------------------------------

export function InteractOverlay({ spec, onComplete, hasMultipleTabs }: InteractOverlayProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={COLORS.white}>{spec.type === 'auth' ? `⚠ ${spec.message}` : spec.message}</Text>
      <Text>{' '}</Text>
      {spec.type === 'confirm' && (
        <ConfirmPrompt spec={spec} onComplete={onComplete} hasMultipleTabs={hasMultipleTabs} />
      )}
      {spec.type === 'select' && (
        <SelectPrompt spec={spec} onComplete={onComplete} hasMultipleTabs={hasMultipleTabs} />
      )}
      {spec.type === 'multi-select' && (
        <MultiSelectPrompt spec={spec} onComplete={onComplete} hasMultipleTabs={hasMultipleTabs} />
      )}
      {spec.type === 'input' && (
        <InputPrompt spec={spec} onComplete={onComplete} hasMultipleTabs={hasMultipleTabs} />
      )}
      {spec.type === 'auth' && (
        <AuthPrompt spec={spec} onComplete={onComplete} hasMultipleTabs={hasMultipleTabs} />
      )}
    </Box>
  );
}
