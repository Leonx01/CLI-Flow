import { describe, it, expect } from 'vitest';
import { WorkflowContext } from './context.js';

describe('WorkflowContext', () => {
  describe('set/get/has', () => {
    it('stores and retrieves values', () => {
      const ctx = new WorkflowContext();
      ctx.set('products', [{ id: 1 }, { id: 2 }]);
      expect(ctx.has('products')).toBe(true);
      expect(ctx.get('products')).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('returns undefined for unset keys', () => {
      const ctx = new WorkflowContext();
      expect(ctx.has('missing')).toBe(false);
      expect(ctx.get('missing')).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('resolves $varname references', () => {
      const ctx = new WorkflowContext();
      ctx.set('name', 'test-workflow');
      const result = ctx.resolve('$name');
      expect(result).toBe('test-workflow');
    });

    it('resolves $item.field in foreach context', () => {
      const ctx = new WorkflowContext();
      const item = { id: '123', title: 'Hello' };
      expect(ctx.resolve('$item.id', item)).toBe('123');
      expect(ctx.resolve('$item.title', item)).toBe('Hello');
    });

    it('resolves $index in foreach context', () => {
      const ctx = new WorkflowContext();
      expect(ctx.resolve('$index', {}, 5)).toBe(5);
    });

    it('passes through non-string values', () => {
      const ctx = new WorkflowContext();
      expect(ctx.resolve(42)).toBe(42);
      expect(ctx.resolve(true)).toBe(true);
      expect(ctx.resolve(null)).toBe(null);
    });
  });

  describe('resolveArgs', () => {
    it('resolves all values in an args object', () => {
      const ctx = new WorkflowContext();
      ctx.set('category', 'dress');
      const result = ctx.resolveArgs({
        cat: '$category',
        limit: 10,
      });
      expect(result.cat).toBe('dress');
      expect(result.limit).toBe(10);
    });
  });

  describe('serialization', () => {
    it('serializes and deserializes', () => {
      const ctx = new WorkflowContext();
      ctx.set('items', [1, 2, 3]);
      ctx.set('name', 'test');
      const json = ctx.toJSON();
      const restored = WorkflowContext.fromJSON(json);
      expect(restored.get('items')).toEqual([1, 2, 3]);
      expect(restored.get('name')).toBe('test');
    });
  });

  describe('extractVarRefs', () => {
    it('extracts $varname references', () => {
      const ctx = new WorkflowContext();
      expect(ctx.extractVarRefs('$foo')).toEqual(['foo']);
    });

    it('extracts ${{ args.varname }} references', () => {
      const ctx = new WorkflowContext();
      expect(ctx.extractVarRefs('${{ args.bar }}')).toEqual(['bar']);
    });

    it('excludes ${{ args.varname | default(...) }} from required refs', () => {
      const ctx = new WorkflowContext();
      expect(ctx.extractVarRefs('${{ args.competitor_analysis | default("未启用") }}')).toEqual([]);
    });

    it('still includes ${{ args.varname }} without default', () => {
      const ctx = new WorkflowContext();
      const refs = ctx.extractVarRefs('prefix ${{ args.x }} and ${{ args.y | default(0) }} suffix');
      expect(refs).toContain('x');
      expect(refs).not.toContain('y');
    });

    it('ignores $item and $index', () => {
      const ctx = new WorkflowContext();
      expect(ctx.extractVarRefs('$item.name $index')).toEqual([]);
    });
  });
});
