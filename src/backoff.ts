import { RoomError } from './rooms.js';

const BACKOFF_MIN = 2000, BACKOFF_MAX = 5 * 60_000, PAUSE_FULL = 30 * 60_000, RATE_MAX = 3600;
/**
 * A rooms server may send its whole rate window (an hour) as Retry-After, though a slot may free much sooner: the first
 * wait is capped at this many seconds for one early retry, and only a second 429 in a row is waited out in full.
 */
const RATE_FIRST = 300;
/** Failures in a row from which uploads count as failing. */
const FAILING = 3;

/** A Retry-After in ms, at most RATE_MAX s; fallback s when there was none. */
const retryAfter = (s: number | null, fallback: number): number => Math.min(s ?? fallback, RATE_MAX) * 1000;

/** Backing off for the connection: requests failing in a row (no connection, or the server erring), until a time. */
export type Retry = { kind: 'ok' } | { kind: 'retrying'; failures: number; until: number };

/** The account room's POST: open, or refused (429) `hits` times in a row and waiting until a time. */
export type CreateLimit = { kind: 'open' } | { kind: 'limited'; hits: number; until: number };

/**
 * When the engine may next talk to the rooms server. The parts change on their own: a pause or the server's wait leaves
 * the failures counted, and the account room's POST is limited apart from every other request.
 */
export interface Gates {
  retry: Retry;
  /** The server's wait (429 Retry-After), until then: the connection coming back does not end it. */
  waitUntil: number;
  /** Every upload waits until then: the app's storage is full (507). */
  pausedUntil: number;
  create: CreateLimit;
}

export type Outcome =
  /** A pass went through. */
  | { type: 'through' }
  /** The connection is back. */
  | { type: 'reconnected' }
  /** A request found no connection or a server erring; `jitter`, in [0, 1), spreads the wait. */
  | { type: 'failed'; at: number; jitter: number }
  /** The server asked to wait (429) for `retryAfter` s, if it said. */
  | { type: 'rate'; at: number; retryAfter: number | null }
  /** The app's storage is full (507). */
  | { type: 'storage'; at: number }
  /** The account room's POST was refused (429). */
  | { type: 'create-refused'; at: number; retryAfter: number | null }
  | { type: 'created' };

export const open: Gates = { retry: { kind: 'ok' }, waitUntil: 0, pausedUntil: 0, create: { kind: 'open' } };

const OK: Retry = { kind: 'ok' };

/** The gates after an outcome, and how long it makes the next try wait (0 for one that ends a wait). */
export function next(g: Gates, o: Outcome): { state: Gates; wait: number } {
  switch (o.type) {
    case 'through':
      return { state: { ...g, retry: OK, waitUntil: 0 }, wait: 0 };
    case 'reconnected':
      return { state: { ...g, retry: OK }, wait: 0 };
    case 'failed': {
      const failures = (g.retry.kind === 'retrying' ? g.retry.failures : 0) + 1;
      const ms = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (failures - 1)) * (0.5 + o.jitter * 0.5);
      return { state: { ...g, retry: { kind: 'retrying', failures, until: o.at + ms } }, wait: ms };
    }
    case 'rate': {
      const ms = retryAfter(o.retryAfter, 60);
      return { state: { ...g, waitUntil: o.at + ms }, wait: ms };
    }
    case 'storage':
      return { state: { ...g, pausedUntil: o.at + PAUSE_FULL }, wait: PAUSE_FULL };
    case 'create-refused': {
      // Unlike another request's 429, no Retry-After means the server's whole window.
      const hits = g.create.kind === 'limited' ? g.create.hits : 0, asked = retryAfter(o.retryAfter, RATE_MAX);
      const ms = hits ? asked : Math.min(asked, RATE_FIRST * 1000);
      return { state: { ...g, create: { kind: 'limited', hits: hits + 1, until: o.at + ms } }, wait: ms };
    }
    case 'created':
      return { state: { ...g, create: { kind: 'open' } }, wait: 0 };
    default:
      return absurd(o);
  }
}

function absurd(o: never): never {
  throw new Error(`backoff: unknown outcome ${JSON.stringify(o)}`);
}

const retryUntil = (r: Retry): number => (r.kind === 'retrying' ? r.until : 0);

/** When the engine may next talk to the rooms server, after what the server last answered. */
export class Backoff {
  private gates = open;

  constructor(private random: () => number) {}

  get failing(): boolean { return this.gates.retry.kind === 'retrying' && this.gates.retry.failures >= FAILING; }

  /** When the account room's POST may go next. */
  get createAt(): number { return this.gates.create.kind === 'limited' ? this.gates.create.until : 0; }

  /** Every upload waits: the app's storage is full. */
  paused(now: number): boolean { return now < this.gates.pausedUntil; }

  /** Paused, backing off, or waiting as the server asked. */
  blocked(now: number): boolean { return now < this.gates.pausedUntil || now < retryUntil(this.gates.retry) || now < this.gates.waitUntil; }

  /** The earliest a pass may run: past a pause and the server's wait, and past any backoff unless forced. */
  earliest(force: boolean): number {
    const g = this.gates;
    return Math.max(force ? 0 : retryUntil(g.retry), g.waitUntil, g.pausedUntil);
  }

  /** A pass went through. */
  clear(): void { this.on({ type: 'through' }); }

  /** The connection is back: backing off for it is over, a wait the server asked for is not. */
  reconnected(): void { this.on({ type: 'reconnected' }); }

  /** A pass failed: how long until the next try. */
  failed(e: unknown, now: number): number {
    if (e instanceof RoomError && e.status === 507) return this.on({ type: 'storage', at: now });
    if (e instanceof RoomError && e.status === 429) return this.on({ type: 'rate', at: now, retryAfter: e.retryAfter });
    return this.on({ type: 'failed', at: now, jitter: this.random() });
  }

  /** The account room's POST was refused (429): how long until it is tried again. */
  createRefused(e: RoomError, now: number): number { return this.on({ type: 'create-refused', at: now, retryAfter: e.retryAfter }); }

  created(): void { this.on({ type: 'created' }); }

  private on(o: Outcome): number {
    const { state, wait } = next(this.gates, o);
    this.gates = state;
    return wait;
  }
}
