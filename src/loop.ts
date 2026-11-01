// The sync loop: when passes run, whether they read every room whole, and the timers that bring them on. Pure: Sync
// sends the events (its triggers, its timers going off, what a pass met), performs the effects and runs the passes.

/** A local change is saved this long after changes stop, and never later than MAX_WAIT after the first. */
const DEBOUNCE = 15_000, MAX_WAIT = 60_000;
/** Full scans: every 5 minutes while visible, and on returning after a minute away. */
export const FULL_EVERY = 5 * 60_000;
const AWAY = 60_000;
/** A burst of changes to a fed room's copy is planned once, this long after the first. */
const FEED_DELAY = 150;

/** The timers the loop arms: the next pass, the debounce, the periodic scan, and a round per fed room. */
export type Timer = 'pass' | 'debounce' | 'periodic' | `feed:${string}`;

const FEED = 'feed:';
export const feedTimer = (room: string): Timer => `${FEED}${room}`;

/**
 * The periodic scan is armed. `pass`: when the next pass is due, if one is. `debounce`: when the first change still
 * waiting to be saved was made, if one is. `feeds`: rooms whose fed copy changed, each with a round due.
 */
export interface Started { kind: 'started'; pass: number | null; debounce: number | null; feeds: ReadonlySet<string> }

/** Stopped: no timers and nothing in the background, though a pass asked for (`sync()`) and the UI operations run. */
export type Run = { kind: 'stopped' } | Started;

/** The app's hold on the account room: `deferred` once a pass has left it for later, so letting go runs a pass. */
export type Hold = 'off' | 'on' | 'deferred';

export interface Loop {
  run: Run;
  /** A full scan is owed: the next pass reads every room whole. Stopping does not settle it. */
  full: boolean;
  /** The last request found no connection, whatever the browser says. */
  down: boolean;
  hold: Hold;
  /** When the page went to the background, while it is there. */
  hiddenAt: number | null;
}

export const initial: Loop = { run: { kind: 'stopped' }, full: false, down: false, hold: 'off', hiddenAt: null };

/** How things stand as an event arrives. */
export interface Moment {
  now: number;
  /** The earliest a pass may run: past a pause, the server's wait and the backoff for the connection. */
  earliest: number;
  /** The same with the backoff for the connection waived. */
  forced: number;
  visible: boolean;
}

export type LoopEvent =
  | { type: 'start' }
  | { type: 'stop' }
  /** A local change, saved once changes stop for a while. */
  | { type: 'changed' }
  /** Worth saving at once. */
  | { type: 'soon' }
  /** The browser says the connection is back. */
  | { type: 'online' }
  | { type: 'hidden' }
  | { type: 'visible' }
  | { type: 'hold'; on: boolean }
  /** A fed room's copy changed. */
  | { type: 'fed'; room: string }
  /** A pass asked for, reading every room whole if `full`. */
  | { type: 'sync'; full: boolean }
  /** A pass ended; `done` if it got through. */
  | { type: 'ran'; full: boolean; done: boolean }
  /** A pass left the account room for later, as held. */
  | { type: 'deferred' }
  /** A pass is wanted ms from now, as the backoff or the server said. */
  | { type: 'retry'; ms: number }
  /** A request got an answer. */
  | { type: 'reached' }
  /** A request found no connection. */
  | { type: 'unreachable' }
  | { type: 'fired'; timer: Timer };

export type LoopEffect =
  /** Sets the timer, in place of the one armed if any; it sends `fired` when it goes off. */
  | { do: 'arm'; timer: Timer; ms: number }
  | { do: 'disarm'; timer: Timer }
  /** A pass, after anything queued. */
  | { do: 'pass'; full: boolean }
  /** A round against a fed room's copy. */
  | { do: 'feed'; room: string }
  /** What is dirty, sent as keepalive requests. */
  | { do: 'flush' };

export interface Step { state: Loop; effects: LoopEffect[] }

const to = (state: Loop, ...effects: LoopEffect[]): Step => ({ state, effects });

