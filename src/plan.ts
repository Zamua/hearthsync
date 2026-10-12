import { ACCOUNT_KEY, DOC, FORWARD_KEY, accountDoc, accountFrom, forwardFrom, isNewer, mergeAccount } from './account.js';
import { canon, hash } from './crdt.js';
import type { Model, Snapshot } from './model.js';
import { docOf, docsOf, isLive, kindOf, mergeRecords, recordsIn, stampOf, tombstoneOf, versionOf, type MergeMode, type Records } from './records.js';
import type { LocalStore } from './store.js';

// Sync as data: what each room should hold (the projection), what the server has not confirmed (the derived outbox),
// and one round's merge of a read into the store (the plan). The engine only fetches, PUTs and acknowledges.

export interface Put { room: string; key: string; value: unknown; hash: string }

export interface Plan<R> {
  store: LocalStore<R>;
  puts: Put[];
  /** The app's keys whose records the read changed: another device's progress. */
  news: string[];
  /** The room is retired and names its successor: upload nothing to it, follow this. */
  forward: string | null;
  /** Keys holding a newer build's docs, left alone. */
  newer: string[];
}

/** The account room as this device would have it. */
export function accountDocs<R>(m: Model<R>, s: LocalStore<R>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.profile) out[ACCOUNT_KEY] = accountDoc(s.profile);
  return Object.assign(out, docsOf(m, s.records));
}

export function roomDocs<R>(m: Model<R>, s: LocalStore<R>, room: string): Record<string, unknown> {
  return room === s.account ? accountDocs(m, s) : {};
}

/** The ack of a key holding a newer build's doc: this build must not overwrite it, so it counts as saved. */
export const NEWER = 'newer';

const clean = <R>(s: LocalStore<R>, room: string, key: string, doc: unknown): boolean => {
  const ack = s.acks[room]?.[key];
  return ack !== undefined && (ack === NEWER || ack === hash(doc));
};

/** Rooms to sync: the account's, once it has one. */
export const roomsOf = <R>(s: LocalStore<R>): string[] => (s.account ? [s.account] : []);

/** Every doc the server has not confirmed holding, in rooms that exist. */
export function dirty<R>(m: Model<R>, s: LocalStore<R>): Put[] {
  const out: Put[] = [];
  for (const room of roomsOf(s)) for (const [key, doc] of Object.entries(roomDocs(m, s, room))) if (!clean(s, room, key, doc)) out.push({ room, key, value: doc, hash: hash(doc) });
  return out;
}

/** A doc of a later format than this build writes: the manifest and forward have the library's, the rest the app's. */
const newerDoc = <R>(m: Model<R>, key: string, raw: unknown): boolean => isNewer(raw, key === ACCOUNT_KEY || key === FORWARD_KEY ? DOC : versionOf(m));

/**
 * A room's records merged in. A key this device purged is not taken back unless a use made after its tombstone
 * revived it.
 */
function mergeIn<R>(m: Model<R>, s: LocalStore<R>, snapshot: Snapshot, mode: MergeMode): LocalStore<R> {
  const incoming: Record<string, R> = {}, purge: Record<string, number> = { ...s.purge };
  for (const [key, r] of Object.entries(recordsIn(m, snapshot))) {
    if (Object.hasOwn(purge, key)) {
      const used = kindOf(m, key)?.life?.(r).used ?? 0;
      if (used <= purge[key]!) continue;
      delete purge[key];
    }
    incoming[key] = r;
  }
  const records = mergeRecords(m, s.records, incoming, mode), revived = Object.keys(purge).length !== Object.keys(s.purge).length;
  if (records === s.records && !revived) return s;
  return { ...s, clock: Math.max(s.clock, stampOf(m, records)), records, purge: revived ? purge : s.purge };
}

/**
 * Tombstones the server held (their ack is of this very doc) and no longer holds: another device purged them, so they
 * are dropped here too rather than uploaded again.
 */
function purgedThere<R>(m: Model<R>, s: LocalStore<R>, room: string, read: Snapshot, inScope: (k: string) => boolean): LocalStore<R> {
  const acks = s.acks[room] ?? {};
  let records = s.records;
  for (const [key, r] of Object.entries(s.records)) {
    if (!tombstoneOf(m, key, r) || !inScope(key) || key in read || acks[key] !== hash(docOf(m, key, r))) continue;
    const { [key]: _, ...rest } = records;
    records = rest;
  }
  return records === s.records ? s : { ...s, records };
}

/** The account room's records merged in. Its manifest and forward are not. */
export const absorbAccount = <R>(m: Model<R>, s: LocalStore<R>, snapshot: Snapshot): LocalStore<R> => mergeIn(m, s, snapshot, 'absorb');

