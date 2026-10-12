import type { AccountDoc } from './account.js';
import { isRoomId } from './code.js';
import { UNTIMED, canon, tick, type Stamp } from './crdt.js';
import { publicId } from './identity.js';
import { samePlay, type Kind, type Model, type Playthrough } from './model.js';
import { homeKind, kindOf, mergeRecords, stampOf, tombstoneOf, type Records } from './records.js';

// This device's copy of the account: the only thing the app reads, written before any network call. Every edit takes
// the wall clock (plus server skew) and stamps through the store's clock.

/** Per room and key: the hash of the doc the server was last seen holding. */
export type Acks = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface LocalStore<R, A = undefined> {
  /** The account room, once the server has made it (or a code was entered). No code until then. */
  account: string | null;
  profile: AccountDoc | null;
  /** The highest stamp made or seen. */
  clock: Stamp;
  /** The app's records by room key, tombstones among them until purged. */
  records: Records<R>;
  acks: Acks;
  /** Account rooms this device left, each owed a forward to the current account once everything is uploaded there. */
  forwards: Readonly<Record<string, string>>;
  /** Keys of purged records to delete from the account room, each with the tombstone's stamp. */
  purge: Readonly<Record<string, Stamp>>;
  /** The app's own state, kept in the meta (`Model.meta`). */
  app: A;
}

/** A store with nothing in it yet; app is the app's starting state (its meta hook's read of `{}`). */
export const emptyStore = <R, A = undefined>(app: A = undefined as A): LocalStore<R, A> =>
  ({ account: null, profile: null, clock: 0, records: {}, acks: {}, forwards: {}, purge: {}, app });

/** An edit of the records, given the next stamp; the store itself when f hands them back unchanged. */
export function editRecords<R, A>(s: LocalStore<R, A>, now: number, f: (records: Records<R>, t: Stamp) => Records<R>): LocalStore<R, A> {
  const t = tick(s.clock, now), records = f(s.records, t);
  return records === s.records ? s : { ...s, clock: t, records };
}

/** Whether a session playing `play` at key has been overtaken: the store holds another playthrough there now. */
export function moved<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string, play: Playthrough): boolean {
  const held = s.records[key], k = kindOf(m, key);
  return held !== undefined && !!k?.play && !samePlay(k.play(held), play);
}

const count = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, k: Kind<R>): number => Object.keys(s.records).filter(key => kindOf(m, key) === k).length;

/** Whether a new record fits at key: under its kind's cap, or a tombstone of that kind can make way. */
export function roomFor<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string): boolean {
  const k = homeKind(m, key);
  if (!k) return false;
  return k.cap === undefined || key in s.records || count(m, s, k) < k.cap || oldestTombstone(m, s, x => kindOf(m, x) === k) !== null;
}

/** The key of the oldest tombstone, among the keys `allow` passes. */
export function oldestTombstone<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, allow: (key: string) => boolean = () => true): string | null {
  let best: { key: string; at: Stamp } | null = null;
  for (const [key, r] of Object.entries(s.records)) {
    const at = tombstoneOf(m, key, r);
    if (at > 0 && allow(key) && (!best || at < best.at || (at === best.at && key < best.key))) best = { key, at };
  }
  return best?.key ?? null;
}

/**
 * A tombstone dropped for good. If the account room may hold it (it was acknowledged there), its key is listed for
 * deletion; the stamp lets a later use elsewhere still revive it.
 */
export function purgeRecord<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string): LocalStore<R, A> {
  const r = s.records[key];
  if (r === undefined || !tombstoneOf(m, key, r)) return s;
  const { [key]: _, ...records } = s.records;
  const acc = s.account, acks = acc ? s.acks[acc] ?? {} : {}, held = acc !== null && Object.hasOwn(acks, key);
  const { [key]: __, ...keep } = acks;
  return { ...s, records, ...(held ? { purge: { ...s.purge, [key]: tombstoneOf(m, key, r) }, acks: { ...s.acks, [acc]: keep } } : {}) };
}

/** The purged key is gone from the account room. */
export function purgeDone<R, A>(s: LocalStore<R, A>, key: string): LocalStore<R, A> {
  if (!Object.hasOwn(s.purge, key)) return s;
  const { [key]: _, ...purge } = s.purge;
  return { ...s, purge };
}

