import { FORWARD_KEY, ACCOUNT_KEY, forwardDoc, forwardFrom } from './account.js';
import { codeFromRoom, parseCode, type CodeError } from './code.js';
import { canon, tick } from './crdt.js';
import { resolveForward, tagOf } from './identity.js';
import type { Local } from './local.js';
import { kindOf, recordsIn, type Records } from './records.js';
import { acknowledge, changed, chips, dirty, joinAccount, plan, roomsOf, takeIn, type Chip, type Put } from './plan.js';
import { RoomError, type RoomApi } from './rooms.js';
import { adoptAccount, expire, forwardDone, oldestTombstone, purgeDone, purgeRecord, queueForward, switchAccount, type LocalStore } from './store.js';

// The sync engine: the device's store and its account room, reconciled in the background. The domain decides what to
// merge and what to PUT (plan.ts); this runs rounds against the room, acknowledges what the server took, backs off when
// it cannot, and tells the UI how things stand. The app never waits on it.

/** A local change is saved this long after changes stop, and never later than MAX_WAIT after the first. */
const DEBOUNCE = 15_000, MAX_WAIT = 60_000;
/** Full scans: every 5 minutes while visible, and on returning after a minute away. */
const FULL_EVERY = 5 * 60_000, AWAY = 60_000;
/** A room with at most this many dirty keys, scanned fully under FULL_EVERY ago, reads just those keys. */
const LIGHT_MAX = 4;
/** Rounds until one moves nothing; bounded, as two devices clobbering each other can keep it busy. */
const MAX_LAPS = 4;
const BACKOFF_MIN = 2000, BACKOFF_MAX = 5 * 60_000, PAUSE_FULL = 30 * 60_000, RATE_MAX = 3600;
/**
 * A rooms server may send its whole rate window (an hour) as Retry-After, though a slot may free much sooner: the first
 * wait is capped at this many seconds for one early retry, and only a second 429 in a row is waited out in full.
 */
const RATE_FIRST = 300;
/**
 * The account room answering 404 across this long, with no answer from it between, is lost. Rooms never expire, so a
 * 404 is almost always a fault on the way, and an edge cache may keep one for minutes.
 */
export const LOST_GAP = 10 * 60_000;
const FAILING = 3;
/** A save counts as backlog (worth a notice when it lands) if it waited this long, or while the device could not save. */
const BACKLOG = 2 * 60_000;
/** Browsers cap the bodies of keepalive requests in flight (64 KiB). */
const KEEPALIVE_BYTES = 60_000;

export type ItemChip = Chip | 'failed';
export type SyncState = 'offline' | 'syncing' | 'saved' | 'error';
/** full: the room or the app hit its cap. lost: the account room is gone. failing: uploads keep failing. rate: no code yet, the server makes no more rooms for now. */
export type SyncProblem = 'full' | 'lost' | 'failing' | 'rate';

export interface SyncStatus {
  state: SyncState;
  problem: SyncProblem | null;
  /** The account code, once the account room exists. */
  code: string | null;
  /** Four hex digits of the account's public id. */
  tag: string | null;
  /** Each record's chip, by room key. */
  items: Readonly<Record<string, ItemChip>>;
  /** How many records are not on the server. */
  unsaved: number;
  /** When a pass last ended with nothing left to upload. */
  savedAt: number | null;
  /** A newer build's data was seen: "Update the app". */
  newer: boolean;
  /** With problem 'rate': when the next try to make the account room goes out. */
  retryAt: number | null;
}

export interface SyncEvents {
  status: SyncStatus;
  /** The account room was just made: "You're backed up. Here's your code." Its upload is not also reported as backlog. */
  account: { code: string };
  /** Records saved while offline or failing, or waiting over 2 minutes, reached the server. */
  backlog: { keys: string[]; at: number };
  /** Another device's changes arrived, to these records. */
  news: { keys: string[] };
}

export type SyncFailure = 'offline' | 'code' | 'notfound' | 'notaccount' | 'same' | 'noaccount' | 'rate' | 'full' | 'failed';

