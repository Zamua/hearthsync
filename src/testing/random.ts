import type { GSet, Reg, Regs, Win, Wins } from '../crdt.js';
import type { Rng } from '../rng.js';

// Random inputs for property tests: small value domains and stamp ranges, so ties happen often.

export function randomRoom(rng: Rng): string {
  const b = Array.from({ length: 16 }, () => rng.int(0, 255));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Public ids to author wins. */
export const PIDS = ['0123456789abcdef', 'fedcba9876543210', 'aaaaaaaaaaaaaaaa'];

export const randomStamp = (rng: Rng): number => rng.int(0, 6);

export const randomReg = <T>(rng: Rng, vals: readonly T[]): Reg<T> => ({ val: rng.pick(vals), t: randomStamp(rng) });

export function randomGSet(rng: Rng, ids: readonly string[]): GSet {
  const out: Record<string, number> = {};
  for (const id of ids) if (rng.next() < 0.4) out[id] = randomStamp(rng);
  return out;
}

export function randomRegs<T>(rng: Rng, ids: readonly string[], vals: readonly T[]): Regs<T> {
  const out: Record<string, Reg<T>> = {};
  for (const id of ids) if (rng.next() < 0.5) out[id] = randomReg(rng, vals);
  return out;
}

export function randomWin(rng: Rng): Win {
  const at = rng.next() < 0.25 ? 0 : randomStamp(rng);
  return rng.next() < 0.5 && at ? { at, by: rng.pick(PIDS) } : { at };
}

export function randomWins(rng: Rng, ids: readonly string[]): Wins {
  const out: Record<string, Win> = {};
  for (const id of ids) if (rng.next() < 0.4) out[id] = randomWin(rng);
  return out;
}
