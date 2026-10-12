import { accountFrom, isNewer } from './account.js';
import { isRoomId } from './code.js';
import { isStamp } from './crdt.js';
import type { Fold, Model } from './model.js';
import { docOf, homeKind, stampOf, versionOf } from './records.js';
import { isObj, type Obj } from './repair.js';
import { emptyStore, type LocalStore } from './store.js';

// This device's store in localStorage: one key per record, so a save writes only what changed and two tabs rarely
// clobber each other. Every change is written synchronously, before any network call, so a killed app loses nothing.

export interface Storage {
  get(key: string): string | null;
  /** Whether the value was stored: a full or refusing storage says no instead of throwing. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  keys(): string[];
}

export function memoryStorage(init: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, String(v)); return true; }, remove: k => { data.delete(k); }, keys: () => [...data.keys()] };
}

/** localStorage, or memory when it is missing or refuses (private mode): the app still works, it just forgets. */
export function browserStorage(): Storage {
  let ls: globalThis.Storage;
  try { ls = globalThis.localStorage; ls.getItem('__probe__'); } catch { return memoryStorage(); }
  if (!ls) return memoryStorage();
  return {
    get: k => { try { return ls.getItem(k); } catch { return null; } },
    set: (k, v) => { try { ls.setItem(k, v); return true; } catch { return false; } },
    remove: k => { try { ls.removeItem(k); } catch { /* refused */ } },
    keys: () => { try { return Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k): k is string => !!k); } catch { return []; } },
  };
}

/** The meta's format by default, and the oldest this reads: one above the model's is a newer build's. */
const META_V = 2;
const META = 'meta', ACKS = 'acks';
const metaV = <R>(m: Model<R>): number => m.storeVersion ?? META_V;

