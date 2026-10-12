import { sha256Hex } from './sha256.js';

// State-based CRDT building blocks. Every merge is commutative, associative and idempotent, and its result is
// canonical, so two devices holding the same state build byte-identical docs.

/** A hybrid logical clock value on the millisecond scale. */
export type Stamp = number;
/** A choice field: the last edit wins. */
export interface Reg<T> { val: T; t: Stamp }
/** A grow-only set: each member with the stamp it was first added at, which orders the list. */
export type GSet = Readonly<Record<string, Stamp>>;
/** Something that happened once, kept at its first time and author. at 0 is weak: known to have happened, with no time or author. */
export interface Win { at: Stamp; by?: string }
export type Wins = Readonly<Record<string, Win>>;

export const isStamp = (x: unknown): x is Stamp => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** JSON with object keys sorted and undefined members dropped. */
export function canon(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map(v => (v === undefined ? 'null' : canon(v))).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** A doc's version for the outbox: 64 bits of its canonical form's SHA-256. */
export const hash = (doc: unknown): string => sha256Hex(canon(doc)).slice(0, 16);

/** The next stamp: never behind the wall clock, always past everything seen. */
export const tick = (clock: Stamp, now: number): Stamp => Math.max(Math.floor(now), clock + 1);

/** Equal stamps fall back to the value, so the pick never depends on which side is which. */
export function lww<T>(a: Reg<T>, b: Reg<T>): Reg<T> {
  if (a.t !== b.t) return a.t > b.t ? a : b;
  return canon(a.val) >= canon(b.val) ? a : b;
}

export function lwwOpt<T>(a: Reg<T> | undefined, b: Reg<T> | undefined): Reg<T> | undefined {
  return a && b ? lww(a, b) : a ?? b;
}

const sorted = <V>(o: Readonly<Record<string, V>>): Record<string, V> => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]!]));

/** Registers by key, each merged on its own; a key held on one side only is kept. */
export type Regs<T> = Readonly<Record<string, Reg<T>>>;

export function regsMerge<T>(a: Regs<T>, b: Regs<T>): Regs<T> {
  const out: Record<string, Reg<T>> = { ...a };
  for (const [k, r] of Object.entries(b)) out[k] = k in out ? lww(out[k]!, r) : r;
  return sorted(out);
}

export function gsetMerge(a: GSet, b: GSet): GSet {
  const out: Record<string, Stamp> = { ...a };
  for (const [k, t] of Object.entries(b)) out[k] = k in out ? Math.min(out[k]!, t) : t;
  return sorted(out);
}

/** Adds the ids not yet in s at stamp t; s itself when nothing is new. */
export function gsetAdd(s: GSet, ids: readonly string[], t: Stamp): GSet {
  const add = ids.filter(id => !Object.hasOwn(s, id));
  return add.length ? gsetMerge(s, Object.fromEntries(add.map(id => [id, t]))) : s;
}

/** Members in the order first added (then by id). */
export const gsetList = (s: GSet): string[] => Object.keys(s).sort((x, y) => s[x]! - s[y]! || (x < y ? -1 : x > y ? 1 : 0));

const winKey = (w: Win): number => (w.at === 0 ? Infinity : w.at);

/** The earliest strong win, and its author; a weak one only when neither is strong. */
export function winMerge(a: Win, b: Win): Win {
  const ka = winKey(a), kb = winKey(b);
  if (ka !== kb) return ka < kb ? a : b;
  return (a.by ?? '') <= (b.by ?? '') ? a : b;
}

export function winsMerge(a: Wins, b: Wins): Wins {
  const out: Record<string, Win> = { ...a };
  for (const [k, w] of Object.entries(b)) out[k] = k in out ? winMerge(out[k]!, w) : w;
  return sorted(out);
}

/** Ids in the order won; weak wins last. */
export const winsList = (w: Wins): string[] => Object.keys(w).sort((x, y) => winKey(w[x]!) - winKey(w[y]!) || (x < y ? -1 : x > y ? 1 : 0));
