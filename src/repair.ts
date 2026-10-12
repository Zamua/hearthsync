import { gsetMerge, isStamp, regsMerge, winsMerge, type GSet, type Reg, type Regs, type Stamp, type Win, type Wins } from './crdt.js';

// Records read from untrusted JSON: a room anyone holding the code may write, or storage another build wrote. Repair
// keeps anything well formed, even ids this build does not know (a newer build's), and leaves judging them to the app.

export type Obj = Record<string, unknown>;
export const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

const MEMBER = /^[0-9a-z][0-9a-z_:.-]{0,47}$/;
const PID = /^[0-9a-f]{16}$/;
/** Bounds junk: no real set or map comes near it. */
export const MAX_MEMBERS = 256;

/** An id a set or map may hold: lower case letters, digits and `_:.-`, up to 48 long. */
export const isMember = (x: unknown): x is string => typeof x === 'string' && MEMBER.test(x);
/** A public id (identity.ts). */
export const isPid = (x: unknown): x is string => typeof x === 'string' && PID.test(x);

export function regFrom<T>(raw: unknown, ok: (v: unknown) => v is T): Reg<T> | null {
  return isObj(raw) && isStamp(raw.t) && ok(raw.val) ? { val: raw.val, t: raw.t } : null;
}

export function gsetFrom(raw: unknown): GSet {
  if (!isObj(raw)) return {};
  const ok = Object.entries(raw).filter((e): e is [string, Stamp] => isMember(e[0]) && isStamp(e[1]));
  return gsetMerge({}, Object.fromEntries(ok.slice(0, MAX_MEMBERS)));
}

export function regsFrom<T>(raw: unknown, ok: (v: unknown) => v is T): Regs<T> {
  if (!isObj(raw)) return {};
  const out: Record<string, Reg<T>> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_MEMBERS)) { const r = regFrom(v, ok); if (isMember(k) && r) out[k] = r; }
  return regsMerge({}, out);
}

/** A win's author is kept only when it is a public id. */
export function winFrom(raw: unknown): Win | null {
  if (!isObj(raw) || !isStamp(raw.at)) return null;
  return isPid(raw.by) ? { at: raw.at, by: raw.by } : { at: raw.at };
}

export function winsFrom(raw: unknown): Wins {
  if (!isObj(raw)) return {};
  const out: Record<string, Win> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_MEMBERS)) { const w = winFrom(v); if (isMember(k) && w) out[k] = w; }
  return winsMerge({}, out);
}
