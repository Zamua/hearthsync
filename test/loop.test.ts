import { describe, it, expect } from 'vitest';
import { FULL_EVERY, feedTimer, initial, next, type Loop, type LoopEffect, type LoopEvent, type Moment, type Timer } from '../src/loop.js';

const T0 = 1_000_000;
/** At now, with nothing holding a pass back and the page visible. */
const at = (now: number, o: Partial<Moment> = {}): Moment => ({ now, earliest: 0, forced: 0, visible: true, ...o });

/** Sends each event at its moment: the state after the last, and the effects of each in order. */
function feed(s: Loop, ...events: [LoopEvent, Moment][]): { state: Loop; effects: LoopEffect[][] } {
  const effects: LoopEffect[][] = [];
  for (const [e, t] of events) {
    const step = next(s, e, t);
    s = step.state;
    effects.push(step.effects);
  }
  return { state: s, effects };
}

/** Started at T0, its first pass run: nothing due, nothing owed. */
const idle = (): Loop => feed(initial, [{ type: 'start' }, at(T0)], [{ type: 'fired', timer: 'pass' }, at(T0)]).state;

const arm = (timer: Timer, ms: number): LoopEffect => ({ do: 'arm', timer, ms });
/** The same effects, in any order. */
const sameEffects = (got: LoopEffect[] | undefined, want: LoopEffect[]) => {
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
};

describe('starting and stopping', () => {
  it('start arms the periodic scan and a full pass at once, past any backoff', () => {
    const r = next(initial, { type: 'start' }, at(T0, { earliest: T0 + 5000 }));
    sameEffects(r.effects, [arm('pass', 5000), arm('periodic', FULL_EVERY)]);
    expect(r.state).toMatchObject({ run: { kind: 'started', pass: T0 + 5000, debounce: null }, full: true });
  });

  it('a second start changes nothing', () => {
    const s = idle(), r = next(s, { type: 'start' }, at(T0 + 1));
    expect(r).toEqual({ state: s, effects: [] });
  });

  it('stop disarms every timer armed and keeps the facts: the connection, the hold, the page, a full scan owed', () => {
    const r = feed(idle(),
      [{ type: 'changed' }, at(T0)], [{ type: 'fed', room: 'r' }, at(T0)], [{ type: 'retry', ms: 2000 }, at(T0)],
      [{ type: 'unreachable' }, at(T0)], [{ type: 'hold', on: true }, at(T0)], [{ type: 'hidden' }, at(T0)],
      [{ type: 'ran', full: true, done: false }, at(T0)], [{ type: 'stop' }, at(T0 + 1)]);
    sameEffects(r.effects.at(-1), (['pass', 'debounce', 'periodic', feedTimer('r')] as const).map(timer => ({ do: 'disarm', timer })));
    expect(r.state).toEqual({ run: { kind: 'stopped' }, full: true, down: true, hold: 'on', hiddenAt: T0 });
  });

  it('stop then start begins afresh: the first change after it waits the whole debounce', () => {
    const r = feed(idle(),
      [{ type: 'changed' }, at(T0)], [{ type: 'fed', room: 'r' }, at(T0)], [{ type: 'stop' }, at(T0 + 10_000)],
      [{ type: 'start' }, at(T0 + 3 * 60_000)], [{ type: 'changed' }, at(T0 + 3 * 60_000)]);
    expect(r.effects.at(-1)).toEqual([arm('debounce', 15_000)]);
    expect(r.state.run).toEqual({ kind: 'started', pass: T0 + 3 * 60_000, debounce: T0 + 3 * 60_000, feeds: new Set() });
  });

  it('stopped, nothing is armed and nothing goes in the background', () => {
    for (const e of [{ type: 'changed' }, { type: 'soon' }, { type: 'retry', ms: 1000 }, { type: 'fed', room: 'r' }, { type: 'hidden' }, { type: 'stop' }] as LoopEvent[]) {
      expect(next(initial, e, at(T0)).effects).toEqual([]);
    }
  });

  it('stopped, a pass asked for still runs, paying the full scan the connection coming back owed', () => {
    const r = feed(initial, [{ type: 'online' }, at(T0)], [{ type: 'sync', full: false }, at(T0)], [{ type: 'sync', full: false }, at(T0)]);
    expect(r.effects).toEqual([[], [{ do: 'pass', full: true, due: false }], [{ do: 'pass', full: false, due: false }]]);
  });
});

