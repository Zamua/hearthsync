import { ACCOUNT_KEY, DOC, FORWARD_KEY, isNewer } from './account.js';
import { canon, type Stamp } from './crdt.js';
import { samePlay, type Kind, type Model, type Snapshot } from './model.js';

// The app's records, one per room key, read, written and merged through the model's kinds.

export type Records<R> = Readonly<Record<string, R>>;

/** The kind of the record at a room key; null for keys that are not the app's. */
export const kindOf = <R>(m: Model<R>, key: string): Kind<R> | null => (key === ACCOUNT_KEY || key === FORWARD_KEY ? null : m.kind(key));

export const versionOf = <R>(m: Model<R>): number => m.version ?? DOC;

/** The doc a room holds for the record at key. */
export function docOf<R>(m: Model<R>, key: string, r: R): unknown {
  const k = kindOf(m, key);
  return k?.doc ? k.doc(r) : { v: versionOf(m), ...(r as object) };
}

/** The app's docs, by room key. */
export function docsOf<R>(m: Model<R>, records: Records<R>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, r] of Object.entries(records)) if (kindOf(m, key)) out[key] = docOf(m, key, r);
  return out;
}

/** The highest stamp the records carry. */
export function stampOf<R>(m: Model<R>, records: Records<R>): Stamp {
  let t = 0;
  for (const [key, r] of Object.entries(records)) t = Math.max(t, kindOf(m, key)?.stamp(r) ?? 0);
  return t;
}

/** The app's records in a room's snapshot: its keys only, each repaired, none of a newer format. */
export function recordsIn<R>(m: Model<R>, snap: Snapshot): Records<R> {
  const out: Record<string, R> = {};
  for (const [key, raw] of Object.entries(snap)) {
    const k = kindOf(m, key);
    if (!k || isNewer(raw, versionOf(m))) continue;
    const r = k.from(raw, key);
    if (r !== null) out[key] = r;
  }
  return out;
}

/**
 * How records from a room come in, key by key. absorb: a read of this account's own room, every record merged. join:
 * this device joins that account, whose record wins whole over one of another playthrough. takeIn: that account
 * merges into this one, whose record of another playthrough stays. A key held on one side only is kept.
 */
export type MergeMode = 'absorb' | 'join' | 'takeIn';

/** held itself when nothing in it changed. */
export function mergeRecords<R>(m: Model<R>, held: Records<R>, incoming: Records<R>, mode: MergeMode = 'absorb'): Records<R> {
  let out: Record<string, R> | null = null;
  for (const [key, r] of Object.entries(incoming)) {
    const k = kindOf(m, key);
    if (!k) continue;
    const h = held[key];
    let next: R;
    if (h === undefined) next = r;
    else if (mode === 'absorb' || !k.play || samePlay(k.play(h), k.play(r))) next = k.merge(h, r);
    else if (mode === 'join') next = r;
    else continue;
    if (h !== undefined && (next === h || canon(next) === canon(h))) continue;
    (out ??= { ...held })[key] = next;
  }
  return out ?? held;
}
