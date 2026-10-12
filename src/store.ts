import type { AccountDoc } from './account.js';
import { isRoomId } from './code.js';
import { canon, tick, type Stamp } from './crdt.js';
import { publicId } from './identity.js';
import { samePlay, type Model, type Playthrough } from './model.js';
import { kindOf, mergeRecords, stampOf, type Records } from './records.js';

// This device's copy of the account: the only thing the app reads, written before any network call. Every edit takes
// the wall clock (plus server skew) and stamps through the store's clock.

/** Per room and key: the hash of the doc the server was last seen holding. */
export type Acks = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface LocalStore<R> {
  /** The account room, once the server has made it (or a code was entered). No code until then. */
  account: string | null;
  profile: AccountDoc | null;
  /** The highest stamp made or seen. */
  clock: Stamp;
  /** The app's records, by room key. */
  records: Records<R>;
  acks: Acks;
  /** Account rooms this device left, each owed a forward to the current account once everything is uploaded there. */
  forwards: Readonly<Record<string, string>>;
}

export const emptyStore = <R>(): LocalStore<R> => ({ account: null, profile: null, clock: 0, records: {}, acks: {}, forwards: {} });

/** An edit of the records, given the next stamp; the store itself when f hands them back unchanged. */
export function editRecords<R>(s: LocalStore<R>, now: number, f: (records: Records<R>, t: Stamp) => Records<R>): LocalStore<R> {
  const t = tick(s.clock, now), records = f(s.records, t);
  return records === s.records ? s : { ...s, clock: t, records };
}

/** Whether a session playing `play` at key has been overtaken: the store holds another playthrough there now. */
export function moved<R>(m: Model<R>, s: LocalStore<R>, key: string, play: Playthrough): boolean {
  const held = s.records[key], k = kindOf(m, key);
  return held !== undefined && !!k?.play && !samePlay(k.play(held), play);
}

/** saved: the store took it; same: nothing changed; moved: refused, the store holds another playthrough there. */
export type PutResult = 'saved' | 'same' | 'moved';

/**
 * A save of the record at key. f gets the record held (null if none) and the stamp to put on what it changes, and
 * hands back the record, or the one held when nothing changed. With play, a session's save of a playthrough the store
 * no longer holds (one linked or followed in, or a new game begun elsewhere) is refused, never merged: its own merge
 * order might otherwise bring the old playthrough back.
 */
export function putRecord<R>(
  m: Model<R>, s: LocalStore<R>, key: string, now: number, f: (held: R | null, t: Stamp) => R, play?: Playthrough,
): { store: LocalStore<R>; result: PutResult } {
  if (!kindOf(m, key)) throw new Error(`not a key of this model: ${key}`);
  if (play && moved(m, s, key, play)) return { store: s, result: 'moved' };
  const held = s.records[key] ?? null, t = tick(s.clock, now), next = f(held, t);
  if (next === held) return { store: s, result: 'same' };
  return { store: { ...s, clock: t, records: { ...s.records, [key]: next } }, result: 'saved' };
}

/**
 * Records from outside the account (kept before sync), merged in as another account's would be: a record of another
 * playthrough than the one held stays out.
 */
export function importRecords<R>(m: Model<R>, s: LocalStore<R>, incoming: Records<R>): LocalStore<R> {
  const records = mergeRecords(m, s.records, incoming, 'takeIn');
  return records === s.records || canon(records) === canon(s.records) ? s : { ...s, clock: Math.max(s.clock, stampOf(m, incoming)), records };
}

/** The account room the server just made for this device; a no-op if another tab adopted one first. */
export function adoptAccount<R>(s: LocalStore<R>, room: string, now: number, salt: string): LocalStore<R> {
  if (s.account || !isRoomId(room)) return s;
  const t = tick(s.clock, now);
  return { ...s, account: room, profile: { pid: publicId(room, salt), made: t }, clock: t };
}

/**
 * This device moves to another account (a code typed, or a forward followed). The room it leaves is returned, to
 * receive a forward once the upload there is done. The target's own manifest wins on the first scan, being older.
 */
export function switchAccount<R>(s: LocalStore<R>, room: string, now: number, salt: string): { store: LocalStore<R>; previous: string | null } {
  if (s.account === room || !isRoomId(room)) return { store: s, previous: null };
  const t = tick(s.clock, now);
  return { store: { ...s, account: room, profile: { pid: publicId(room, salt), made: t }, clock: t }, previous: s.account };
}

/** The account room `from` is owed a forward to this device's account, written once everything is uploaded there. */
export const queueForward = <R>(s: LocalStore<R>, from: string): LocalStore<R> =>
  !s.account || from === s.account || s.forwards[from] === s.account ? s : { ...s, forwards: { ...s.forwards, [from]: s.account } };

export function forwardDone<R>(s: LocalStore<R>, from: string): LocalStore<R> {
  if (!Object.hasOwn(s.forwards, from)) return s;
  const { [from]: _, ...forwards } = s.forwards;
  return { ...s, forwards };
}