/** Tombstones older than the model's purgeAfter, purged. One without a time waits until a slot is needed. */
export function expire<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, now: number): LocalStore<R, A> {
  if (m.purgeAfter === undefined) return s;
  let out = s;
  for (const [key, r] of Object.entries(s.records)) {
    const at = tombstoneOf(m, key, r);
    if (at > UNTIMED && now - at >= m.purgeAfter) out = purgeRecord(m, out, key);
  }
  return out;
}

/** saved: the store took it; same: nothing changed; moved: refused, the store holds another playthrough there; full: refused, at its kind's cap. */
export type PutResult = 'saved' | 'same' | 'moved' | 'full';

/**
 * A save of the record at key. f gets the record held (null if none) and the stamp to put on what it changes, and
 * hands back the record, or the one held when nothing changed. A new record past its kind's cap first purges the
 * oldest tombstone of that kind, and is refused when there is none. With play, a session's save of a playthrough the
 * store no longer holds (one linked or followed in, or a new game begun elsewhere) is refused, never merged: its own
 * merge order might otherwise bring the old playthrough back.
 */
export function putRecord<R, A>(
  m: Model<R, unknown>, s: LocalStore<R, A>, key: string, now: number, f: (held: R | null, t: Stamp) => R, play?: Playthrough,
): { store: LocalStore<R, A>; result: PutResult } {
  const k = homeKind(m, key);
  if (!k) throw new Error(`not a key of this model: ${key}`);
  if (play && moved(m, s, key, play)) return { store: s, result: 'moved' };
  const held = s.records[key] ?? null;
  let base = s;
  if (held === null && k.cap !== undefined && count(m, s, k) >= k.cap) {
    const drop = oldestTombstone(m, s, x => kindOf(m, x) === k);
    if (!drop) return { store: s, result: 'full' };
    base = purgeRecord(m, s, drop);
  }
  const t = tick(base.clock, now), next = f(held, t);
  if (next === held) return { store: s, result: 'same' };
  return { store: { ...base, clock: t, records: { ...base.records, [key]: next } }, result: 'saved' };
}

/**
 * Records from outside the account (kept before sync), merged in as another account's would be: a record of another
 * playthrough than the one held stays out.
 */
export function importRecords<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, incoming: Records<R>): LocalStore<R, A> {
  const records = mergeRecords(m, s.records, incoming, 'takeIn');
  return records === s.records || canon(records) === canon(s.records) ? s : { ...s, clock: Math.max(s.clock, stampOf(m, incoming)), records };
}

/** The account room the server just made for this device; a no-op if another tab adopted one first. */
export function adoptAccount<R, A>(s: LocalStore<R, A>, room: string, now: number, salt: string): LocalStore<R, A> {
  if (s.account || !isRoomId(room)) return s;
  const t = tick(s.clock, now);
  return { ...s, account: room, profile: { pid: publicId(room, salt), made: t }, clock: t };
}

/**
 * This device moves to another account (a code typed, or a forward followed). The room it leaves is returned, to
 * receive a forward once the upload there is done. The target's own manifest wins on the first scan, being older.
 * Purges owed name keys of the room left behind, so they go.
 */
export function switchAccount<R, A>(s: LocalStore<R, A>, room: string, now: number, salt: string): { store: LocalStore<R, A>; previous: string | null } {
  if (s.account === room || !isRoomId(room)) return { store: s, previous: null };
  const t = tick(s.clock, now);
  return { store: { ...s, account: room, profile: { pid: publicId(room, salt), made: t }, clock: t, purge: {} }, previous: s.account };
}

/** The account room `from` is owed a forward to this device's account, written once everything is uploaded there. */
export const queueForward = <R, A>(s: LocalStore<R, A>, from: string): LocalStore<R, A> =>
  !s.account || from === s.account || s.forwards[from] === s.account ? s : { ...s, forwards: { ...s.forwards, [from]: s.account } };

export function forwardDone<R, A>(s: LocalStore<R, A>, from: string): LocalStore<R, A> {
  if (!Object.hasOwn(s.forwards, from)) return s;
  const { [from]: _, ...forwards } = s.forwards;
  return { ...s, forwards };
}