describe('the debounce', () => {
  it('each change saves 15 s after the last, and never past a minute after the first', () => {
    const r = feed(idle(),
      [{ type: 'changed' }, at(T0)], [{ type: 'changed' }, at(T0 + 10_000)], [{ type: 'changed' }, at(T0 + 50_000)], [{ type: 'changed' }, at(T0 + 70_000)]);
    expect(r.effects).toEqual([[arm('debounce', 15_000)], [arm('debounce', 15_000)], [arm('debounce', 10_000)], [arm('debounce', 0)]]);
  });

  it('settling wants a pass at once, and the next change starts a new debounce', () => {
    const r = feed(idle(), [{ type: 'changed' }, at(T0)], [{ type: 'fired', timer: 'debounce' }, at(T0 + 15_000)], [{ type: 'changed' }, at(T0 + 80_000)]);
    expect(r.effects).toEqual([[arm('debounce', 15_000)], [arm('pass', 0)], [arm('debounce', 15_000)]]);
  });
});

describe('passes', () => {
  it("a timer's pass pays the full scan owed, once, and is marked due so it still keeps to the backoff", () => {
    const r = feed(initial, [{ type: 'start' }, at(T0)], [{ type: 'fired', timer: 'pass' }, at(T0)], [{ type: 'sync', full: false }, at(T0)]);
    expect(r.effects.slice(1)).toEqual([[{ do: 'pass', full: true, due: true }], [{ do: 'pass', full: false, due: false }]]);
    expect(r.state.run).toMatchObject({ pass: null });
  });

  it('a full scan cut short is owed again; one that got through, or a light one, is not', () => {
    const owed = (e: LoopEvent) => next(idle(), e, at(T0)).state.full;
    expect(owed({ type: 'ran', full: true, done: false })).toBe(true);
    expect(owed({ type: 'ran', full: true, done: true })).toBe(false);
    expect(owed({ type: 'ran', full: false, done: false })).toBe(false);
  });

  it('a pass due sooner stands; one wanted sooner takes the place of a later one', () => {
    const r = feed(idle(), [{ type: 'retry', ms: 5000 }, at(T0)], [{ type: 'retry', ms: 8000 }, at(T0)], [{ type: 'soon' }, at(T0 + 1000)]);
    expect(r.effects).toEqual([[arm('pass', 5000)], [], [arm('pass', 0)]]);
    expect(r.state.run).toMatchObject({ pass: T0 + 1000 });
  });

  it("the backoff holds a pass back; the connection coming back waives the connection's, not the server's wait", () => {
    const held = at(T0, { earliest: T0 + 8000, forced: T0 + 3000 });
    const r = feed(idle(), [{ type: 'unreachable' }, held], [{ type: 'soon' }, held], [{ type: 'online' }, held]);
    expect(r.effects.slice(1)).toEqual([[arm('pass', 8000)], [arm('pass', 3000)]]);
    expect(r.state).toMatchObject({ down: false, full: true, run: { pass: T0 + 3000 } });
  });
});

describe('the connection', () => {
  it('a request finding no connection marks it down until one gets an answer, or the browser says it is back', () => {
    const down = next(idle(), { type: 'unreachable' }, at(T0)).state;
    expect(down.down).toBe(true);
    expect(next(down, { type: 'unreachable' }, at(T0)).state).toBe(down);
    expect(next(down, { type: 'reached' }, at(T0)).state.down).toBe(false);
    expect(next(down, { type: 'online' }, at(T0)).state.down).toBe(false);
  });
});