/**
 * This device joins an account (a code typed, or a forward followed). Its records merge in, but where the account
 * holds another playthrough, the account's wins whole; the device's own stays behind in the room it came from.
 */
export const joinAccount = <R>(m: Model<R>, s: LocalStore<R>, snapshot: Snapshot): LocalStore<R> => mergeIn(m, s, snapshot, 'join');

/** Another account merged into this one: its records come in, but where this account holds another playthrough, it stays. */
export const takeIn = <R>(m: Model<R>, s: LocalStore<R>, snapshot: Snapshot): LocalStore<R> => mergeIn(m, s, snapshot, 'takeIn');

/** The keys of b whose records differ from a's. */
export function changed<R>(a: Records<R>, b: Records<R>): string[] {
  return Object.keys(b).filter(k => a[k] !== b[k] && canon(a[k]) !== canon(b[k])).sort();
}

/**
 * One round for one room: merge what was read into the store, then list what to PUT. remote is the room's scan; with
 * keys, only those keys were read, and a key missing from remote is absent on the server. A key an earlier build wrote
 * is taken in only when it changed since it was last seen there (its ack), so a record deleted since does not come
 * back from it. Pure and idempotent: planning twice against the same read changes nothing more.
 */
export function plan<R>(m: Model<R>, s: LocalStore<R>, room: string, remote: Snapshot, keys?: readonly string[]): Plan<R> {
  const inScope = (k: string) => !keys || keys.includes(k);
  const read: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(remote)) if (inScope(k)) read[k] = v;
  const newer = Object.keys(read).filter(k => newerDoc(m, k, read[k]));
  const legacy = Object.keys(read).filter(k => kindOf(m, k)?.home);
  let next = s, forward: string | null = null;

  if (room === s.account) {
    const fresh: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(read)) if (!legacy.includes(k) || s.acks[room]?.[k] !== hash(v)) fresh[k] = v;
    next = absorbAccount(m, purgedThere(m, s, room, read, inScope), fresh);
    const a = newer.includes(ACCOUNT_KEY) ? null : accountFrom(read[ACCOUNT_KEY]);
    if (a) next = { ...next, profile: next.profile ? mergeAccount(next.profile, a) : a };
    const f = newer.includes(FORWARD_KEY) ? null : forwardFrom(read[FORWARD_KEY]);
    if (f && f.to !== room) forward = f.to;
  }

  const clock = Math.max(next.clock, stampOf(m, next.records));

  const acks: Record<string, string> = { ...(next.acks[room] ?? {}) }, puts: Put[] = [];
  const docs = roomDocs(m, next, room);
  for (const key of Object.keys(read)) if (!(key in docs) && !newer.includes(key)) delete acks[key];
  for (const key of Object.keys(acks)) if (inScope(key) && !(key in docs) && !(key in read)) delete acks[key];
  if (room === s.account) for (const key of legacy) acks[key] = hash(read[key]);
  if (forward === null) for (const [key, doc] of Object.entries(docs)) {
    if (!inScope(key)) continue;
    if (newer.includes(key)) { acks[key] = NEWER; continue; }
    const there = key in read;
    if (there) acks[key] = hash(read[key]); else delete acks[key];
    if (!there || canon(read[key]) !== canon(doc)) puts.push({ room, key, value: doc, hash: hash(doc) });
  }
  next = { ...next, clock, acks: { ...next.acks, [room]: acks } };

  return { store: next, puts, news: changed(s.records, next.records), forward, newer };
}

/** The server confirmed a PUT: it holds the doc with this hash (a key edited since stays dirty). */
export function acknowledge<R>(s: LocalStore<R>, room: string, key: string, h: string): LocalStore<R> {
  return { ...s, acks: { ...s.acks, [room]: { ...s.acks[room], [key]: h } } };
}

/** Phone only: never on the server. Waiting: on it, with newer changes here. Saved: the server holds exactly this. */
export type Chip = 'phone' | 'waiting' | 'saved';

export interface Chips {
  /** Each live record's, by room key. */
  items: Record<string, Chip>;
  /** How many live records are not saved. */
  unsaved: number;
}

export function chips<R>(m: Model<R>, s: LocalStore<R>): Chips {
  const acc = s.account, items: Record<string, Chip> = {};
  let unsaved = 0;
  for (const [key, doc] of Object.entries(docsOf(m, s.records))) {
    if (!isLive(m, key, s.records[key]!)) continue;
    const chip: Chip = !acc || s.acks[acc]?.[key] === undefined ? 'phone' : clean(s, acc, key, doc) ? 'saved' : 'waiting';
    items[key] = chip;
    if (chip !== 'saved') unsaved++;
  }
  return { items, unsaved };
}
