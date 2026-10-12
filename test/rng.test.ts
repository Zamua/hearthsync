import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/rng.js';

const draws = (seed: number, n: number): number[] => {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe('makeRng', () => {
  it('is deterministic per seed', () => {
    expect(draws(42, 50)).toEqual(draws(42, 50));
  });

  it('differs across seeds', () => {
    expect(draws(1, 10)).not.toEqual(draws(2, 10));
  });

  it('next() stays in [0, 1)', () => {
    for (const x of draws(7, 5000)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('int() is inclusive at both ends and integral', () => {
    const rng = makeRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(2, 5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
    expect(rng.int(9, 9)).toBe(9);
  });

  it('pick() returns every element eventually and rejects empty input', () => {
    const rng = makeRng(11);
    const xs = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(rng.pick(xs));
    expect(seen.size).toBe(3);
    expect(() => rng.pick([])).toThrow();
  });
});