export function next(s: Loop, e: LoopEvent, t: Moment): Step {
  const { run } = s;
  switch (e.type) {
    case 'start': {
      if (run.kind === 'started') return to(s);
      const first = want({ ...s, run: { kind: 'started', pass: null, debounce: null, feeds: new Set() } }, t, 0, { full: true });
      return to(first.state, ...first.effects, { do: 'arm', timer: 'periodic', ms: FULL_EVERY });
    }
    case 'stop':
      if (run.kind === 'stopped') return to(s);
      return to({ ...s, run: { kind: 'stopped' } }, ...armed(run).map((timer): LoopEffect => ({ do: 'disarm', timer })));
    case 'changed': {
      // Stopped, the pass that starts the engine saves it.
      if (run.kind === 'stopped') return to(s);
      const first = run.debounce ?? t.now;
      return to({ ...s, run: { ...run, debounce: first } }, { do: 'arm', timer: 'debounce', ms: Math.max(0, Math.min(DEBOUNCE, first + MAX_WAIT - t.now)) });
    }
    case 'soon':
      return want(s, t, 0);
    case 'retry':
      return want(s, t, e.ms);
    case 'online':
      return want(s.down ? { ...s, down: false } : s, t, 0, { full: true, force: true });
    case 'hidden': {
      const hidden = s.hiddenAt === null ? { ...s, hiddenAt: t.now } : s;
      return run.kind === 'stopped' ? to(hidden) : to(hidden, { do: 'flush' });
    }
    case 'visible': {
      const away = s.hiddenAt === null ? 0 : t.now - s.hiddenAt;
      return want(s.hiddenAt === null ? s : { ...s, hiddenAt: null }, t, 0, { full: away >= AWAY });
    }
    case 'hold':
      if (e.on) return to(s.hold === 'off' ? { ...s, hold: 'on' } : s);
      if (s.hold === 'deferred') return want({ ...s, hold: 'off' }, t, 0);
      return to(s.hold === 'on' ? { ...s, hold: 'off' } : s);
    case 'deferred':
      // Only a held pass leaves the account room for later.
      return to(s.hold === 'on' ? { ...s, hold: 'deferred' } : s);
    case 'fed':
      if (run.kind === 'stopped' || run.feeds.has(e.room)) return to(s);
      return to({ ...s, run: { ...run, feeds: new Set(run.feeds).add(e.room) } }, { do: 'arm', timer: feedTimer(e.room), ms: FEED_DELAY });
    case 'sync':
      return pass(s, e.full);
    case 'ran':
      // A full scan cut short is still owed.
      return to(!e.done && e.full && !s.full ? { ...s, full: true } : s);
    case 'reached':
      return to(s.down ? { ...s, down: false } : s);
    case 'unreachable':
      return to(s.down ? s : { ...s, down: true });
    case 'fired':
      return fired(s, e.timer, t);
    default:
      return absurd(e);
  }
}

/** Timers are armed and disarmed as the state says, so one going off that the state does not expect is ignored. */
function fired(s: Loop, timer: Timer, t: Moment): Step {
  const { run } = s;
  if (run.kind === 'stopped') return to(s);
  switch (timer) {
    case 'pass':
      return run.pass === null ? to(s) : pass({ ...s, run: { ...run, pass: null } }, false);
    case 'debounce':
      return run.debounce === null ? to(s) : want({ ...s, run: { ...run, debounce: null } }, t, 0);
    case 'periodic': {
      const scan = t.visible ? want(s, t, 0, { full: true }) : to(s);
      return to(scan.state, ...scan.effects, { do: 'arm', timer: 'periodic', ms: FULL_EVERY });
    }
    default: {
      const room = timer.slice(FEED.length);
      if (!run.feeds.has(room)) return to(s);
      const feeds = new Set(run.feeds);
      feeds.delete(room);
      return to({ ...s, run: { ...run, feeds } }, { do: 'feed', room });
    }
  }
}

/**
 * A pass ms from now, or as soon after as the backoff allows (waiving the backoff for the connection if `force`); a
 * pass due sooner stands. Stopped, only the full scan is owed.
 */
function want(s: Loop, t: Moment, ms: number, o: { full?: boolean; force?: boolean } = {}): Step {
  const owed = o.full && !s.full ? { ...s, full: true } : s, { run } = owed;
  if (run.kind === 'stopped') return to(owed);
  const at = Math.max(t.now + ms, o.force ? t.forced : t.earliest);
  if (run.pass !== null && run.pass <= at) return to(owed);
  return to({ ...owed, run: { ...run, pass: at } }, { do: 'arm', timer: 'pass', ms: at - t.now });
}

/** A pass now, paying any full scan owed. */
const pass = (s: Loop, full: boolean): Step => to(s.full ? { ...s, full: false } : s, { do: 'pass', full: full || s.full });

const armed = (run: Started): Timer[] => [
  ...(run.pass === null ? [] : ['pass' as const]),
  ...(run.debounce === null ? [] : ['debounce' as const]),
  'periodic',
  ...[...run.feeds].map(feedTimer),
];

function absurd(e: never): never {
  throw new Error(`sync loop: unknown event ${JSON.stringify(e)}`);
}