describe('the page', () => {
  it('hiding flushes each time and keeps when it first went', () => {
    const r = feed(idle(), [{ type: 'hidden' }, at(T0 + 1)], [{ type: 'hidden' }, at(T0 + 2)]);
    expect(r.effects).toEqual([[{ do: 'flush' }], [{ do: 'flush' }]]);
    expect(r.state.hiddenAt).toBe(T0 + 1);
  });

  it('back after a minute away, the pass reads every room whole; sooner, or never hidden, it reads light', () => {
    const back = (away: number) => feed(idle(), [{ type: 'hidden' }, at(T0)], [{ type: 'visible' }, at(T0 + away)]).state;
    expect(back(60_000)).toMatchObject({ full: true, hiddenAt: null, run: { pass: T0 + 60_000 } });
    expect(back(59_999)).toMatchObject({ full: false, hiddenAt: null, run: { pass: T0 + 59_999 } });
    expect(next(idle(), { type: 'visible' }, at(T0)).state).toMatchObject({ full: false, run: { pass: T0 } });
  });

  it('the periodic scan reads every room whole while visible, and only arms itself again while hidden', () => {
    const tick = (visible: boolean) => next(idle(), { type: 'fired', timer: 'periodic' }, at(T0, { visible }));
    sameEffects(tick(true).effects, [arm('pass', 0), arm('periodic', FULL_EVERY)]);
    expect(tick(true).state.full).toBe(true);
    expect(tick(false).effects).toEqual([arm('periodic', FULL_EVERY)]);
    expect(tick(false).state.full).toBe(false);
  });
});

describe('the hold', () => {
  it('letting go runs a pass only if a held pass left the account room for later', () => {
    const r = feed(idle(),
      [{ type: 'hold', on: true }, at(T0)], [{ type: 'hold', on: false }, at(T0)],
      [{ type: 'hold', on: true }, at(T0)], [{ type: 'deferred' }, at(T0)], [{ type: 'hold', on: false }, at(T0 + 1)]);
    expect(r.effects).toEqual([[], [], [], [], [arm('pass', 0)]]);
    expect(r.state.hold).toBe('off');
  });

  it('a deferral without a hold is ignored, and holding again changes nothing', () => {
    const s = idle();
    expect(next(s, { type: 'deferred' }, at(T0)).state).toBe(s);
    const held = next(s, { type: 'hold', on: true }, at(T0)).state, deferred = next(held, { type: 'deferred' }, at(T0)).state;
    expect(next(held, { type: 'hold', on: true }, at(T0)).state).toBe(held);
    expect(next(deferred, { type: 'hold', on: true }, at(T0)).state).toBe(deferred);
    expect(next(deferred, { type: 'deferred' }, at(T0)).state).toBe(deferred);
  });
});

describe('fed rooms', () => {
  it('a burst arms one round per room, and its round lets the next burst in', () => {
    const r = feed(idle(),
      [{ type: 'fed', room: 'r' }, at(T0)], [{ type: 'fed', room: 'r' }, at(T0 + 50)], [{ type: 'fed', room: 'q' }, at(T0 + 50)],
      [{ type: 'fired', timer: feedTimer('r') }, at(T0 + 150)], [{ type: 'fed', room: 'r' }, at(T0 + 160)]);
    expect(r.effects).toEqual([[arm(feedTimer('r'), 150)], [], [arm(feedTimer('q'), 150)], [{ do: 'feed', room: 'r' }], [arm(feedTimer('r'), 150)]]);
  });
});

describe('a timer the state does not expect', () => {
  it('is ignored', () => {
    const s = idle();
    for (const timer of ['pass', 'debounce', feedTimer('r')] as const) expect(next(s, { type: 'fired', timer }, at(T0)).state).toBe(s);
    for (const timer of ['pass', 'debounce', 'periodic', feedTimer('r')] as const) expect(next(initial, { type: 'fired', timer }, at(T0))).toEqual({ state: initial, effects: [] });
  });
});

describe('the backoff', () => {
  it('a pass asked for while another was failing waits out the backoff that failure set', () => {
    // a change made while the pass runs arms the next pass at once; the pass then fails and backs off 2 s
    const { state, effects } = feed(idle(), [{ type: 'soon' }, at(T0 + 10)], [{ type: 'retry', ms: 2000 }, at(T0 + 20, { earliest: T0 + 2020 })]);
    expect(effects[1]).toEqual([arm('pass', 2000)]);
    expect(state.run).toMatchObject({ pass: T0 + 2020 });
  });
});