/** A link or merge: whether some of it still waits to upload. */
export interface Linked { pending: boolean }

/** What a code holds, before linking or merging. */
export interface Peek<R> { code: string; records: Records<R>; same: boolean }

export class SyncError extends Error {
  constructor(readonly kind: SyncFailure, readonly detail?: CodeError) { super(`sync: ${kind}${detail ? ` (${detail})` : ''}`); }
}

export interface SyncEnv {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  random(): number;
  online(): boolean;
  visible(): boolean;
}

/** Runs fn while no other tab syncs. */
export type SyncLock = <T>(fn: () => Promise<T>) => Promise<T>;

type Snapshot = Record<string, unknown>;
type Listener<K extends keyof SyncEvents> = (v: SyncEvents[K]) => void;

const without = (o: Snapshot, key: string): Snapshot => { const { [key]: _, ...rest } = o; return rest; };

export class Sync<R> {
  private listeners = new Map<keyof SyncEvents, Set<Listener<never>>>();
  private queue: Promise<unknown> = Promise.resolve();
  private running = 0;
  private started = false;
  private passTimer: unknown = null;
  private passAt = Infinity;
  private wantFull = false;
  private debounce: unknown = null;
  private firstChange: number | null = null;
  private periodic: unknown = null;
  private failures = 0;
  private backoffUntil = 0;
  private netDown = false;
  private pausedUntil = 0;
  private createBlockedUntil = 0;
  /** 429s in a row from the account room's POST. */
  private rateHits = 0;
  private accountMissingAt: number | null = null;
  private lostAccount = false;
  /** Rooms at their cap (413): until the next full scan, only keys already there are updated. */
  private full = new Set<string>();
  /** Rooms the server refuses as malformed (400). */
  private dropped = new Set<string>();
  /** Account rooms that are the landing of a forward cycle: their own forward is ignored. */
  private cycleHeads = new Set<string>();
  private scannedAt = new Map<string, number>();
  private serverKeys = new Map<string, Set<string>>();
  /** Records not yet saved, by key: since when, and whether the device was offline or failing meanwhile. */
  private pending = new Map<string, { at: number; stuck: boolean }>();
  private landed = new Set<string>();
  private madeAccount = false;
  private newer = false;
  private savedAt: number | null = null;
  private hiddenAt: number | null = null;
  /** The page-hide flush in flight, outside the pass queue. */
  private flushing: Promise<void> | null = null;
  private cached: SyncStatus | null = null;
  private shown = '';
  private refreshQueued = false;
  private refreshedAt = -Infinity;

  constructor(private local: Local<R>, private api: RoomApi, private env: SyncEnv, private lock: SyncLock = fn => fn()) {
    local.on((_next, _prev, source) => {
      this.touch();
      if (source !== 'sync') this.changed();
    });
  }

  private get m() { return this.local.model; }

  // Events for the UI.