/** A record's name in storage: its room key with each `/` as a `.`. */
export const storageName = (key: string): string => key.replace(/\//g, '.');
const roomKey = (name: string): string => name.replace(/\./g, '/');

const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

const strings = (raw: unknown, ok: (k: string, v: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(isObj(raw) ? raw : {}).filter((e): e is [string, string] => typeof e[1] === 'string' && ok(e[0], e[1])));

const metaVersion = (raw: unknown): number | null => (isObj(raw) && typeof raw.v === 'number' ? raw.v : null);

/** Whether a newer build wrote this storage's meta: this build reads what it can of it and never writes over it. */
export const newerStore = <R>(st: Storage, m: Model<R>): boolean => (metaVersion(parse(st.get(m.prefix + META))) ?? 0) > metaV(m);

/**
 * The store, or null when this device has none yet. Records are read even without a meta (a write cut short, or
 * storage that filled up): each stands alone, and a missing meta only means no account yet. A newer build's meta is
 * read like this one's, its fields checked the same way; a newer build's records are left out.
 */
export function readStore<R>(st: Storage, m: Model<R>): LocalStore<R> | null {
  const raw = parse(st.get(m.prefix + META));
  if (raw !== null && (metaVersion(raw) ?? 0) < META_V) return null;
  const meta: Obj = isObj(raw) ? raw : {}, skip = new Set([META, ACKS, ...(m.folds ?? []).map(f => f.mark)]);
  const records: Record<string, R> = {};
  for (const full of st.keys()) {
    if (!full.startsWith(m.prefix)) continue;
    const name = full.slice(m.prefix.length), key = roomKey(name), kind = skip.has(name) ? null : homeKind(m, key);
    if (!kind) continue;
    const doc = parse(st.get(full)), r = isNewer(doc, versionOf(m)) ? null : kind.from(doc, key);
    if (r !== null) records[key] = r;
  }
  if (raw === null && !Object.keys(records).length) return null;
  const acks: Record<string, Record<string, string>> = {}, rawAcks = parse(st.get(m.prefix + ACKS));
  if (isObj(rawAcks)) for (const [room, keys] of Object.entries(rawAcks)) {
    if (!isRoomId(room) || !isObj(keys)) continue;
    acks[room] = Object.fromEntries(Object.entries(keys).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return {
    ...emptyStore<R>(),
    account: isRoomId(meta.account) ? meta.account : null,
    profile: accountFrom(meta.profile),
    // The clock must pass every stamp held, whatever the meta says.
    clock: Math.max(isStamp(meta.clock) ? meta.clock : 0, stampOf(m, records)),
    records, acks,
    forwards: strings(meta.forwards, (k, v) => isRoomId(k) && isRoomId(v)),
    purge: Object.fromEntries(Object.entries(isObj(meta.purge) ? meta.purge : {}).filter((e): e is [string, number] => homeKind(m, e[0]) !== null && isStamp(e[1]))),
  };
}

type Entry = [key: string, obj: unknown, doc: () => unknown];

/**
 * Writes what changed since the last write: records by identity first, then by their text. A record it wrote that has
 * left the store has its key removed, or the next boot would read it back and upload it again.
 */
export class Persist<R> {
  private written = new Map<string, { obj: unknown; json: string }>();
  constructor(private st: Storage, private m: Model<R>) {}

  /** Forget what was written: storage may have been changed by another tab. */
  reset(): void { this.written.clear(); }

  /** Whether another writer changed storage since: every edit moves the meta (its clock) or the acks. */
  stale(): boolean {
    return [META, ACKS].some(n => this.st.get(this.m.prefix + n) !== (this.written.get(this.m.prefix + n)?.json ?? null));
  }

  /** The meta goes last, so a meta read back means the records before it were written, and dropped ones removed. */
  write(s: LocalStore<R>): void {
    const entries = this.entries(s), held = new Set(entries.map(([key]) => key));
    for (const [key, obj, doc] of entries) {
      if (key === this.m.prefix + ACKS) this.drop(held);
      this.put(key, obj, doc);
    }
  }

  /** Whether storage holds all of s as write() would put it, and none of the records it wrote that s no longer has. */
  verify(s: LocalStore<R>): boolean {
    const entries = this.entries(s), held = new Set(entries.map(([key]) => key));
    return entries.every(([key, , doc]) => this.st.get(key) === JSON.stringify(doc())) && [...this.written.keys()].every(k => held.has(k) || this.st.get(k) === null);
  }

  /** Records written here and no longer held: removed, and forgotten only once they read back gone, so a refusal is tried again. */
  private drop(held: ReadonlySet<string>): void {
    for (const key of this.written.keys()) {
      if (held.has(key)) continue;
      this.st.remove(key);
      if (this.st.get(key) === null) this.written.delete(key);
    }
  }

  /** Each key with the object it holds (unchanged objects are skipped by identity) and its doc. */
  private entries(s: LocalStore<R>): Entry[] {
    const p = this.m.prefix, meta = { v: metaV(this.m), account: s.account, profile: s.profile, clock: s.clock, forwards: s.forwards, purge: s.purge };
    return [
      ...Object.entries(s.records).map(([key, r]): Entry => [p + storageName(key), r, () => docOf(this.m, key, r)]),
      [p + ACKS, s.acks, () => s.acks],
      [p + META, meta, () => meta],
    ];
  }

  /** A refused write is not remembered as written, so the next write tries it again. */
  private put(key: string, obj: unknown, doc: () => unknown): void {
    const had = this.written.get(key);
    if (had?.obj === obj) return;
    const json = JSON.stringify(doc());
    if (had?.json === json || this.st.get(key) === json || this.st.set(key, json)) this.written.set(key, { obj, json });
  }
}

/**
 * A fold run, its store written, and its mark written only once all of that reads back. Its keys are never removed:
 * until a fold is marked done, the next boot folds again from them, merging whatever an earlier try or another tab
 * wrote. trusted: a store was found, so its mark means something. Null when nothing changed.
 */
function foldInto<R>(st: Storage, m: Model<R>, f: Fold<R>, s: LocalStore<R>, trusted: boolean, now: number): LocalStore<R> | null {
  const r = f.fold(s, k => st.get(k), trusted ? st.get(m.prefix + f.mark) : null, now);
  if (!r) return null;
  const p = new Persist(st, m);
  p.write(r.store);
  if (p.verify(r.store)) st.set(m.prefix + f.mark, r.mark);
  return r.store;
}

/**
 * The store at boot, with each fold run whose keys are there. Never over a newer build's store, which did its own
 * folds. moved: this first boot folded records in from before sync.
 */
export function bootStore<R>(st: Storage, m: Model<R>, now: number): { store: LocalStore<R>; moved: boolean } {
  const found = readStore(st, m), first = st.get(m.prefix + META) === null;
  if (newerStore(st, m)) return { store: found ?? emptyStore(), moved: false };
  let store = found ?? emptyStore<R>(), moved = false;
  for (const f of m.folds ?? []) {
    if (!st.keys().some(k => f.reads(k))) continue;
    store = foldInto(st, m, f, store, found !== null, now) ?? store;
    moved ||= first && Object.keys(store.records).length > 0;
  }
  return { store, moved };
}

/** Where an edit came from: the app (a change to upload), sync (a merge or an ack), another tab (a reload). */
export type Source = 'app' | 'sync' | 'reload';
export type StoreListener<R> = (next: LocalStore<R>, prev: LocalStore<R>, source: Source) => void;

export interface LocalEnv { now(): number }

/** The device's store in memory, mirrored to storage on every edit. */
export class Local<R> {
  store: LocalStore<R>;
  /** This boot folded records in from before sync, for a notice. */
  readonly moved: boolean;
  /** A newer build wrote this device's storage: it is read, never written, and this session's edits live in memory. */
  readonly newer: boolean;
  /** The server's clock minus this device's, in ms. */
  skew = 0;
  private persist: Persist<R>;
  private subs = new Set<StoreListener<R>>();

  constructor(private st: Storage, readonly model: Model<R>, readonly env: LocalEnv = { now: () => Date.now() }) {
    const b = bootStore(st, model, env.now());
    this.store = b.store;
    this.moved = b.moved;
    this.newer = newerStore(st, model);
    if (this.newer) this.st = memoryStorage();
    this.persist = new Persist(this.st, model);
    this.persist.write(this.store);
  }

  /** The wall clock, corrected by the server's. */
  now(): number { return this.env.now() + this.skew; }

  /** A Date header: the skew is kept only past the header's 1 s resolution and the round trip. */
  serverTime(serverMs: number, sentMs: number, recvMs: number): void {
    const off = serverMs + 500 - (sentMs + recvMs) / 2;
    this.skew = Math.abs(off) > 2000 + (recvMs - sentMs) / 2 ? Math.round(off) : 0;
  }

  edit(f: (s: LocalStore<R>, now: number) => LocalStore<R>, source: Source = 'app'): LocalStore<R> {
    // Another tab may have written since this one last read (its storage event not yet handled): an edit on the older
    // copy would write that copy's meta and records back over it.
    this.reload();
    const prev = this.store, next = f(prev, this.now());
    if (next === prev) return prev;
    this.store = next;
    this.persist.write(next);
    for (const fn of this.subs) fn(next, prev, source);
    return next;
  }

  /** Storage changed under us (another tab): read it back. */
  reload(): void {
    if (!this.persist.stale()) return;
    const next = readStore(this.st, this.model);
    if (next) this.replace(next);
  }

  /** A key a fold reads changed (a tab of an older build still open, or a rollback): what changed folds in. */
  refold(): void {
    if (this.newer) return;
    this.reload();
    let next: LocalStore<R> | null = null;
    for (const f of this.model.folds ?? []) next = foldInto(this.st, this.model, f, next ?? this.store, true, this.now()) ?? next;
    if (next) this.replace(next);
  }

  /** Whether a storage key is one refold() reads. */
  folds(key: string): boolean { return (this.model.folds ?? []).some(f => f.reads(key)); }

  /** Whether a storage key is the store's own, written by another tab. */
  owns(key: string): boolean { return key.startsWith(this.model.prefix); }

  private replace(next: LocalStore<R>): void {
    const prev = this.store;
    this.store = next;
    this.persist.reset();
    this.persist.write(next);
    for (const fn of this.subs) fn(next, prev, 'reload');
  }

  on(fn: StoreListener<R>): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
}
