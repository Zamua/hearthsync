import { canon } from './crdt.js';
import type { Chip } from './plan.js';

/** A save counts as backlog (worth a notice when it lands) if it waited this long, or while the device could not save. */
const BACKLOG = 2 * 60_000;
/** Mid-pass, the status is refreshed at most this often: each ack would otherwise recount the chips. */
const BUSY_REFRESH = 250;

export type ItemChip = Chip | 'failed';
export type SyncState = 'offline' | 'syncing' | 'saved' | 'error';
/** full: a room or the app hit its cap. lost: the account room is gone. failing: uploads keep failing. rate: no code yet, the server makes no more rooms for now. */
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
  /** Keys of shared records whose room is gone: they sync with the account only, until shared again. */
  gone: string[];
}

/**
 * The status as the UI hears it: recomputed once whatever it reads changes, told only when it reads differently, and
 * how long each record waited to be saved, for the backlog notice.
 */
export class StatusTracker {
  private cached: SyncStatus | null = null;
  private shown = '';
  private queued = false;
  private refreshedAt = -Infinity;
  /** Records not yet saved, by key: since when, and whether the device was offline or failing meanwhile. */
  private pending = new Map<string, { at: number; stuck: boolean }>();
  private landed = new Set<string>();

  constructor(
    private now: () => number, private compute: () => SyncStatus, private busy: () => boolean, private tell: (st: SyncStatus) => void,
  ) {}

  get status(): SyncStatus { return this.cached ??= this.compute(); }

  /** Something the status reads changed. */
  touch(): void {
    this.cached = null;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      // A pass refreshes once at its end.
      if (this.busy() && this.now() - this.refreshedAt < BUSY_REFRESH) return;
      this.refresh();
    });
  }

  refresh(): void {
    this.cached = null;
    const st = this.status, now = this.now(), stuck = st.state === 'offline' || st.state === 'error';
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
    if (text !== this.shown) { this.shown = text; this.tell(st); }
  }

  /** The backlog saved since last asked, by key. */
  backlog(): string[] {
    const keys = [...this.landed].sort();
    this.landed.clear();
    return keys;
  }
}
