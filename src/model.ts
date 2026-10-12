import type { Stamp } from './crdt.js';
import type { LocalStore } from './store.js';

/** A room's keys as read, each to its parsed JSON. */
export type Snapshot = Readonly<Record<string, unknown>>;

/**
 * Which game or document a record belongs to: run is 0 for the first, one more for each start over; game is its own
 * id. Two playthroughs never mix field by field.
 */
export interface Playthrough { run: number; game: string }

export const samePlay = (a: Playthrough, b: Playthrough): boolean => a.run === b.run && a.game === b.game;

/** The later run, then the larger id. */
export const playOrder = (a: Playthrough, b: Playthrough): number => a.run - b.run || (a.game < b.game ? -1 : a.game > b.game ? 1 : 0);

/** One kind of record: each lives at its own room key, and merges on its own. */
export interface Kind<R> {
  /** The record a doc holds, repaired; null when it is not one. key is where it was read from. */
  from(raw: unknown, key: string): R | null;
  /** Commutative, associative, idempotent, and canonical: two devices holding the same records build the same docs. */
  merge(a: R, b: R): R;
  /** Every stamp the record carries, which the clock must pass. */
  stamp(r: R): Stamp;
  /** The doc a room holds; `{ v, ...r }` by default. */
  doc?(r: R): unknown;
  /**
   * The record's playthrough, for records that never mix across playthroughs (a game's save). Joining an account then
   * takes its record whole unless it is the same playthrough, merging one in keeps this account's, and a save made for
   * a playthrough the store no longer holds is refused. Without it, records always merge.
   */
  play?(r: R): Playthrough;
}

/**
 * A migration from what an app kept before sync: folded in at boot, and again whenever another tab (an older build)
 * writes one of its keys. Marked done only once the store it made reads back from storage.
 */
export interface Fold<R> {
  /** Its record of what the last fold took: a name under the prefix. */
  mark: string;
  /** Whether a storage key (whole, any prefix) is one it reads. */
  reads(key: string): boolean;
  /**
   * What changed in its keys since `last` (its mark as last written; null on a first fold, or when no store is left to
   * hold what that mark recorded), merged into s, with the mark to record; null when nothing changed. It only adds, so
   * what a killed fold or another tab wrote is merged, never dropped.
   */
  fold(s: LocalStore<R>, get: (key: string) => string | null, last: string | null, now: number): { store: LocalStore<R>; mark: string } | null;
}

/** What an app plugs in: its names and its kinds of record. R is the type of its records. */
export interface Model<R> {
  /** Every key the local store writes starts with this ('notes.v2.'). `meta` and `acks` under it are the library's. */
  prefix: string;
  /** Hashed with the account room id into the public id ('notes/public/'). Fixed for good once accounts exist. */
  salt: string;
  /** QR text reads `<qrPrefix>1:<code>`, and parsing a code drops it ('NOTES'). */
  qrPrefix?: string;
  /** The format of the app's docs (their `v`): a higher one is a newer build's, left alone. 1 by default. */
  version?: number;
  /**
   * The kind of record a room key holds; null for a key that is not the app's (and always for `account` and
   * `forward`). Keys hold no dot: a record is kept in local storage under its key with each `/` as a `.`.
   */
  kind(key: string): Kind<R> | null;
  /** Migrations from storage written before sync, in order. */
  folds?: readonly Fold<R>[];
}
