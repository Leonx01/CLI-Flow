import React, { useState } from 'react';

interface InteractSpec {
  type: string;
  message: string;
  options?: { label: string; value: unknown }[];
  default?: string;
  defaultValue?: unknown;
  defaultValues?: unknown[];
}

interface InteractPanelProps {
  interact: { stepName: string; spec: InteractSpec };
  onSubmit: (answer: unknown) => void;
}

const inputStyle: React.CSSProperties = {
  padding: '9px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  width: '100%',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px',
  borderRadius: 6,
  border: 'none',
  background: '#2da44e',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '9px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-card)',
  color: 'var(--text-secondary)',
  fontSize: 13,
  cursor: 'pointer',
};

function optionStyle(selected: boolean): React.CSSProperties {
  return {
    padding: '9px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    background: selected ? 'rgba(45, 164, 78, 0.1)' : 'var(--bg-input)',
    border: `1px solid ${selected ? '#2da44e' : 'var(--border-color)'}`,
    color: 'var(--text-primary)',
    fontSize: 13,
    transition: 'all 0.15s',
  };
}

export default function InteractPanel({ interact, onSubmit }: InteractPanelProps) {
  const { spec, stepName } = interact;
  const [value, setValue] = useState<unknown>(
    spec.type === 'multi-select' ? (spec.defaultValues ?? [])
    : spec.type === 'select' ? (spec.defaultValue ?? spec.options?.[0]?.value)
    : spec.default || ''
  );
  const [inputText, setInputText] = useState(spec.default || '');

  const handleSubmit = () => {
    if (spec.type === 'input') {
      onSubmit(inputText);
    } else {
      onSubmit(value);
    }
  };

  return React.createElement('div', {
    style: { padding: 20, height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)' } as React.CSSProperties,
  },
    React.createElement('div', { style: { color: 'var(--color-interacting)', fontSize: 14, fontWeight: 700, marginBottom: 4 } as React.CSSProperties }, 'Interact'),
    React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)', marginBottom: 12 } as React.CSSProperties }, stepName),
    React.createElement('div', { style: { color: 'var(--text-primary)', fontSize: 14, marginBottom: 16, lineHeight: 1.5 } as React.CSSProperties }, spec.message),

    spec.type === 'confirm' && React.createElement('div', { style: { display: 'flex', gap: 8 } as React.CSSProperties },
      React.createElement('button', { onClick: () => onSubmit(true), style: { ...primaryBtnStyle, flex: 1 } as React.CSSProperties }, 'Confirm'),
      React.createElement('button', { onClick: () => onSubmit(false), style: { ...secondaryBtnStyle, flex: 1 } as React.CSSProperties }, 'Cancel'),
    ),

    spec.type === 'input' && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties },
      React.createElement('input', {
        type: 'text',
        value: inputText,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInputText(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSubmit(); },
        placeholder: spec.default || 'Type your answer...',
        autoFocus: true,
        style: inputStyle,
      }),
      React.createElement('button', { onClick: handleSubmit, style: primaryBtnStyle }, 'Submit'),
    ),

    spec.type === 'select' && spec.options && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } as React.CSSProperties },
      spec.options.map((opt: { label: string; value: unknown }) =>
        React.createElement('div', {
          key: String(opt.value),
          onClick: () => { setValue(opt.value); },
          style: optionStyle(value === opt.value),
        }, opt.label),
      ),
      React.createElement('button', { onClick: handleSubmit, style: { ...primaryBtnStyle, marginTop: 8 } as React.CSSProperties }, 'Confirm Selection'),
    ),

    spec.type === 'multi-select' && spec.options && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } as React.CSSProperties },
      spec.options.map((opt: { label: string; value: unknown }) => {
        const isSelected = Array.isArray(value) && value.includes(opt.value);
        return React.createElement('div', {
          key: String(opt.value),
          onClick: () => {
            if (Array.isArray(value)) {
              setValue(isSelected ? value.filter(v => v !== opt.value) : [...value, opt.value]);
            }
          },
          style: optionStyle(isSelected),
        },
          React.createElement('span', { style: { color: isSelected ? '#2da44e' : 'var(--text-muted)', fontWeight: 600, marginRight: 8 } as React.CSSProperties }, isSelected ? '✓' : '○'),
          opt.label,
        );
      }),
      React.createElement('button', { onClick: handleSubmit, style: { ...primaryBtnStyle, marginTop: 8 } as React.CSSProperties }, 'Confirm Selection'),
    ),
  );
}
