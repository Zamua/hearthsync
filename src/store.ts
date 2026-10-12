import { ACCOUNT_KEY, LEFT, type AccountDoc } from './account.js';
import { isRoomId } from './code.js';
import { UNTIMED, canon, regsMerge, tick, type Reg, type Regs, type Stamp } from './crdt.js';
import { publicId } from './identity.js';
import { samePlay, type Kind, type Model, type Playthrough, type Snapshot } from './model.js';
import { homeKind, isLive, keepsRegister, kindOf, mergeRecords, ownsRoom, recordRoom, recordsIn, roomRecord, stampOf, tombstoneOf, type Records } from './records.js';

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
  /**
   * Rooms this device left, each owed a forward once everything is uploaded where it leads: an account room to the
   * current account, a shared room to the room its record moved to (named here).
   */
  forwards: Readonly<Record<string, string>>;
  /** Keys of purged records to delete from the account room, each with the tombstone's stamp. */
  purge: Readonly<Record<string, Stamp>>;
  /** The app's own state, kept in the meta (`Model.meta`). */
  app: A;
  /**
   * The room each shared record lives in, by its key, or LEFT once this account left it: the last move wins. Kinds
   * keeping the register in the record (`Kind.register`) are not here.
   */
  shared: Regs<string>;
}

/** A store with nothing in it yet; app is the app's starting state (its meta hook's read of `{}`). */
export const emptyStore = <R, A = undefined>(app: A = undefined as A): LocalStore<R, A> =>
  ({ account: null, profile: null, clock: 0, records: {}, acks: {}, forwards: {}, purge: {}, shared: {}, app });

/** The highest stamp of the shared rooms' registers. */
export const sharedStamp = (shared: Regs<string>): Stamp => Math.max(0, ...Object.values(shared).map(r => r.t));

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
 * A tombstone dropped for good, with the room it was shared in. If the account room may hold it (it was acknowledged
 * there), its key is listed for deletion; the stamp lets a later use elsewhere still revive it.
 */
export function purgeRecord<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string): LocalStore<R, A> {
  const r = s.records[key];
  if (r === undefined || !tombstoneOf(m, key, r)) return s;
  const { [key]: _, ...records } = s.records;
  const acc = s.account, acks = acc ? s.acks[acc] ?? {} : {}, held = acc !== null && Object.hasOwn(acks, key);
  const { [key]: __, ...keep } = acks, { [key]: ___, ...shared } = s.shared;
  return {
    ...s, records, shared: key in s.shared ? shared : s.shared,
    ...(held ? { purge: { ...s.purge, [key]: tombstoneOf(m, key, r) }, acks: { ...s.acks, [acc]: keep } } : {}),
  };
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

/**
 * Every shared record's room register, by key: the store's `shared`, and those kept inside records (`Kind.register`).
 * A register holding LEFT is a record this account stopped sharing.
 */
export function placed<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>): Regs<string> {
  let out: Record<string, Reg<string>> | null = null;
  for (const [key, r] of Object.entries(s.records)) {
    const reg = keepsRegister(m, key) ? recordRoom(m, key, r) : undefined;
    if (reg) (out ??= { ...s.shared })[key] = reg;
  }
  return out ?? s.shared;
}

/** The room the record at key syncs with: none when it is not shared, or this account left it. */
export function roomOf<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string): string | null {
  const r = s.records[key];
  if (r === undefined || !ownsRoom(m, key)) return null;
  const reg = keepsRegister(m, key) ? recordRoom(m, key, r) : s.shared[key];
  return reg && reg.val !== LEFT ? reg.val : null;
}

/** Keys moved to a room (or LEFT) at the next stamp; s itself when none moves. */
function moveTo<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, keys: readonly string[], room: string, now: number): LocalStore<R, A> {
  const at = placed(m, s), move = keys.filter(k => at[k]?.val !== room);
  if (!move.length || (room !== LEFT && !isRoomId(room))) return s;
  const t = tick(s.clock, now), reg = { val: room, t }, records: Record<string, R> = { ...s.records }, shared: Record<string, Reg<string>> = {};
  for (const k of move) {
    const r = records[k];
    if (keepsRegister(m, k)) { if (r !== undefined) records[k] = homeKind(m, k)!.register!.set(r, reg); } else shared[k] = reg;
  }
  return { ...s, clock: t, records, shared: Object.keys(shared).length ? regsMerge(s.shared, shared) : s.shared };
}

/** The record at key lives in this room now (just made by POST). */
export const shareRecord = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string, room: string, now: number): LocalStore<R, A> =>
  ownsRoom(m, key) && s.records[key] !== undefined ? moveTo(m, s, [key], room, now) : s;

/**
 * This account stops sharing the record at key: it stays, live, in the account room alone, and its room is left to
 * its other members. Sharing it again makes a new room; joining the old one again moves it back.
 */
export const leaveRoom = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, key: string, now: number): LocalStore<R, A> =>
  roomOf(m, s, key) === null ? s : moveTo(m, s, [key], LEFT, now);

/** Records of a retired room move to the room it forwards to. */
export function followRoom<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, from: string, to: string, now: number): LocalStore<R, A> {
  const at = placed(m, s);
  return moveTo(m, s, Object.keys(at).filter(k => at[k]!.val === from), to, now);
}

/**
 * The live shared record a room holds: its key (the smallest, should it hold several); null for none, and for an
 * account room, which holds a manifest or records of the account's own. A room laid out by a kind's layout is found
 * through the model's roomKey.
 */
export function sharedKey<R>(m: Model<R, unknown>, snapshot: Snapshot, room?: string): string | null {
  if (ACCOUNT_KEY in snapshot) return null;
  const laid = room !== undefined ? m.roomKey?.(snapshot, room) ?? null : null;
  if (laid !== null) {
    const k = homeKind(m, laid), r = k?.layout && k.room === 'own' ? roomRecord(m, snapshot, laid) : null;
    if (r !== null && isLive(m, laid, r)) return laid;
  }
  if (Object.keys(snapshot).some(k => kindOf(m, k) !== null && !ownsRoom(m, k))) return null;
  const records = recordsIn(m, snapshot);
  return Object.keys(records).filter(k => ownsRoom(m, k) && !homeKind(m, k)!.layout && isLive(m, k, records[k]!)).sort()[0] ?? null;
}

/**
 * Joining a shared record from its room (an invite): the room's copy merges in as another device's edit would, and the
 * record syncs with that room from now on. A key this device purged comes back, and a kind's `enter` marks the use.
 * none: the room holds no live shared record; full: a new record past its kind's cap, with no tombstone to make way.
 */
export function joinRoom<R, A>(
  m: Model<R, unknown>, s: LocalStore<R, A>, room: string, snapshot: Snapshot, now: number,
): { store: LocalStore<R, A>; key: string } | 'none' | 'full' {
  const key = sharedKey(m, snapshot, room);
  if (key === null || !isRoomId(room)) return 'none';
  let base = purgeDone(s, key);
  const k = homeKind(m, key)!;
  if (!(key in s.records) && k.cap !== undefined && count(m, s, k) >= k.cap) {
    const drop = oldestTombstone(m, s, x => kindOf(m, x) === k);
    if (!drop) return 'full';
    base = purgeRecord(m, base, drop);
  }
  let records = mergeRecords(m, base.records, { [key]: roomRecord(m, snapshot, key)! });
  if (k.enter) records = { ...records, [key]: k.enter(records[key]!, tick(Math.max(base.clock, stampOf(m, records)), now)) };
  base = { ...base, clock: Math.max(base.clock, stampOf(m, records)), records };
  return { store: moveTo(m, base, [key], room, now), key };
}