  on<K extends keyof SyncEvents>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = new Set());
    set.add(fn as Listener<never>);
    return () => { set.delete(fn as Listener<never>); };
  }

  private emit<K extends keyof SyncEvents>(type: K, v: SyncEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as Listener<K>)(v);
  }

  get status(): SyncStatus { return this.cached ??= this.compute(); }

  // Triggers.

  /** Begins background sync: a full pass now, then the periodic one. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0, true);
    const every = () => { this.periodic = this.env.setTimer(() => { if (this.env.visible()) this.schedule(0, true); every(); }, FULL_EVERY); };
    every();
  }

  stop(): void {
    this.started = false;
    for (const h of [this.passTimer, this.debounce, this.periodic]) if (h !== null) this.env.clearTimer(h);
    this.passTimer = this.debounce = this.periodic = null;
  }

  /** A local change: saved once changes stop for a while. */
  changed(): void {
    const now = this.env.now();
    this.firstChange ??= now;
    const wait = Math.max(0, Math.min(DEBOUNCE, this.firstChange + MAX_WAIT - now));
    if (this.debounce !== null) this.env.clearTimer(this.debounce);
    this.debounce = this.env.setTimer(() => { this.debounce = null; this.firstChange = null; this.schedule(0); }, wait);
  }

  /** Worth saving at once. */
  soon(): void { this.schedule(0); }

  /** The connection is back: sync now, past any backoff. */
  online(): void {
    this.netDown = false;
    this.failures = 0;
    this.backoffUntil = 0;
    this.schedule(0, true, true);
    this.touch();
  }

  offline(): void { this.touch(); }

  /** The page is going to the background and may never run again: what is dirty goes now. */
  hidden(): void {
    this.hiddenAt ??= this.env.now();
    this.flushing ??= this.flush().finally(() => { this.flushing = null; });
  }

  /** Back in the foreground: a full scan after a minute away. */
  visible(): void {
    const away = this.hiddenAt === null ? 0 : this.env.now() - this.hiddenAt;
    this.hiddenAt = null;
    this.schedule(0, away >= AWAY);
  }

  /** One pass now, after anything queued; resolves when it is done. */
  sync(o: { full?: boolean } = {}): Promise<void> {
    const full = this.wantFull || !!o.full;
    this.wantFull = false;
    return this.exclusive(() => this.pass(full)).then(() => this.passed());
  }

  /** Resolves once nothing is queued or running. */
  async idle(): Promise<void> {
    for (;;) {
      const q = this.queue;
      await q;
      await this.flushing;
      await new Promise<void>(r => queueMicrotask(r));
      if (q === this.queue && !this.running && !this.flushing) return;
    }
  }

  // Operations for the UI. Each needs a connection and fails with a SyncError.

  /** What is saved under a code, for the question before linking or merging. */
  async peekCode(text: string): Promise<Peek<R>> {
    const c = this.parse(text);
    return this.op(async () => {
      const a = await this.readAccount(c.room);
      return { code: codeFromRoom(a.room), records: recordsIn(this.m, a.snapshot), same: a.room === this.local.store.account };
    });
  }

  /**
   * This device joins the account of a code typed ("I use this on another device"): its records merge in, but where
   * the account holds another playthrough its own stays behind in the account it had, which (if any, and not lost) is
   * owed a forward to the new one. Once switched, a failure only delays the upload, which later passes finish: the
   * result says so (`pending`) instead of failing.
   */
  async linkCode(text: string): Promise<Linked> {
    const c = this.parse(text);
    return this.op(async () => {
      const a = await this.readAccount(c.room);
      this.local.reload();
      const before = this.local.store.account, moved = a.room !== before;
      if (moved) {
        const owed = before && !this.lostAccount ? before : null;
        this.local.edit((s, now) => {
          const next = joinAccount(this.m, switchAccount(s, a.room, now, this.m.salt).store, a.snapshot);
          return owed ? queueForward(next, owed) : next;
        }, 'sync');
        this.scanned(a.room, a.snapshot);
      }
      return { pending: !await this.upload(a.room, moved ? a.snapshot : null) };
    });
  }

  /**
   * Another account merges into this one ("Merge another code into this one"); its room is owed a forward here. Its
   * records come in, but where this account holds another playthrough, this account's stays.
   */
  async mergeCode(text: string): Promise<Linked> {
    const c = this.parse(text);
    return this.op(async () => {
      const mine = this.local.store.account;
      if (!mine) throw new SyncError('noaccount');
      if (c.room === mine) throw new SyncError('same');
      const b = await this.readAccount(c.room);
      if (b.room === mine) return { pending: false };
      const prev = this.local.store;
      this.local.edit(s => queueForward(takeIn(this.m, s, b.snapshot), b.room), 'sync');
      this.tellNews(prev, this.local.store);
      return { pending: !await this.upload(mine, null) };
    });
  }

  /** The account room is lost for good: a new one, and everything on this device uploads there. Other devices link to it. */
  remakeAccount(): Promise<string> {
    return this.op(async () => {
      const room = await this.api.create();
      this.local.edit((s, now) => switchAccount(s, room, now, this.m.salt).store, 'sync');
      this.scanned(room, {});
      await this.upload(room, {});
      const code = codeFromRoom(room);
      this.emit('account', { code });
      return code;
    });
  }

  // Passes and rounds.

  private schedule(ms: number, full = false, force = false): void {
    if (full) this.wantFull = true;
    if (!this.started) return;
    const now = this.env.now(), at = Math.max(now + ms, force ? 0 : this.backoffUntil, this.pausedUntil);
    if (this.passTimer !== null) {
      if (this.passAt <= at) return;
      this.env.clearTimer(this.passTimer);
    }
    this.passAt = at;
    this.passTimer = this.env.setTimer(() => { this.passTimer = null; this.passAt = Infinity; void this.sync(); }, at - now);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.lock(async () => {
      this.running++;
      this.touch();
      try { return await fn(); } finally { this.running--; this.touch(); }
    }));
    this.queue = run.catch(() => {});
    return run;
  }

  private async pass(full: boolean): Promise<void> {
    if (this.env.now() < this.pausedUntil || !this.env.online()) { this.touch(); return; }
    this.madeAccount = false;
    try {
      this.local.edit((s, now) => expire(this.m, s, now), 'sync');
      await this.ensureAccount();
      let quiet = false;
      for (let lap = 0; lap < MAX_LAPS && !quiet; lap++) {
        quiet = true;
        const room = this.next();
        if (room && await this.round(room, full && lap === 0)) quiet = false;
      }
      await this.purgeKeys();
      await this.writeForwards();
      this.failures = 0;
      this.backoffUntil = 0;
      this.netDown = false;
      if (!dirty(this.m, this.local.store).length) this.savedAt = this.env.now();
    } catch (e) {
      this.failed(e);
    }
  }

  /** After a pass, no longer running: the status settles and a landed backlog is told once. */
  private passed(): void {
    this.refresh();
    const keys = [...this.landed].sort();
    this.landed.clear();
    if (keys.length && !this.madeAccount) this.emit('backlog', { keys, at: this.env.now() });
  }

  /** The account room, unless the server refuses it. */
  private next(): string | null {
    const room = roomsOf(this.local.store)[0];
    return room && !this.dropped.has(room) ? room : null;
  }

  /** Reads, merges and uploads one room: whether anything moved. */
  private async round(room: string, full: boolean): Promise<boolean> {
    const read = await this.read(room, full);
    return read ? this.apply(room, read.remote, read.keys) : false;
  }

  private async read(room: string, full: boolean): Promise<{ remote: Snapshot; keys?: string[] } | null> {
    if (!full && this.env.now() - (this.scannedAt.get(room) ?? -Infinity) < FULL_EVERY) {
      const keys = dirty(this.m, this.local.store).filter(p => p.room === room).map(p => p.key);
      if (!keys.length) return null;
      const remote = await this.readKeys(room, keys);
      if (remote) return { remote, keys };
    }
    let remote: Snapshot;
    try { remote = await this.scanRoom(room); } catch (e) {
      if (e instanceof RoomError && (e.status === 404 || e.status === 400)) { this.missing(room, e.status); return null; }
      throw e;
    }
    this.scanned(room, remote);
    return { remote };
  }

  /**
   * Just these keys, when they are few and the server was last seen holding every one; null when the room must be read
   * whole. A 404 is never taken as absent: an edge cache may keep one from before another device wrote the key, and a
   * PUT on its word would overwrite that device's doc unmerged. Keys not known to be there are not asked for, so no 404
   * is left for the edge to keep.
   */
  private async readKeys(room: string, keys: readonly string[]): Promise<Snapshot | null> {
    const held = this.serverKeys.get(room);
    if (keys.length > LIGHT_MAX || !held || !keys.every(k => held.has(k))) return null;
    const remote: Snapshot = {};
    for (const k of keys) {
      try { remote[k] = await this.api.get(room, k); } catch (e) {
        if (e instanceof RoomError && e.status === 404) return null;
        throw e;
      }
      this.accountOk(room);
    }
    return remote;
  }

  /** A scan whose 404 counts only once a read past any cache agrees: an edge may keep a 404 for minutes. */
  private async scanRoom(room: string): Promise<Snapshot> {
    try { return await this.api.scan(room); } catch (e) {
      if (!(e instanceof RoomError) || e.status !== 404) throw e;
      return this.api.scan(room, { fresh: true });
    }
  }

  private scanned(room: string, remote: Snapshot): void {
    this.scannedAt.set(room, this.env.now());
    this.serverKeys.set(room, new Set(Object.keys(remote)));
    // A full room may have room again (keys deleted elsewhere): new keys get one more try each full scan.
    this.full.delete(room);
    this.accountOk(room);
  }

  /** The account room answered: any 404 before was a fault on the way, not a lost room. */
  private accountOk(room: string): void {
    if (room !== this.local.store.account) return;
    this.accountMissingAt = null;
    this.lostAccount = false;
  }

  /** Merges a read into the store and uploads what the server lacks: whether anything moved. */
  private async apply(room: string, remote: Snapshot, keys?: string[]): Promise<boolean> {
    // The plan replaces the store whole, so it must start from what another tab may have written during the read.
    this.local.reload();
    const s = this.local.store;
    // The room left sync while it was read (an account switch).
    if (room !== s.account) return false;
    const p = plan(this.m, s, room, this.cycleHeads.has(room) ? without(remote, FORWARD_KEY) : remote, keys);
    this.local.edit(() => p.store, 'sync');
    if (p.newer.length) this.newer = true;
    if (p.news.length) this.emit('news', { keys: p.news });
    if (p.forward) await this.follow(room, remote);
    const sent = await this.push(p.puts);
    return p.news.length > 0 || sent > 0 || !!p.forward;
  }

  /** PUTs, acknowledging each one the server took: how many it took. */
  private async push(puts: readonly Put[], keepalive = false): Promise<number> {
    let sent = 0;
    for (const put of puts) {
      if (!this.pushable(put)) continue;
      if (!await this.putOne(put, keepalive)) continue;
      sent++;
      this.netDown = false;
      this.accountOk(put.room);
      this.local.edit(s => acknowledge(s, put.room, put.key, put.hash), 'sync');
      const held = this.serverKeys.get(put.room);
      if (held && !held.has(put.key)) this.full.delete(put.room);
      held?.add(put.key);
    }
    return sent;
  }

  /** One PUT: whether the server took it. A full account room first gives up its oldest tombstone for a new key. */
  private async putOne(put: Put, keepalive: boolean): Promise<boolean> {
    for (let freed = false; ;) {
      try { await this.api.put(put.room, put.key, put.value, keepalive ? { keepalive } : undefined); return true; } catch (e) {
        if (!(e instanceof RoomError)) throw e;
        if (e.status === 413) {
          if (!freed && !keepalive && await this.freeSlot(put.room, put.key)) { freed = true; continue; }
          this.full.add(put.room);
          return false;
        }
        if (e.status === 404 || e.status === 400) { this.missing(put.room, e.status); return false; }
        throw e;
      }
    }
  }

  /** Deletes the oldest tombstone the account room holds, to make room for a new key: whether one went. */
  private async freeSlot(room: string, key: string): Promise<boolean> {
    const held = this.serverKeys.get(room);
    if (room !== this.local.store.account || !held || held.has(key)) return false;
    const drop = oldestTombstone(this.m, this.local.store, k => held.has(k));
    if (!drop) return false;
    this.local.edit(s => purgeRecord(this.m, s, drop), 'sync');
    await this.purgeKeys();
    return !held.has(drop);
  }

  /** Purged records' keys, deleted from the account room. */
  private async purgeKeys(): Promise<void> {
    const room = this.local.store.account;
    if (!room || this.lostAccount) return;
    for (const key of Object.keys(this.local.store.purge)) {
      try { await this.api.delete(room, key); } catch (e) {
        if (e instanceof RoomError && (e.status === 404 || e.status === 400)) { this.missing(room, e.status); return; }
        throw e;
      }
      this.local.edit(s => purgeDone(s, key), 'sync');
      this.serverKeys.get(room)?.delete(key);
      this.full.delete(room);
    }
  }

  private pushable(put: Put): boolean {
    if (this.dropped.has(put.room)) return false;
    return !this.full.has(put.room) || !!this.serverKeys.get(put.room)?.has(put.key);
  }

  private missing(room: string, status: number): void {
    if (status === 400) { this.dropped.add(room); console.warn(`sync: room ${room} refused as malformed; left out of sync`); return; }
    if (room !== this.local.store.account) return;
    const now = this.env.now();
    if (this.accountMissingAt === null) this.accountMissingAt = now;
    else if (now - this.accountMissingAt >= LOST_GAP) this.lostAccount = true;
  }

  /** The account room read is retired: this device moves to where its forwards lead, and joins the account there. */
  private async follow(room: string, remote: Snapshot): Promise<void> {
    const end = await this.forwardsFrom(room, remote);
    if (!end) return;
    if (end.room === room) { this.cycleHeads.add(room); return; }
    const prev = this.local.store;
    this.local.edit((s, now) => joinAccount(this.m, switchAccount(s, end.room, now, this.m.salt).store, end.snapshot), 'sync');
    this.tellNews(prev, this.local.store);
    this.accountMissingAt = null;
    this.lostAccount = false;
  }

  /** Where a chain of forwards from a scanned room ends, with that room's scan; null if it leads to a missing room. */
  private async forwardsFrom(start: string, snap: Snapshot): Promise<{ room: string; snapshot: Snapshot } | null> {
    const snaps = new Map<string, Snapshot>([[start, snap]]);
    const forwardOf = (room: string): string | null | undefined => {
      const s = snaps.get(room);
      if (!s) return undefined;
      const f = forwardFrom(s[FORWARD_KEY]);
      return f && f.to !== room ? f.to : null;
    };
    for (let i = 0; i < 16; i++) {
      const r = resolveForward(start, forwardOf);
      if ('room' in r) return { room: r.room, snapshot: snaps.get(r.room)! };
      try { snaps.set(r.need, await this.scanRoom(r.need)); } catch (e) {
        if (e instanceof RoomError && e.status === 404) return null;
        throw e;
      }
    }
    return null;
  }

  /**
   * Account rooms this device left get their forward, to the account it syncs now, once everything is uploaded there.
   * Kept in the store until written, so an app killed before then still writes it.
   */
  private async writeForwards(): Promise<void> {
    const to = this.local.store.account;
    if (!to || this.unsaved(to)) return;
    for (const from of Object.keys(this.local.store.forwards)) {
      if (from !== to) {
        try { await this.api.put(from, FORWARD_KEY, forwardDoc(to, tick(this.local.store.clock, this.local.now()))); } catch (e) {
          // A room that is gone, or refused, has nobody left to follow a forward.
          if (!(e instanceof RoomError) || (e.status !== 404 && e.status !== 400)) throw e;
        }
      }
      this.local.edit(s => forwardDone(s, from), 'sync');
    }
  }

  /** Uploads to one room until the server holds every key, then writes pending forwards: whether it all went. */
  private async settle(room: string): Promise<boolean> {
    for (let i = 0; i < MAX_LAPS && this.roomDirty(room); i++) await this.round(room, false);
    if (this.unsaved(room)) return false;
    await this.writeForwards();
    return true;
  }

  /** After a link, merge or new code has changed the store: its upload, whose failure leaves the rest to later passes. */
  private async upload(room: string, snapshot: Snapshot | null): Promise<boolean> {
    try {
      if (snapshot) await this.apply(room, snapshot);
      if (await this.settle(room)) return true;
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      if (e.status === 0) this.netDown = true;
    }
    this.soon();
    return false;
  }

  private async ensureAccount(): Promise<void> {
    const s = this.local.store, now = this.env.now();
    if (s.account || !Object.keys(s.records).length) return;
    // A newer build's store whose account this build cannot read: a room made here would split the account.
    if (this.local.newer) return;
    // An earlier pass may have taken the place of the retry's timer: keep the retry.
    if (now < this.createBlockedUntil) { this.schedule(this.createBlockedUntil - now); return; }
    let room: string;
    try { room = await this.api.create(); } catch (e) {
      if (e instanceof RoomError && e.status === 429) {
        const wait = Math.min(e.retryAfter ?? RATE_MAX, RATE_MAX), ms = (this.rateHits++ ? wait : Math.min(wait, RATE_FIRST)) * 1000;
        this.createBlockedUntil = now + ms;
        this.schedule(ms);
        return;
      }
      throw e;
    }
    this.createBlockedUntil = 0;
    this.rateHits = 0;
    // Another tab may have adopted an account while the POST was out; this room then stays empty.
    this.local.reload();
    if (this.local.store.account) return;
    this.local.edit((st, t) => adoptAccount(st, room, t, this.m.salt), 'sync');
    this.scanned(room, {});
    this.madeAccount = true;
    this.emit('account', { code: codeFromRoom(room) });
  }

  private failed(e: unknown): void {
    const now = this.env.now();
    if (e instanceof RoomError && e.status === 507) { this.pausedUntil = now + PAUSE_FULL; this.schedule(PAUSE_FULL); return; }
    if (e instanceof RoomError && e.status === 429) {
      const ms = Math.min(e.retryAfter ?? 60, RATE_MAX) * 1000;
      this.backoffUntil = now + ms;
      this.schedule(ms);
      return;
    }
    if (!(e instanceof RoomError)) console.warn('sync:', e);
    else if (e.status === 0) this.netDown = true;
    this.failures++;
    const ms = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (this.failures - 1)) * (0.5 + this.env.random() * 0.5);
    this.backoffUntil = now + ms;
    this.schedule(ms);
  }

  /** Dirty docs, sent without reading first, as keepalive requests the browser finishes after the page is gone. */
  private async flush(): Promise<void> {
    if (!this.env.online() || this.env.now() < this.pausedUntil) return;
    let bytes = 0;
    const puts = dirty(this.m, this.local.store).filter(p => this.pushable(p)).filter(p => (bytes += JSON.stringify(p.value).length) <= KEEPALIVE_BYTES);
    await Promise.all(puts.map(p => this.push([p], true).catch(() => 0)));
  }

  // Helpers.

  /**
   * A UI operation runs at once, not queued behind passes nor under the tab lock: a pass stuck on a slow request, here
   * or in another tab, must not hold it up. Its edits are functional like a pass's, so the two interleave safely.
   */
  private async op<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.env.online()) throw new SyncError('offline');
    try { return await fn(); } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      if (e.status === 0) this.netDown = true;
      throw new SyncError(e.status === 0 ? 'offline' : e.status === 404 ? 'notfound' : e.status === 429 ? 'rate' : e.status === 413 || e.status === 507 ? 'full' : 'failed');
    }
  }

  private parse(text: string): { room: string; code: string } {
    const c = parseCode(text, this.m.qrPrefix);
    if ('error' in c) throw new SyncError('code', c.error);
    return c;
  }

  /** A room holding a manifest or any of the app's keys. */
  private isAccountRoom(snap: Snapshot): boolean {
    return ACCOUNT_KEY in snap || Object.keys(snap).some(k => kindOf(this.m, k) !== null);
  }

  private async readAccount(room: string): Promise<{ room: string; snapshot: Snapshot }> {
    const snap = await this.scanRoom(room);
    if (!this.isAccountRoom(snap)) throw new SyncError('notaccount');
    const end = await this.forwardsFrom(room, snap);
    if (!end) throw new SyncError('notfound');
    return end;
  }

  /** Keys of the room still to upload that the server can take now. */
  private roomDirty(room: string): boolean { return dirty(this.m, this.local.store).some(p => p.room === room && this.pushable(p)); }
  /** Keys of the room still to upload, whether or not the server can take them now. */
  private unsaved(room: string): boolean { return dirty(this.m, this.local.store).some(p => p.room === room); }

  private tellNews(prev: LocalStore<R>, next: LocalStore<R>): void {
    const keys = changed(prev.records, next.records);
    if (keys.length) this.emit('news', { keys });
  }

  // Status.

  private touch(): void {
    this.cached = null;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      // Mid-pass, each ack would recount the chips; the pass refreshes once at its end.
      if (this.running && this.env.now() - this.refreshedAt < 250) return;
      this.refresh();
    });
  }

  private refresh(): void {
    this.cached = null;
    const st = this.status, now = this.env.now(), stuck = st.state === 'offline' || st.state === 'error';
    this.refreshedAt = now;
    for (const [key, chip] of Object.entries(st.items)) {
      const had = this.pending.get(key);
      if (chip !== 'saved') {
        if (!had) this.pending.set(key, { at: now, stuck });
        else had.stuck ||= stuck;
      } else if (had) {
        this.pending.delete(key);
        if (had.stuck || now - had.at >= BACKLOG) this.landed.add(key);
      }
    }
    for (const key of this.pending.keys()) if (!(key in st.items)) this.pending.delete(key);
    const text = canon(st);
    if (text !== this.shown) { this.shown = text; this.emit('status', st); }
  }

  private problem(): SyncProblem | null {
    const now = this.env.now();
    if (this.lostAccount) return 'lost';
    if (this.full.size || now < this.pausedUntil) return 'full';
    if (this.failures >= FAILING && this.env.online()) return 'failing';
    if (!this.local.store.account && now < this.createBlockedUntil) return 'rate';
    return null;
  }

  private compute(): SyncStatus {
    const s = this.local.store, problem = this.problem(), c = chips(this.m, s);
    const failing = problem === 'failing' || problem === 'full' || problem === 'lost';
    const items = Object.fromEntries(Object.entries(c.items).map(([k, chip]): [string, ItemChip] => [k, failing && s.account && chip !== 'saved' ? 'failed' : chip]));
    const online = this.env.online() && !this.netDown;
    const state: SyncState = !online ? 'offline' : this.running ? 'syncing' : problem ? 'error' : c.unsaved || dirty(this.m, s).length ? 'syncing' : 'saved';
    return {
      state, problem,
      code: s.account ? codeFromRoom(s.account) : null,
      tag: s.profile ? tagOf(s.profile.pid) : null,
      items, unsaved: c.unsaved,
      savedAt: this.savedAt, newer: this.newer || this.local.newer,
      retryAt: problem === 'rate' ? this.createBlockedUntil : null,
    };
  }
}

// Browser adapters.

export const browserEnv = (): SyncEnv => ({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: Math.random,
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  visible: () => typeof document === 'undefined' || !document.hidden,
});

/** One tab syncs at a time, under a Web Lock of this name; without Web Locks, each tab on its own. */
export const webLock = (name: string): SyncLock => fn => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks?.request ? locks.request(name, fn) as Promise<Awaited<ReturnType<typeof fn>>> : fn();
};

/** The page's own triggers: connection changes, background and foreground, and another tab's writes (an older build's too). */
export function listen<R>(sync: Sync<R>, local: Local<R>): void {
  addEventListener('online', () => sync.online());
  addEventListener('offline', () => sync.offline());
  document.addEventListener('visibilitychange', () => { if (document.hidden) sync.hidden(); else sync.visible(); });
  addEventListener('pagehide', () => sync.hidden());
  let reload: ReturnType<typeof setTimeout> | null = null, refold: ReturnType<typeof setTimeout> | null = null;
  addEventListener('storage', e => {
    if (e.key === null || local.owns(e.key)) reload ??= setTimeout(() => { reload = null; local.reload(); }, 50);
    if (e.key === null || local.folds(e.key)) refold ??= setTimeout(() => { refold = null; local.refold(); }, 50);
  });
}
