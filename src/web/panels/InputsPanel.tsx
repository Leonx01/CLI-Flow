import React from 'react';
import type { WorkflowInput } from '../../schema/types.js';

interface InputsPanelProps {
  inputs: Record<string, WorkflowInput>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-card)', color: 'var(--text-primary)',
  fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none',
  boxSizing: 'border-box',
};

export default function InputsPanel({ inputs, values, onChange, disabled }: InputsPanelProps) {
  const entries = Object.entries(inputs || {});

  return React.createElement('div', { style: { padding: 16 } as React.CSSProperties },
    React.createElement('div', { style: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 } as React.CSSProperties }, 'Workflow Inputs'),
    entries.length === 0 && React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 12 } as React.CSSProperties }, 'This workflow takes no inputs.'),

    entries.map(([key, spec]) => {
      const val = values[key];
      const isRequired = !!spec.required;
      const missing = isRequired && (val === undefined || val === '' || val === null);

      return React.createElement('div', { key, style: { marginBottom: 12 } as React.CSSProperties },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } as React.CSSProperties },
          React.createElement('label', { style: { color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 } as React.CSSProperties }, key),
          React.createElement('span', { style: { color: isRequired ? '#cf222e' : 'var(--text-muted)', fontSize: 10 } as React.CSSProperties }, isRequired ? 'required' : 'optional'),
          missing && React.createElement('span', { style: { color: '#cf222e', fontSize: 10, fontWeight: 600 } as React.CSSProperties }, '— missing'),
        ),
        spec.description && React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 4, lineHeight: 1.4 } as React.CSSProperties }, spec.description),
        spec.type === 'number'
          ? React.createElement('input', {
              type: 'number',
              value: val === undefined || val === null ? '' : String(val),
              disabled,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                const v = e.target.value;
                onChange(key, v === '' ? undefined : Number(v));
              },
              style: inputStyle,
            })
          : spec.type === 'boolean'
            ? React.createElement('select', {
                value: val === undefined || val === null ? '' : String(val),
                disabled,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                  const v = e.target.value;
                  onChange(key, v === '' ? undefined : v === 'true');
                },
                style: inputStyle,
              },
                React.createElement('option', { value: '' }, '(unset)'),
                React.createElement('option', { value: 'true' }, 'true'),
                React.createElement('option', { value: 'false' }, 'false'),
              )
            : React.createElement('input', {
                type: 'text',
                value: val === undefined || val === null ? '' : String(val),
                disabled,
                placeholder: spec.description || key,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(key, e.target.value === '' ? undefined : e.target.value),
                style: inputStyle,
              }),
      );
    }),
  );
}
