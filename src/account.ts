import { isRoomId } from './code.js';
import { isStamp, regsMerge, type Reg, type Regs, type Stamp } from './crdt.js';
import { MAX_MEMBERS, isObj, isPid, regFrom } from './repair.js';

// The docs an account room holds besides the app's: its manifest, the rooms its shared records live in, and on a
// retired room (an account's or a shared record's), where it lives now. Every synced doc carries its format as `v`.

/** Room keys of the manifest, the shared rooms and the forward, never an app's. */
export const ACCOUNT_KEY = 'account', SHARED_KEY = 'shared', FORWARD_KEY = 'forward';

/** The format of the manifest and forwards, and the default of an app's docs. */
export const DOC = 1;

/** A doc of a later format than `version`: a newer build's, never absorbed, never overwritten. */
export const isNewer = (raw: unknown, version = DOC): boolean => isObj(raw) && typeof raw.v === 'number' && raw.v > version;

/** The account manifest: its public id, and when it was made. */
export interface AccountDoc { pid: string; made: Stamp }
/** On a retired room: where its account lives now. */
export interface ForwardDoc { to: string; at: Stamp }

export function accountFrom(raw: unknown): AccountDoc | null {
  return isObj(raw) && isPid(raw.pid) && isStamp(raw.made) ? { pid: raw.pid, made: raw.made } : null;
}

export function forwardFrom(raw: unknown): ForwardDoc | null {
  return isObj(raw) && isRoomId(raw.to) && isStamp(raw.at) ? { to: raw.to, at: raw.at } : null;
}

/** The earliest manifest wins whole, so the account keeps its first public id through any change of room. */
export function mergeAccount(a: AccountDoc, b: AccountDoc): AccountDoc {
  if (a.made !== b.made) return a.made < b.made ? a : b;
  return a.pid <= b.pid ? a : b;
}

export function mergeForward(a: ForwardDoc, b: ForwardDoc): ForwardDoc {
  if (a.at !== b.at) return a.at < b.at ? a : b;
  return a.to <= b.to ? a : b;
}

/** Each shared record's room, by its key, from untrusted JSON: only keys ok passes. */
export function sharedRegs(raw: unknown, ok: (key: string) => boolean): Regs<string> {
  if (!isObj(raw)) return {};
  const out: Record<string, Reg<string>> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_MEMBERS)) { const r = regFrom(v, isRoomId); if (r && ok(k)) out[k] = r; }
  return regsMerge({}, out);
}

/** The shared rooms an account room lists; none from a newer build's doc. */
export const sharedFrom = (raw: unknown, ok: (key: string) => boolean): Regs<string> =>
  isObj(raw) && !isNewer(raw) ? sharedRegs(raw.rooms, ok) : {};

export const accountDoc = (a: AccountDoc) => ({ v: DOC, ...a });
export const forwardDoc = (to: string, at: Stamp) => ({ v: DOC, to, at });
export const sharedDoc = (rooms: Regs<string>) => ({ v: DOC, rooms });
