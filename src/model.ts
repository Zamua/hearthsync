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
   * The record's playthrough, for records that never mix across playthroughs (a game's save): a save made for a
   * playthrough the store no longer holds is refused (`putRecord`), and `otherPlay` says what linking and merging do.
   */
  play?(r: R): Playthrough;
  /**
   * Two playthroughs at one key when accounts meet. 'account' (the default): linking takes the joined account's whole
   * and merging another code in keeps this account's, the other staying in its own room. 'merge': merge decides, as
   * for an edit from another device.
   */
  otherPlay?: 'account' | 'merge';
  /**
   * For records that can be deleted: when the record was last used, and when deleted (0: never). It is gone while
   * deleted > used, and stays as a tombstone so another device does not bring it back with older edits; a later use
   * anywhere revives it. Tombstones show no chip, upload after live records, and are purged in time.
   */
  life?(r: R): { used: Stamp; deleted: Stamp };
  /** At most this many records of this kind, tombstones counted: the oldest tombstone makes way for a new record. */
  cap?: number;
  /**
   * Makes this kind's keys ones an earlier build wrote: where a record read from one lives now. Such a key is never
   * written, and is read again only when it changed since last seen.
   */
  home?(r: R): string;
}

/**
 * A migration from what an app kept before sync: folded in at boot, and again whenever another tab (an older build)
 * writes one of its keys. Marked done only once the store it made reads back from storage.
 */
export interface Fold<R, A = undefined> {
  /** Its record of what the last fold took: a name under the prefix. */
  mark: string;
  /** Whether a storage key (whole, any prefix) is one it reads. */
  reads(key: string): boolean;
  /**
   * What changed in its keys since `last` (its mark as last written; null on a first fold, or when no store is left to
   * hold what that mark recorded), merged into s, with the mark to record; null when nothing changed. It only adds, so
   * what a killed fold or another tab wrote is merged, never dropped.
   */
  fold(s: LocalStore<R, A>, get: (key: string) => string | null, last: string | null, now: number): { store: LocalStore<R, A>; mark: string } | null;
}

/**
 * Small state of the app's own kept on this device beside its records (items seen, the last one used), stored in the
 * meta key with the library's fields, so it is written in the same write. It is not synced.
 */
export interface AppMeta<A> {
  /** The app's state from the meta as storage holds it (`{}` when there is none). Unchecked: repair it. */
  read(meta: Readonly<Record<string, unknown>>): A;
  /** The fields to keep in the meta. The library's own (`v`, `account`, `profile`, `clock`, `forwards`, `purge`) win. */
  write(app: A): Record<string, unknown>;
  /** This tab's state and the one another tab wrote since, as the store holds them next. Without it, the other tab's wins. */
  merge?(mine: A, theirs: A): A;
}

/** What an app plugs in: its names and its kinds of record. R is the type of its records, A of its meta state. */
export interface Model<R, A = undefined> {
  /** Every key the local store writes starts with this ('notes.v2.'). `meta` and `acks` under it are the library's. */
  prefix: string;
  /** Hashed with the account room id into the public id ('notes/public/'). Fixed for good once accounts exist. */
  salt: string;
  /** QR text reads `<qrPrefix>1:<code>`, and parsing a code drops it ('NOTES'). */
  qrPrefix?: string;
  /** The format of the app's docs (their `v`): a higher one is a newer build's, left alone. 1 by default. */
  version?: number;
  /** The format of the local store's meta: a higher one is a newer build's, read but never written. 2 by default. */
  storeVersion?: number;
  /** Tombstones this old (in ms) are purged: dropped here, their keys deleted from the account room. Never by default. */
  purgeAfter?: number;
  /**
   * The kind of record a room key holds, the same object for every key of a kind (a cap counts by it); null for a key
   * that is not the app's (and always for `account` and `forward`). Keys hold no dot: a record is kept in local storage
   * under its key with each `/` as a `.`.
   */
  kind(key: string): Kind<R> | null;
  /** The app's own state in the store's meta, on `LocalStore.app`. Without it, `app` is undefined. */
  meta?: AppMeta<A>;
  /** Migrations from storage written before sync, in order. */
  folds?: readonly Fold<R, A>[];
}
