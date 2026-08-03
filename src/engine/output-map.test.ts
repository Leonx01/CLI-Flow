import { describe, it, expect } from 'vitest';
import { applyOutputMap, mapFields } from './output-map.js';

describe('output-map', () => {
  describe('mapFields', () => {
    it('maps simple field names', () => {
      const result = mapFields(
        { name: 'Alice', age: 30 },
        { title: 'name', years: 'age' },
      );
      expect(result).toEqual({ title: 'Alice', years: 30 });
    });

    it('injects constants when field not found', () => {
      const result = mapFields(
        { title: 'Post 1', score: 10 },
        { title: 'title', source: 'hackernews' },
      );
      expect(result).toEqual({ title: 'Post 1', source: 'hackernews' });
    });

    it('prefers field over constant (field-first)', () => {
      const result = mapFields(
        { source: 'reddit', title: 'Post' },
        { src: 'source' },
      );
      expect(result).toEqual({ src: 'reddit' });
    });

    it('resolves dot-path nested fields', () => {
      const result = mapFields(
        { author: { name: 'Bob', id: 42 }, title: 'Hello' },
        { authorName: 'author.name', authorId: 'author.id' },
      );
      expect(result).toEqual({ authorName: 'Bob', authorId: 42 });
    });

    it('falls back to constant for unresolved dot-path', () => {
      const result = mapFields(
        { title: 'Hello' },
        { deep: 'a.b.c' },
      );
      expect(result).toEqual({ deep: 'a.b.c' });
    });

    it('returns empty object for non-object item', () => {
      expect(mapFields(null, { a: 'b' })).toEqual({});
      expect(mapFields(42, { a: 'b' })).toEqual({});
    });
  });

  describe('applyOutputMap', () => {
    it('uses step name (dashes → underscores) as default varName', () => {
      const { varName, mapped } = applyOutputMap([1, 2], undefined, 'my-step');
      expect(varName).toBe('my_step');
      expect(mapped).toEqual([1, 2]);
    });

    it('uses explicit "as" for varName', () => {
      const { varName } = applyOutputMap([], 'custom_name', 'step');
      expect(varName).toBe('custom_name');
    });

    it('applies map to array items', () => {
      const { mapped } = applyOutputMap(
        [{ name: 'A', score: 1 }, { name: 'B', score: 2 }],
        { as: 'items', map: { title: 'name' } },
        'step',
      );
      expect(mapped).toEqual([{ title: 'A' }, { title: 'B' }]);
    });

    it('applies map to single object', () => {
      const { mapped } = applyOutputMap(
        { name: 'X', val: 99 },
        { map: { label: 'name' } },
        'step',
      );
      expect(mapped).toEqual({ label: 'X' });
    });

    it('passes through scalar data without map', () => {
      const { mapped } = applyOutputMap('hello', undefined, 'step');
      expect(mapped).toBe('hello');
    });

    it('constant injection works via applyOutputMap', () => {
      const { mapped } = applyOutputMap(
        [{ title: 'P1' }],
        { as: 'data', map: { title: 'title', source: 'bilibili' } },
        'step',
      );
      expect(mapped).toEqual([{ title: 'P1', source: 'bilibili' }]);
    });
  });
});
