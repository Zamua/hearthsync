import type { Snapshot } from './model.js';

/**
 * The account room answering 404 across this long, with no answer from it between, is lost. Rooms never expire, so a
 * 404 is almost always a fault on the way, and an edge cache may keep one for minutes.
 */
export const LOST_GAP = 10 * 60_000;

/**
 * What the engine knows of each room it syncs with: whether the server still has it, which keys it was last seen
 * holding, and whether it takes new ones.
 */
export class RoomHealth {
  /** Rooms answering 404, since when; gone once that spans LOST_GAP. */
  private missingAt = new Map<string, number>();
  private gone = new Set<string>();
  /** Rooms at their cap (413): until the next full scan, only keys already there are updated. */
  private full = new Set<string>();
  /** Rooms the server refuses as malformed (400). */
  private dropped = new Set<string>();
  private scans = new Map<string, number>();
  private held = new Map<string, Set<string>>();

  constructor(private now: () => number, private account: () => string | null) {}

  /** The account room is gone for good. */
  get lost(): boolean {
    const acc = this.account();
    return acc !== null && this.gone.has(acc);
  }

  get anyFull(): boolean { return this.full.size > 0; }

  /** A shared room gone for good; the account room, gone, is lost instead, and still synced for when it answers. */
  isGone(room: string): boolean { return room !== this.account() && this.gone.has(room); }

  isFull(room: string): boolean { return this.full.has(room); }

  /** Left out of sync: refused as malformed, or gone. */
  isOut(room: string): boolean { return this.dropped.has(room) || this.isGone(room); }

  /** Whether a PUT of key to room can land now. */
  takes(room: string, key: string): boolean {
    return !this.isOut(room) && (!this.full.has(room) || !!this.held.get(room)?.has(key));
  }

  /** The keys the room held at its last scan, and since; undefined before any scan. */
  holds(room: string): ReadonlySet<string> | undefined { return this.held.get(room); }

  /** When the room was last read whole. */
  scannedAt(room: string): number { return this.scans.get(room) ?? -Infinity; }

  scanned(room: string, snapshot: Snapshot): void {
    this.scans.set(room, this.now());
    this.held.set(room, new Set(Object.keys(snapshot)));
    // Keys deleted elsewhere may have made room: new keys get one more try each full scan.
    this.full.delete(room);
    this.answered(room);
  }

  /** The room answered: any 404 before was a fault on the way, not a lost room. */
  answered(room: string): void {
    this.missingAt.delete(room);
    this.gone.delete(room);
  }

  /** The room took a PUT of key. */
  wrote(room: string, key: string): void {
    this.answered(room);
    const held = this.held.get(room);
    if (held && !held.has(key)) this.full.delete(room);
    held?.add(key);
  }

  /** The room no longer holds key. */
  deleted(room: string, key: string): void {
    this.held.get(room)?.delete(key);
    this.full.delete(room);
  }

  /** The room refused a new key (413). */
  refused(room: string): void { this.full.add(room); }

  /** The room answered 404 (no such room) or 400 (malformed). */
  missing(room: string, status: number): void {
    if (status === 400) { this.dropped.add(room); console.warn(`sync: room ${room} refused as malformed; left out of sync`); return; }
    const now = this.now(), since = this.missingAt.get(room);
    if (since === undefined) this.missingAt.set(room, now);
    else if (now - since >= LOST_GAP) this.gone.add(room);
  }
}
