import { expect } from 'vitest';
import { canon } from '../src/crdt.js';
import { makeRng, type Rng } from '../src/rng.js';

/** A merge is commutative, associative and idempotent, compared as canonical JSON. */
export function laws<T>(gen: (rng: Rng) => T, merge: (a: T, b: T) => T, runs = 400): void {
  const rng = makeRng(11);
  for (let i = 0; i < runs; i++) {
    const a = gen(rng), b = gen(rng), c = gen(rng);
    expect(canon(merge(a, b))).toBe(canon(merge(b, a)));
    expect(canon(merge(merge(a, b), c))).toBe(canon(merge(a, merge(b, c))));
    expect(canon(merge(a, a))).toBe(canon(a));
  }
}
