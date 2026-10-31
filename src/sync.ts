import { FORWARD_KEY, ACCOUNT_KEY, forwardDoc, forwardFrom } from './account.js';
import { Backoff } from './backoff.js';
import { codeFromRoom, isRoomId, parseCode, type CodeError } from './code.js';
import { tick } from './crdt.js';
import { resolveForward, tagOf } from './identity.js';
import type { Local } from './local.js';
import type { Snapshot } from './model.js';
import { isLive, kindOf, mergeRecords, ownsRoom, recordsIn, roomRecord, type Records } from './records.js';
import { acknowledge, changed, chips, dirty, joinAccount, plan, roomsOf, takeIn, writtenOnce, type Put } from './plan.js';
import { RoomHealth } from './health.js';
import { RoomError, type RoomApi } from './rooms.js';
import { StatusTracker, type ItemChip, type SyncProblem, type SyncState, type SyncStatus } from './status.js';
import {
  adoptAccount, expire, followRoom, forwardDone, joinRoom, leaveRoom, oldestTombstone, placed, purgeDone, purgeRecord, queueForward, roomOf, shareRecord,
  sharedKey, switchAccount, type LocalStore,
} from './store.js';

// The sync engine: the device's store, its account room and the rooms of its shared records, reconciled in the
// background. The domain decides what to merge and what to PUT (plan.ts); this runs rounds against the rooms,
// acknowledges what the server took, backs off when it cannot, and tells the UI how things stand. The app never waits
// on it.

/** A local change is saved this long after changes stop, and never later than MAX_WAIT after the first. */
const DEBOUNCE = 15_000, MAX_WAIT = 60_000;
/** Full scans: every 5 minutes while visible, and on returning after a minute away. */
const FULL_EVERY = 5 * 60_000, AWAY = 60_000;
/** A room with at most this many dirty keys, scanned fully under FULL_EVERY ago, reads just those keys. */
const LIGHT_MAX = 4;
/** Rounds over every room until one moves nothing; bounded, as two devices clobbering each other can keep it busy. */
const MAX_LAPS = 4;
/** Browsers cap the bodies of keepalive requests in flight (64 KiB). */
const KEEPALIVE_BYTES = 60_000;
/** A burst of changes to a fed room's copy is planned once, this long after the first. */
const FEED_DELAY = 150;

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

/** A shared record as its room holds it (merged with this device's copy), and the room it lives in now. */
export interface Shared<R> { key: string; room: string; record: R }

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

/** A live copy of a room the app keeps (a socket's), read instead of scanning the room once it is ready. */
export interface Feed { readonly ready: boolean; readonly kv: ReadonlyMap<string, unknown> }

/** Runs fn while no other tab syncs. */
export type SyncLock = <T>(fn: () => Promise<T>) => Promise<T>;

type Listener<K extends keyof SyncEvents> = (v: SyncEvents[K]) => void;

const without = (o: Snapshot, key: string): Snapshot => { const { [key]: _, ...rest } = o; return rest; };

export class Sync<R, A = undefined> {
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
  private netDown = false;
  /** Account rooms that are the landing of a forward cycle: their own forward is ignored. */
  private cycleHeads = new Set<string>();
  private madeAccount = false;
  private newer = false;
  private savedAt: number | null = null;
  private hiddenAt: number | null = null;
  /** The page-hide flush in flight, outside the pass queue. */
  private flushing: Promise<void> | null = null;
  private feeds = new Map<string, Feed>();
  /** Shares in flight by record key: a second share of a record waits on the first, so the record gets one room. */
  private sharing = new Map<string, Promise<string>>();
  private feedTimers = new Map<string, unknown>();
  private held = false;
  /** An account round was passed over while held. */
  private deferred = false;
  private readonly health: RoomHealth;
  private readonly backoff: Backoff;
  private readonly tracker: StatusTracker;

