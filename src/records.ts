import { DOC, isLibraryKey, isNewer } from './account.js';
import { canon, type Reg, type Stamp } from './crdt.js';
import { samePlay, type Kind, type Model, type Snapshot } from './model.js';

// The app's records, one per room key, read, written and merged through the model's kinds.

export type Records<R> = Readonly<Record<string, R>>;

/** The kind of the record at a room key; null for keys that are not the app's. */
export const kindOf = <R>(m: Model<R, unknown>, key: string): Kind<R> | null => (isLibraryKey(key) ? null : m.kind(key));

/** The kind of a key records live at: the app's, and not one an earlier build wrote. */
export const homeKind = <R>(m: Model<R, unknown>, key: string): Kind<R> | null => { const k = kindOf(m, key); return k && !k.home ? k : null; };

/** Whether the record at key can live in a room of its own. */
export const ownsRoom = <R>(m: Model<R, unknown>, key: string): boolean => homeKind(m, key)?.room === 'own';

/** Whether the record at key keeps its room register inside itself (`Kind.register`). */
export const keepsRegister = <R>(m: Model<R, unknown>, key: string): boolean => ownsRoom(m, key) && !!homeKind(m, key)!.register;

/** The room register of a record whose kind keeps it inside the record; undefined for any other, or none yet. */
export const recordRoom = <R>(m: Model<R, unknown>, key: string, r: R): Reg<string> | undefined => homeKind(m, key)?.register?.get(r);

/** Whether deleting the record at key is this account leaving its room (`Kind.deletes`). */
export const leavesOnDelete = <R>(m: Model<R, unknown>, key: string): boolean => { const k = homeKind(m, key); return !!k?.layout || k?.deletes === 'account'; };

export const versionOf = <R>(m: Model<R, unknown>): number => m.version ?? DOC;

/** When the record at key was deleted; 0 while it is live, or when its kind is never deleted. */
export function tombstoneOf<R>(m: Model<R, unknown>, key: string, r: R): Stamp {
  const life = kindOf(m, key)?.life?.(r);
  return life && life.deleted > life.used ? life.deleted : 0;
}

export const isLive = <R>(m: Model<R, unknown>, key: string, r: R): boolean => tombstoneOf(m, key, r) === 0;

/** The doc a room holds for the record at key. */
export function docOf<R>(m: Model<R, unknown>, key: string, r: R): unknown {
  const k = kindOf(m, key);
  return k?.doc ? k.doc(r) : { v: versionOf(m), ...(r as object) };
}

/** The app's docs, by room key: live records first, so a room near its cap takes those before tombstones. */
export function docsOf<R>(m: Model<R, unknown>, records: Records<R>): Record<string, unknown> {
  const out: Record<string, unknown> = {}, entries = Object.entries(records).filter(([key]) => homeKind(m, key));
  for (const live of [true, false]) for (const [key, r] of entries) if (isLive(m, key, r) === live) out[key] = docOf(m, key, r);
  return out;
}

/** The highest stamp the records carry. */
export function stampOf<R>(m: Model<R, unknown>, records: Records<R>): Stamp {
  let t = 0;
  for (const [key, r] of Object.entries(records)) t = Math.max(t, kindOf(m, key)?.stamp(r) ?? 0);
  return t;
}

/**
 * The app's records in a room's snapshot: its keys only, each repaired, none of a newer format. A record read from a
 * key an earlier build wrote is placed at its own.
 */
export function recordsIn<R>(m: Model<R, unknown>, snap: Snapshot): Records<R> {
  const out: Record<string, R> = {};
  for (const [key, raw] of Object.entries(snap)) {
    const k = kindOf(m, key);
    if (!k || isNewer(raw, versionOf(m))) continue;
    const r = k.from(raw, key);
    if (r === null) continue;
    const home = k.home ? k.home(r) : key, hk = homeKind(m, home);
    if (!hk) continue;
    const had = out[home];
    out[home] = had === undefined ? r : hk.merge(had, r);
  }
  return out;
}

/** A shared room's snapshot as a layout reads it: without the library's keys and a newer build's docs. */
export function roomRead<R>(m: Model<R, unknown>, snap: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(snap).filter(([k, v]) => !isLibraryKey(k) && !isNewer(v, versionOf(m))));
}

/** The record at key as a shared room holds it, by its kind's layout or whole at its key; null when it holds none. */
export function roomRecord<R>(m: Model<R, unknown>, snap: Snapshot, key: string): R | null {
  const layout = homeKind(m, key)?.layout;
  return layout ? layout.read(roomRead(m, snap), key) : recordsIn(m, snap)[key] ?? null;
}

/**
 * How records from a room come in, key by key. absorb: a read of this account's own room, every record merged. join:
 * this device joins that account, whose record wins whole over one of another playthrough. takeIn: that account
 * merges into this one, whose record of another playthrough stays. A key held on one side only is kept, and a kind
 * whose otherPlay is 'merge' always merges.
 */
export type MergeMode = 'absorb' | 'join' | 'takeIn';

/** held itself when nothing in it changed. */
export function mergeRecords<R>(m: Model<R, unknown>, held: Records<R>, incoming: Records<R>, mode: MergeMode = 'absorb'): Records<R> {
  let out: Record<string, R> | null = null;
  for (const [key, r] of Object.entries(incoming)) {
    const k = homeKind(m, key);
    if (!k) continue;
    const h = held[key];
    let next: R;
    if (h === undefined) next = r;
    else if (mode === 'absorb' || !k.play || k.otherPlay === 'merge' || samePlay(k.play(h), k.play(r))) next = k.merge(h, r);
    else if (mode === 'join') next = r;
    else continue;
    if (h !== undefined && (next === h || canon(next) === canon(h))) continue;
    (out ??= { ...held })[key] = next;
  }
  return out ?? held;
}
