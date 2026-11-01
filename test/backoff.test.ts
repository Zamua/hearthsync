import { describe, it, expect } from 'vitest';
import { Backoff, next, open, type Gates, type Outcome } from '../src/backoff.js';
import { RoomError } from '../src/rooms.js';

const T0 = 1_000_000;

/** Applies each outcome in order: the gates after the last, and the wait each one asked for. */
function feed(...outcomes: Outcome[]): { state: Gates; waits: number[] } {
  let state = open;
  const waits: number[] = [];
  for (const o of outcomes) {
    const step = next(state, o);
    state = step.state;
    waits.push(step.wait);
  }
  return { state, waits };
}

const failed = (jitter = 0, at = T0): Outcome => ({ type: 'failed', at, jitter });

describe('backing off for the connection', () => {
  it('waits from 2 s, doubling to 5 minutes, each jittered down by up to half', () => {
    expect(feed(failed(), failed(), failed()).waits).toEqual([1000, 2000, 4000]);
    expect(feed(failed(0.999), failed(0.999)).waits.map(Math.round)).toEqual([1999, 3998]);
    expect(feed(...Array.from({ length: 12 }, () => failed())).waits.at(-1)).toBe(150_000);
  });

  it('counts the failures in a row, until a pass goes through or the connection is back', () => {
    expect(feed(failed(), failed(), failed()).state.retry).toEqual({ kind: 'retrying', failures: 3, until: T0 + 4000 });
    expect(feed(failed(), failed(), { type: 'through' }).state.retry).toEqual({ kind: 'ok' });
    expect(feed(failed(), failed(), { type: 'reconnected' }).state.retry).toEqual({ kind: 'ok' });
  });
});

describe("the server's wait (429)", () => {
  it('lasts its Retry-After, 60 s without one, never past an hour, and leaves the failures counted', () => {
    const rate = (retryAfter: number | null): Outcome => ({ type: 'rate', at: T0, retryAfter });
    expect([rate(120), rate(null), rate(7200)].map(o => next(open, o).wait)).toEqual([120_000, 60_000, 3_600_000]);
    expect(feed(failed(), rate(120)).state).toMatchObject({ waitUntil: T0 + 120_000, retry: { kind: 'retrying', failures: 1 } });
  });

  it('outlasts the connection coming back, and ends with a pass that goes through', () => {
    expect(feed({ type: 'rate', at: T0, retryAfter: 120 }, { type: 'reconnected' }).state.waitUntil).toBe(T0 + 120_000);
    expect(feed({ type: 'rate', at: T0, retryAfter: 120 }, { type: 'through' }).state.waitUntil).toBe(0);
  });
});

describe('the app at its storage ceiling (507)', () => {
  it('pauses every upload 30 minutes; neither a pass through nor the connection back ends it, and failures stay counted', () => {
    const s = feed(failed(), failed(), failed(), { type: 'storage', at: T0 }, { type: 'reconnected' }, { type: 'through' });
    expect(s.waits[3]).toBe(30 * 60_000);
    expect(s.state.pausedUntil).toBe(T0 + 30 * 60_000);
    expect(feed(failed(), failed(), failed(), { type: 'storage', at: T0 }).state.retry).toMatchObject({ failures: 3 });
  });
});

describe("the account room's POST refused (429)", () => {
  const refused = (retryAfter: number | null, at = T0): Outcome => ({ type: 'create-refused', at, retryAfter });

  it('waits at most 5 minutes the first time and in full the next; without a Retry-After, the hour', () => {
    expect(feed(refused(3600), refused(3600)).waits).toEqual([300_000, 3_600_000]);
    expect(feed(refused(null), refused(null)).waits).toEqual([300_000, 3_600_000]);
    expect(feed(refused(120)).waits).toEqual([120_000]);
  });

  it('counts refusals in a row until the room is made, past any other outcome', () => {
    expect(feed(refused(60), { type: 'through' }, { type: 'reconnected' }, refused(60)).state.create).toEqual({ kind: 'limited', hits: 2, until: T0 + 60_000 });
    expect(feed(refused(60), { type: 'created' }, refused(3600)).waits).toEqual([60_000, 0, 300_000]);
  });
});

describe('Backoff', () => {
  it('a pass may run past a pause and the server wait always, and past the backoff unless forced', () => {
    const b = new Backoff(() => 0);
    b.failed(new RoomError(503), T0);
    b.failed(new RoomError(429, 10), T0);
    expect([b.earliest(false), b.earliest(true)]).toEqual([T0 + 10_000, T0 + 10_000]);
    b.failed(new RoomError(0), T0 + 10_000);
    expect([b.earliest(false), b.earliest(true), b.blocked(T0 + 11_000)]).toEqual([T0 + 12_000, T0 + 10_000, true]);
    b.failed(new RoomError(507), T0);
    expect([b.earliest(true), b.paused(T0 + 29 * 60_000), b.paused(T0 + 30 * 60_000)]).toEqual([T0 + 30 * 60_000, true, false]);
  });

  it('uploads count as failing from the third failure in a row', () => {
    const b = new Backoff(() => 0.5);
    b.failed(new RoomError(500), T0);
    b.failed(new RoomError(0), T0);
    expect(b.failing).toBe(false);
    b.failed(new RoomError(502), T0);
    expect(b.failing).toBe(true);
    b.clear();
    expect(b.failing).toBe(false);
  });

  it('the POST may go again once its wait is out, and at once after the room is made', () => {
    const b = new Backoff(() => 0);
    expect(b.createRefused(new RoomError(429, 90), T0)).toBe(90_000);
    expect(b.createAt).toBe(T0 + 90_000);
    b.created();
    expect(b.createAt).toBeLessThanOrEqual(T0);
  });
});