  constructor(private local: Local<R, A>, private api: RoomApi, private env: SyncEnv, private lock: SyncLock = fn => fn()) {
    this.health = new RoomHealth(() => env.now(), () => local.store.account);
    this.backoff = new Backoff(() => env.random());
    this.tracker = new StatusTracker(() => env.now(), () => this.compute(), () => this.running > 0, st => this.emit('status', st));
    local.on((_next, _prev, source) => {
      this.tracker.touch();
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

  get status(): SyncStatus { return this.tracker.status; }

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
    for (const h of [this.passTimer, this.debounce, this.periodic, ...this.feedTimers.values()]) if (h !== null) this.env.clearTimer(h);
    this.passTimer = this.debounce = this.periodic = null;
    this.feedTimers.clear();
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
    this.backoff.clear();
    this.schedule(0, true, true);
    this.tracker.touch();
  }

  offline(): void { this.tracker.touch(); }

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

  /**
   * While on, passes leave the account room for later (shared rooms still sync), so a realtime session is not slowed
   * by its uploads; turning it off runs what waited.
   */
  hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    if (!on && this.deferred) { this.deferred = false; this.schedule(0); }
  }

  /** A live copy of a room, read in place of scans while it is ready. Returns the detach. */
  attach(room: string, feed: Feed): () => void {
    this.feeds.set(room, feed);
    return () => { if (this.feeds.get(room) === feed) this.feeds.delete(room); };
  }

  /** The fed copy of a room changed (its first snapshot, or a write): it is planned against shortly, a burst once. */
  fed(room: string): void {
    if (this.feedTimers.has(room)) return;
    this.feedTimers.set(room, this.env.setTimer(() => { this.feedTimers.delete(room); void this.feedRound(room); }, FEED_DELAY));
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

  /**
   * Shares the record at key: its room is made on the first share (or when the last one is gone), and everything
   * uploaded. The room id is the invite. Sharing again returns the same room.
   */
  share(key: string): Promise<string> {
    let p = this.sharing.get(key);
    if (!p) {
      p = this.shareOnce(key).finally(() => this.sharing.delete(key));
      this.sharing.set(key, p);
    }
    return p;
  }

  private shareOnce(key: string): Promise<string> {
    const usable = (room: string | null | undefined): room is string => !!room && !this.health.isOut(room);
    return this.op(async () => {
      this.local.reload();
      const s = this.local.store, r = s.records[key];
      if (r === undefined || !ownsRoom(this.m, key) || !isLive(this.m, key, r)) throw new SyncError('notfound');
      let room = roomOf(this.m, s, key);
      if (!usable(room)) {
        const made = await this.api.create();
        // Another tab may have shared the record while the POST was out; its room wins and this one stays empty.
        this.local.reload();
        room = roomOf(this.m, this.local.store, key);
        if (!usable(room)) {
          this.local.edit((st, now) => shareRecord(this.m, st, key, made, now), 'sync');
          this.health.scanned(made, {});
          await this.apply(made, {});
          room = made;
        }
      }
      for (let i = 0; i < MAX_LAPS && this.roomDirty(room); i++) await this.round(room, true);
      if (this.unsaved(room)) throw new SyncError(this.health.isFull(room) ? 'full' : 'failed');
      this.soon();
      return room;
    });
  }

  /** A shared record as its room holds it, for the question before joining. Offline, this device's copy if it has one. */
  async peek(room: string): Promise<Shared<R>> {
    const known = this.byRoom(room);
    try {
      return await this.op(async () => {
        const w = await this.readShared(room);
        const theirs = roomRecord(this.m, w.snapshot, w.key)!, mine = this.local.store.records[w.key];
        const record = mine === undefined ? theirs : mergeRecords(this.m, { [w.key]: mine }, { [w.key]: theirs })[w.key]!;
        return { key: w.key, room: w.room, record };
      });
    } catch (e) {
      if (known && e instanceof SyncError && e.kind === 'offline') return known;
      throw e;
    }
  }

  /**
   * Joins a shared record from its room (an invite): it merges in, syncs with that room from now on, and is backed up
   * with the account. Its key is returned. Offline, a record this device already holds there is joined already.
   */
  async join(room: string): Promise<string> {
    const known = this.byRoom(room);
    try {
      return await this.op(async () => {
        const w = await this.readShared(room);
        let got = 'none' as ReturnType<typeof joinRoom<R, A>>;
        this.local.edit((s, now) => { got = joinRoom(this.m, s, w.room, w.snapshot, now); return typeof got === 'string' ? s : got.store; }, 'sync');
        if (got === 'full') throw new SyncError('full');
        if (got === 'none') throw new SyncError('notfound');
        this.health.scanned(w.room, w.snapshot);
        // The record is this device's now: a failed upload is left to later passes.
        await this.upload(w.room, w.snapshot);
        this.changed();
        return w.key;
      });
    } catch (e) {
      if (known && e instanceof SyncError && e.kind === 'offline') return known.key;
      throw e;
    }
  }

  /**
   * This account stops sharing the record at key, keeping it, live, to itself; the room and its other members carry on
   * without it. Online, what this device owes the room is uploaded first. Works offline.
   */
  async leave(key: string): Promise<void> {
    this.local.reload();
    const room = roomOf(this.m, this.local.store, key);
    if (room === null) return;
    if (this.env.online()) await this.op(() => this.settle(room)).catch(() => {});
    this.local.edit((s, now) => leaveRoom(this.m, s, key, now), 'sync');
    this.changed();
  }

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
        const owed = before && !this.health.lost ? before : null;
        this.local.edit((s, now) => {
          const next = joinAccount(this.m, switchAccount(s, a.room, now, this.m.salt).store, a.snapshot);
          return owed ? queueForward(next, owed) : next;
        }, 'sync');
        this.health.scanned(a.room, a.snapshot);
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
      this.health.scanned(room, {});
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
    const now = this.env.now(), at = Math.max(now + ms, this.backoff.earliest(force));
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
      this.tracker.touch();
      try { return await fn(); } finally { this.running--; this.tracker.touch(); }
    }));
    this.queue = run.catch(() => {});
    return run;
  }

  private async pass(full: boolean): Promise<void> {
    if (this.backoff.paused(this.env.now()) || !this.env.online()) { this.tracker.touch(); return; }
    this.madeAccount = false;
    try {
      this.local.edit((s, now) => expire(this.m, s, now), 'sync');
      await this.ensureAccount();
      let quiet = false;
      for (let lap = 0; lap < MAX_LAPS && !quiet; lap++) {
        quiet = true;
        const done = new Set<string>();
        for (let room = this.next(done); room; room = this.next(done)) {
          done.add(room);
          if (await this.round(room, full && lap === 0)) quiet = false;
        }
      }
      await this.purgeKeys();
      await this.writeForwards();
      this.backoff.clear();
      this.netDown = false;
      if (!dirty(this.m, this.local.store).length) this.savedAt = this.env.now();
    } catch (e) {
      this.failed(e);
    }
  }

  /** After a pass, no longer running: the status settles and a landed backlog is told once. */
  private passed(): void {
    this.tracker.refresh();
    const keys = this.tracker.backlog();
    if (keys.length && !this.madeAccount) this.emit('backlog', { keys, at: this.env.now() });
  }

  /** The account room first (unless held), then shared ones; none the server refuses, nor one gone. */
  private next(done: ReadonlySet<string>): string | null {
    const acc = this.local.store.account;
    return roomsOf(this.m, this.local.store).find(r => {
      if (done.has(r) || this.health.isOut(r)) return false;
      if (r === acc && this.held) { this.deferred = true; return false; }
      return true;
    }) ?? null;
  }

  /** Reads, merges and uploads one room: whether anything moved. */
  private async round(room: string, full: boolean): Promise<boolean> {
    const read = await this.read(room, full);
    return read ? this.apply(room, read.remote, read.keys) : false;
  }

  private async read(room: string, full: boolean): Promise<{ remote: Snapshot; keys?: string[] } | null> {
    const fed = this.fedRead(room);
    if (fed) return fed;
    if (!full && this.env.now() - this.health.scannedAt(room) < FULL_EVERY) {
      const keys = dirty(this.m, this.local.store).filter(p => p.room === room).map(p => p.key);
      if (!keys.length) return null;
      const remote = await this.readKeys(room, keys);
      if (remote) return { remote, keys };
    }
    let remote: Snapshot;
    try { remote = await this.scanRoom(room); } catch (e) {
      if (e instanceof RoomError && (e.status === 404 || e.status === 400)) { this.health.missing(room, e.status); return null; }
      throw e;
    }
    this.health.scanned(room, remote);
    return { remote };
  }

  /**
   * Just these keys, when they are few and the server was last seen holding every one; null when the room must be read
   * whole. A 404 is never taken as absent: an edge cache may keep one from before another device wrote the key, and a
   * PUT on its word would overwrite that device's doc unmerged. Keys not known to be there are not asked for, so no 404
   * is left for the edge to keep.
   */
  private async readKeys(room: string, keys: readonly string[]): Promise<Snapshot | null> {
    const held = this.health.holds(room);
    if (keys.length > LIGHT_MAX || !held || !keys.every(k => held.has(k))) return null;
    const remote: Record<string, unknown> = {};
    for (const k of keys) {
      try { remote[k] = await this.api.get(room, k); } catch (e) {
        if (e instanceof RoomError && e.status === 404) return null;
        throw e;
      }
      this.health.answered(room);
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

  /** Merges a read into the store and uploads what the server lacks: whether anything moved. */
  private async apply(room: string, remote: Snapshot, keys?: string[]): Promise<boolean> {
    // The plan replaces the store whole, so it must start from what another tab may have written during the read.
    this.local.reload();
    const s = this.local.store;
    // The room left sync while it was read (an account switch, a shared record moved).
    if (room !== s.account && !roomsOf(this.m, s).includes(room)) return false;
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
      if (!this.health.takes(put.room, put.key)) continue;
      if (!await this.putOne(put, keepalive)) continue;
      sent++;
      this.netDown = false;
      this.health.wrote(put.room, put.key);
      this.local.edit(s => acknowledge(s, put.room, put.key, put.hash), 'sync');
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
          this.health.refused(put.room);
          return false;
        }
        if (e.status === 404 || e.status === 400) { this.health.missing(put.room, e.status); return false; }
        throw e;
      }
    }
  }

  /** Deletes the oldest tombstone the account room holds, to make room for a new key: whether one went. */
  private async freeSlot(room: string, key: string): Promise<boolean> {
    const held = this.health.holds(room);
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
    if (!room || this.health.lost) return;
    for (const key of Object.keys(this.local.store.purge)) {
      try { await this.api.delete(room, key); } catch (e) {
        if (e instanceof RoomError && (e.status === 404 || e.status === 400)) { this.health.missing(room, e.status); return; }
        throw e;
      }
      this.local.edit(s => purgeDone(s, key), 'sync');
      this.health.deleted(room, key);
    }
  }

  /**
   * The room read is retired: for the account room, this device moves to where its forwards lead and joins the account
   * there; a shared room's records move to the room its forwards lead to.
   */
  private async follow(room: string, remote: Snapshot): Promise<void> {
    const end = await this.forwardsFrom(room, remote);
    if (!end) return;
    if (end.room === room) { this.cycleHeads.add(room); return; }
    if (room !== this.local.store.account) { this.local.edit((s, now) => followRoom(this.m, s, room, end.room, now), 'sync'); return; }
    const prev = this.local.store;
    this.local.edit((s, now) => joinAccount(this.m, switchAccount(s, end.room, now, this.m.salt).store, end.snapshot), 'sync');
    this.tellNews(prev, this.local.store);
    this.health.answered(end.room);
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
   * Rooms this device left get their forward once everything is uploaded where it leads: an account room to the account
   * it syncs now, a shared room to the room its record moved to. Kept in the store until written, so an app killed
   * before then still writes it.
   */
  private async writeForwards(): Promise<void> {
    const s = this.local.store, rooms = new Set(Object.values(placed(this.m, s)).map(r => r.val));
    for (const [from, owed] of Object.entries(s.forwards)) {
      const to = rooms.has(owed) ? owed : s.account;
      if (!to || this.unsaved(to)) continue;
      if (from !== to) {
        try { await this.api.put(from, FORWARD_KEY, forwardDoc(to, tick(this.local.store.clock, this.local.now()))); } catch (e) {
          // A room that is gone, or refused, has nobody left to follow a forward.
          if (!(e instanceof RoomError) || (e.status !== 404 && e.status !== 400)) throw e;
        }
      }
      this.local.edit(st => forwardDone(st, from), 'sync');
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
    if (now < this.backoff.createAt) { this.schedule(this.backoff.createAt - now); return; }
    let room: string;
    try { room = await this.api.create(); } catch (e) {
      if (e instanceof RoomError && e.status === 429) { this.schedule(this.backoff.createRefused(e, now)); return; }
      throw e;
    }
    this.backoff.created();
    // Another tab may have adopted an account while the POST was out; this room then stays empty.
    this.local.reload();
    if (this.local.store.account) return;
    this.local.edit((st, t) => adoptAccount(st, room, t, this.m.salt), 'sync');
    this.health.scanned(room, {});
    this.madeAccount = true;
    this.emit('account', { code: codeFromRoom(room) });
  }

  private failed(e: unknown): void {
    if (!(e instanceof RoomError)) console.warn('sync:', e);
    else if (e.status === 0) this.netDown = true;
    this.schedule(this.backoff.failed(e, this.env.now()));
  }

  /**
   * A room's fed copy as a read of some of its keys: those it holds, and those this device may write that it lacks. A
   * copy may be behind the server, so a key it lacks is never taken as gone, nor a write-once key as unwritten. None
   * for the account room, whose reads also decide what other devices purged, nor while a write-once key this device
   * owes the room is missing from it: that round reads the server.
   */
  private fedRead(room: string): { remote: Snapshot; keys: string[] } | null {
    const feed = this.feeds.get(room), s = this.local.store;
    if (!feed?.ready || room === s.account) return null;
    const remote = Object.fromEntries(feed.kv), once = writtenOnce(this.m, s, room), keys = new Set(Object.keys(remote));
    for (const p of dirty(this.m, s)) {
      if (p.room !== room) continue;
      if (!once(p.key)) keys.add(p.key);
      else if (!feed.kv.has(p.key)) return null;
    }
    return { remote, keys: [...keys] };
  }

  /** A round against a room's fed copy, when a pass could run; another device's changes it brings are owed to the account room. */
  private async feedRound(room: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.started || !this.env.online() || this.backoff.blocked(this.env.now()) || this.health.isOut(room)) return;
      if (!this.feeds.get(room)?.ready || room === this.local.store.account) return;
      const fed = this.fedRead(room), before = this.local.store.records;
      try { await (fed ? this.apply(room, fed.remote, fed.keys) : this.round(room, false)); } catch (e) { this.failed(e); }
      if (room !== this.local.store.account && this.local.store.records !== before) this.changed();
    }).catch(() => {});
  }

  /** Dirty docs, sent without reading first, as keepalive requests the browser finishes after the page is gone. */
  private async flush(): Promise<void> {
    if (!this.env.online() || this.backoff.paused(this.env.now())) return;
    let bytes = 0;
    const puts = dirty(this.m, this.local.store).filter(p => this.health.takes(p.room, p.key)).filter(p => (bytes += JSON.stringify(p.value).length) <= KEEPALIVE_BYTES);
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

  /** A room holding a manifest or any of the app's keys but shared records (a shared room holds only those). */
  private isAccountRoom(snap: Snapshot): boolean {
    return ACCOUNT_KEY in snap || Object.keys(snap).some(k => kindOf(this.m, k) !== null && !ownsRoom(this.m, k));
  }

  private async readAccount(room: string): Promise<{ room: string; snapshot: Snapshot }> {
    const snap = await this.scanRoom(room);
    if (!this.isAccountRoom(snap)) throw new SyncError('notaccount');
    const end = await this.forwardsFrom(room, snap);
    if (!end) throw new SyncError('notfound');
    return end;
  }

  /** A shared room as it is now, past any forwards: the key of its record, and its scan. */
  private async readShared(room: string): Promise<{ room: string; key: string; snapshot: Snapshot }> {
    if (!isRoomId(room)) throw new SyncError('notfound');
    const end = await this.forwardsFrom(room, await this.scanRoom(room));
    const key = end && sharedKey(this.m, end.snapshot, end.room);
    if (!end || !key) throw new SyncError('notfound');
    return { ...end, key };
  }

  /** The shared record this device holds in a room. */
  private byRoom(room: string): Shared<R> | null {
    const s = this.local.store, key = Object.keys(placed(this.m, s)).find(k => roomOf(this.m, s, k) === room);
    return key === undefined ? null : { key, room, record: s.records[key]! };
  }

  /** Keys of the room still to upload that the server can take now. */
  private roomDirty(room: string): boolean { return dirty(this.m, this.local.store).some(p => p.room === room && this.health.takes(p.room, p.key)); }
  /** Keys of the room still to upload, whether or not the server can take them now. */
  private unsaved(room: string): boolean { return dirty(this.m, this.local.store).some(p => p.room === room); }

  private tellNews(prev: LocalStore<R, A>, next: LocalStore<R, A>): void {
    const keys = changed(prev.records, next.records);
    if (keys.length) this.emit('news', { keys });
  }

  // Status.

  private problem(): SyncProblem | null {
    const now = this.env.now();
    if (this.health.lost) return 'lost';
    if (this.health.anyFull || this.backoff.paused(now)) return 'full';
    if (this.backoff.failing && this.env.online()) return 'failing';
    if (!this.local.store.account && now < this.backoff.createAt) return 'rate';
    return null;
  }

  private compute(): SyncStatus {
    const s = this.local.store, problem = this.problem(), c = chips(this.m, s, r => this.health.isOut(r));
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
      retryAt: problem === 'rate' ? this.backoff.createAt : null,
      gone: Object.keys(placed(this.m, s)).filter(k => { const r = roomOf(this.m, s, k); return r !== null && this.health.isGone(r); }).sort(),
    };
  }
}
