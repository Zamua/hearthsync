import type { Snapshot } from './model.js';

/**
 * The account room answering 404 across this long, with no answer from it between, is lost. Rooms never expire, so a
 * 404 is almost always a fault on the way, and an edge cache may keep one for minutes.
 */
export const LOST_GAP = 10 * 60_000;

/** Whether the server still has the room, by its 404s: answering, missing since its first 404, or gone for good. */
export type Reach = { kind: 'there' } | { kind: 'missing'; since: number } | { kind: 'gone' };

/**
 * What the engine knows of one room. The four parts change on their own: a room at its cap may 404 or be refused as
 * malformed (a 400 for one key drops the room) and still hold the keys it was last seen with.
 */
export interface RoomState {
  reach: Reach;
  /** Refused as malformed (400): left out of sync for good. */
  malformed: boolean;
  /** At its cap (413): until the next full scan, only keys already there are updated. */
  full: boolean;
  /** The last full scan: when, and the keys the room held then and since; null before any. */
  scan: { at: number; held: ReadonlySet<string> } | null;
}

export type RoomEvent =
  | { type: 'scanned'; keys: readonly string[] }
  /** The room answered: any 404 before was a fault on the way, not a lost room. */
  | { type: 'answered' }
  /** The room took a PUT of key. */
  | { type: 'wrote'; key: string }
  /** The room no longer holds key. */
  | { type: 'deleted'; key: string }
  /** The room refused a new key (413). */
  | { type: 'refused' }
  /** No such room (404). */
  | { type: 'missing' }
  /** Malformed (400). */
  | { type: 'malformed' };

export const unseen: RoomState = { reach: { kind: 'there' }, malformed: false, full: false, scan: null };

const THERE: Reach = { kind: 'there' };
const answered = (s: RoomState): RoomState => (s.reach.kind === 'there' ? s : { ...s, reach: THERE });

export function next(s: RoomState, e: RoomEvent, now: number): RoomState {
  switch (e.type) {
    case 'scanned':
      // Keys deleted elsewhere may have made room: new keys get one more try each full scan.
      return { ...s, reach: THERE, full: false, scan: { at: now, held: new Set(e.keys) } };
    case 'answered':
      return answered(s);
    case 'wrote': {
      const { scan } = s;
      if (!scan || scan.held.has(e.key)) return answered(s);
      // A new key landed: the room has space again.
      return { ...s, reach: THERE, full: false, scan: { at: scan.at, held: new Set(scan.held).add(e.key) } };
    }
    case 'deleted': {
      const { scan } = s;
      if (!scan?.held.has(e.key)) return s.full ? { ...s, full: false } : s;
      const held = new Set(scan.held);
      held.delete(e.key);
      return { ...s, full: false, scan: { at: scan.at, held } };
    }
    case 'refused':
      return s.full ? s : { ...s, full: true };
    case 'missing': {
      const { reach } = s;
      if (reach.kind === 'there') return { ...s, reach: { kind: 'missing', since: now } };
      if (reach.kind === 'missing' && now - reach.since >= LOST_GAP) return { ...s, reach: { kind: 'gone' } };
      return s;
    }
    case 'malformed':
      return s.malformed ? s : { ...s, malformed: true };
    default:
      return absurd(e);
  }
}

function absurd(e: never): never {
  throw new Error(`room health: unknown event ${JSON.stringify(e)}`);
}

/**
 * What the engine knows of each room it syncs with: whether the server still has it, which keys it was last seen
 * holding, and whether it takes new ones. A room's 404s are its own; whether it is the account room only decides
 * how its being gone is told.
 */
export class RoomHealth {
  private rooms = new Map<string, RoomState>();

  constructor(private now: () => number, private account: () => string | null) {}

  private of(room: string): RoomState { return this.rooms.get(room) ?? unseen; }

  private on(room: string, e: RoomEvent): void { this.rooms.set(room, next(this.of(room), e, this.now())); }

  /** The account room is gone for good. */
  get lost(): boolean {
    const acc = this.account();
    return acc !== null && this.of(acc).reach.kind === 'gone';
  }

  get anyFull(): boolean { return [...this.rooms.values()].some(r => r.full); }

  /** A shared room gone for good; the account room, gone, is lost instead, and still synced for when it answers. */
  isGone(room: string): boolean { return room !== this.account() && this.of(room).reach.kind === 'gone'; }

  isFull(room: string): boolean { return this.of(room).full; }

  /** Left out of sync: refused as malformed, or gone. */
  isOut(room: string): boolean { return this.of(room).malformed || this.isGone(room); }

  /** Whether a PUT of key to room can land now. */
  takes(room: string, key: string): boolean {
    const r = this.of(room);
    return !this.isOut(room) && (!r.full || !!r.scan?.held.has(key));
  }

  /** The keys the room held at its last scan, and since; undefined before any scan. */
  holds(room: string): ReadonlySet<string> | undefined { return this.of(room).scan?.held; }

  /** When the room was last read whole. */
  scannedAt(room: string): number { return this.of(room).scan?.at ?? -Infinity; }

  scanned(room: string, snapshot: Snapshot): void { this.on(room, { type: 'scanned', keys: Object.keys(snapshot) }); }

  answered(room: string): void { this.on(room, { type: 'answered' }); }

  wrote(room: string, key: string): void { this.on(room, { type: 'wrote', key }); }

  deleted(room: string, key: string): void { this.on(room, { type: 'deleted', key }); }

  refused(room: string): void { this.on(room, { type: 'refused' }); }

  /** The room answered 404 (no such room) or 400 (malformed). */
  missing(room: string, status: number): void {
    if (status !== 400) { this.on(room, { type: 'missing' }); return; }
    this.on(room, { type: 'malformed' });
    console.warn(`sync: room ${room} refused as malformed; left out of sync`);
  }
}
