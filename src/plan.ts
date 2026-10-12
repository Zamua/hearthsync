import { ACCOUNT_KEY, DOC, FORWARD_KEY, SHARED_KEY, accountDoc, accountFrom, forwardFrom, isNewer, mergeAccount, sharedDoc, sharedFrom } from './account.js';
import { canon, hash, regsMerge } from './crdt.js';
import type { Model, Snapshot } from './model.js';
import { docOf, docsOf, isLive, kindOf, mergeRecords, ownsRoom, recordsIn, stampOf, tombstoneOf, versionOf, type MergeMode, type Records } from './records.js';
import { sharedStamp, type LocalStore } from './store.js';

// Sync as data: what each room should hold (the projection), what the server has not confirmed (the derived outbox),
// and one round's merge of a read into the store (the plan). The engine only fetches, PUTs and acknowledges. Rooms are
// the account's, and one per shared record: it holds that record's doc, as the account room does.

export interface Put { room: string; key: string; value: unknown; hash: string }

export interface Plan<R, A = undefined> {
  store: LocalStore<R, A>;
  puts: Put[];
  /** The app's keys whose records the read changed: another device's progress. */
  news: string[];
  /** The room is retired and names its successor: upload nothing to it, follow this. */
  forward: string | null;
  /** Keys holding a newer build's docs, left alone. */
  newer: string[];
}

/** The account room as this device would have it. */
export function accountDocs<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.profile) out[ACCOUNT_KEY] = accountDoc(s.profile);
  if (Object.keys(s.shared).length) out[SHARED_KEY] = sharedDoc(s.shared);
  return Object.assign(out, docsOf(m, s.records));
}

/** A shared room as this device would have it: the docs of the records living there. */
function sharedDocs<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, room: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, reg] of Object.entries(s.shared)) {
    const r = s.records[key];
    if (reg.val === room && r !== undefined && ownsRoom(m, key)) out[key] = docOf(m, key, r);
  }
  return out;
}

export function roomDocs<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, room: string): Record<string, unknown> {
  return room === s.account ? accountDocs(m, s) : sharedDocs(m, s, room);
}

/** The ack of a key holding a newer build's doc: this build must not overwrite it, so it counts as saved. */
export const NEWER = 'newer';

const clean = <R, A>(s: LocalStore<R, A>, room: string, key: string, doc: unknown): boolean => {
  const ack = s.acks[room]?.[key];
  return ack !== undefined && (ack === NEWER || ack === hash(doc));
};

/**
 * Rooms to sync: the account's, once it has one, then each shared record's while it is live (or its tombstone has not
 * reached its room yet).
 */
export function roomsOf<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>): string[] {
  const out = new Set(s.account ? [s.account] : []);
  for (const [key, { val: room }] of Object.entries(s.shared)) {
    const r = s.records[key];
    if (r === undefined || out.has(room) || !ownsRoom(m, key)) continue;
    if (isLive(m, key, r) || !clean(s, room, key, docOf(m, key, r))) out.add(room);
  }
  return [...out];
}

/** Every doc the server has not confirmed holding, in rooms that exist. */
export function dirty<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>): Put[] {
  const out: Put[] = [];
  for (const room of roomsOf(m, s)) for (const [key, doc] of Object.entries(roomDocs(m, s, room))) if (!clean(s, room, key, doc)) out.push({ room, key, value: doc, hash: hash(doc) });
  return out;
}

/** A doc of a later format than this build writes: the manifest and forward have the library's, the rest the app's. */
const newerDoc = <R, A>(m: Model<R, unknown>, key: string, raw: unknown): boolean => isNewer(raw, key === ACCOUNT_KEY || key === SHARED_KEY || key === FORWARD_KEY ? DOC : versionOf(m));

/**
 * A room's records, and the rooms of its shared ones, merged in. A key this device purged is not taken back unless a
 * use made after its tombstone revived it.
 */
function mergeIn<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, snapshot: Snapshot, mode: MergeMode): LocalStore<R, A> {
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
  const read = sharedFrom(snapshot[SHARED_KEY], k => ownsRoom(m, k)), shared = Object.keys(read).length ? regsMerge(s.shared, read) : s.shared;
  const moved = shared !== s.shared && canon(shared) !== canon(s.shared);
  if (records === s.records && !revived && !moved) return s;
  const clock = Math.max(s.clock, stampOf(m, records), sharedStamp(shared));
  return { ...s, clock, records, purge: revived ? purge : s.purge, shared: moved ? shared : s.shared };
}

/**
 * Tombstones the server held (their ack is of this very doc) and no longer holds: another device purged them, so they
 * are dropped here too rather than uploaded again.
 */
function purgedThere<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, room: string, read: Snapshot, inScope: (k: string) => boolean): LocalStore<R, A> {
  const acks = s.acks[room] ?? {};
  let records = s.records;
  for (const [key, r] of Object.entries(s.records)) {
    if (!tombstoneOf(m, key, r) || !inScope(key) || key in read || acks[key] !== hash(docOf(m, key, r))) continue;
    const { [key]: _, ...rest } = records;
    records = rest;
  }
  return records === s.records ? s : { ...s, records };
}

/** The account room's records and shared rooms merged in. Its manifest and forward are not. */
export const absorbAccount = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, snapshot: Snapshot): LocalStore<R, A> => mergeIn(m, s, snapshot, 'absorb');

/**
 * This device joins an account (a code typed, or a forward followed). Its records merge in, but where the account
 * holds another playthrough, the account's wins whole; the device's own stays behind in the room it came from.
 */
export const joinAccount = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, snapshot: Snapshot): LocalStore<R, A> => mergeIn(m, s, snapshot, 'join');

/** Another account merged into this one: its records come in, but where this account holds another playthrough, it stays. */
export const takeIn = <R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, snapshot: Snapshot): LocalStore<R, A> => mergeIn(m, s, snapshot, 'takeIn');

/** The keys of b whose records differ from a's. */
export function changed<R>(a: Records<R>, b: Records<R>): string[] {
  return Object.keys(b).filter(k => a[k] !== b[k] && canon(a[k]) !== canon(b[k])).sort();
}

/**
 * One round for one room: merge what was read into the store, then list what to PUT. remote is the room's scan; with
 * keys, only those keys were read, and a key missing from remote is absent on the server. A key an earlier build wrote
 * is taken in only when it changed since it was last seen there (its ack), so a record deleted since does not come
 * back from it. From a shared room, only the records living there are taken. Pure and idempotent: planning twice
 * against the same read changes nothing more.
 */
export function plan<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>, room: string, remote: Snapshot, keys?: readonly string[]): Plan<R, A> {
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
  } else {
    const here: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(read)) if (s.shared[k]?.val === room) here[k] = v;
    next = mergeIn(m, s, here, 'absorb');
  }
  const f = newer.includes(FORWARD_KEY) ? null : forwardFrom(read[FORWARD_KEY]);
  if (f && f.to !== room) forward = f.to;

  const clock = Math.max(next.clock, stampOf(m, next.records), sharedStamp(next.shared));

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
export function acknowledge<R, A>(s: LocalStore<R, A>, room: string, key: string, h: string): LocalStore<R, A> {
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

export function chips<R, A>(m: Model<R, unknown>, s: LocalStore<R, A>): Chips {
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
