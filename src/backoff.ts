import { RoomError } from './rooms.js';

const BACKOFF_MIN = 2000, BACKOFF_MAX = 5 * 60_000, PAUSE_FULL = 30 * 60_000, RATE_MAX = 3600;
/**
 * A rooms server may send its whole rate window (an hour) as Retry-After, though a slot may free much sooner: the first
 * wait is capped at this many seconds for one early retry, and only a second 429 in a row is waited out in full.
 */
const RATE_FIRST = 300;
/** Failures in a row from which uploads count as failing. */
const FAILING = 3;

/** A 429's Retry-After in ms, at most RATE_MAX s; fallback s when it gave none. */
const retryAfter = (e: RoomError, fallback: number): number => Math.min(e.retryAfter ?? fallback, RATE_MAX) * 1000;

/** When the engine may next talk to the rooms server, after what the server last answered. */
export class Backoff {
  private failures = 0;
  private backoffUntil = 0;
  /** A wait the server asked for (429 Retry-After): the connection coming back does not end it. */
  private waitUntil = 0;
  private pausedUntil = 0;
  private createBlockedUntil = 0;
  /** 429s in a row from the account room's POST. */
  private rateHits = 0;

  constructor(private random: () => number) {}

  get failing(): boolean { return this.failures >= FAILING; }

  /** When the account room's POST may go next. */
  get createAt(): number { return this.createBlockedUntil; }

  /** Every upload waits: the app's storage is full. */
  paused(now: number): boolean { return now < this.pausedUntil; }

  /** Paused, backing off, or waiting as the server asked. */
  blocked(now: number): boolean { return now < this.pausedUntil || now < this.backoffUntil || now < this.waitUntil; }

  /** The earliest a pass may run: past a pause and the server's wait, and past any backoff unless forced. */
  earliest(force: boolean): number { return Math.max(force ? 0 : this.backoffUntil, this.waitUntil, this.pausedUntil); }

  /** A pass went through. */
  clear(): void {
    this.reconnected();
    this.waitUntil = 0;
  }

  /** The connection is back: backing off for it is over, a wait the server asked for is not. */
  reconnected(): void {
    this.failures = 0;
    this.backoffUntil = 0;
  }

  /** A pass failed: how long until the next try. */
  failed(e: unknown, now: number): number {
    if (e instanceof RoomError && e.status === 507) { this.pausedUntil = now + PAUSE_FULL; return PAUSE_FULL; }
    if (e instanceof RoomError && e.status === 429) {
      const ms = retryAfter(e, 60);
      this.waitUntil = now + ms;
      return ms;
    }
    this.failures++;
    const ms = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (this.failures - 1)) * (0.5 + this.random() * 0.5);
    this.backoffUntil = now + ms;
    return ms;
  }

  /**
   * The account room's POST was refused (429): how long until it is tried again. Unlike another request's 429
   * (`failed`), a missing Retry-After means the server's whole window, and only a second refusal in a row is waited
   * out in full.
   */
  createRefused(e: RoomError, now: number): number {
    const wait = retryAfter(e, RATE_MAX), ms = this.rateHits++ ? wait : Math.min(wait, RATE_FIRST * 1000);
    this.createBlockedUntil = now + ms;
    return ms;
  }

  created(): void {
    this.createBlockedUntil = 0;
    this.rateHits = 0;
  }
}
