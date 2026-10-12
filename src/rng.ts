export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
}

/** mulberry32. next() is in [0, 1); int() is inclusive at both ends. */
export function makeRng(seed: number): Rng {
  let a = seed | 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (max < min) throw new RangeError(`int: max ${max} < min ${min}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  const pick = <T>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new RangeError('pick: empty array');
    return xs[int(0, xs.length - 1)]!;
  };
  return { next, int, pick };
}
