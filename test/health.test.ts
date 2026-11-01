import { describe, it, expect, vi } from 'vitest';
import { LOST_GAP, RoomHealth, next, unseen, type RoomEvent, type RoomState } from '../src/health.js';

const T0 = 1_000_000;

/** Sends each event at its time, from a room never seen. */
const feed = (...events: [RoomEvent, number][]): RoomState => events.reduce((s, [e, t]) => next(s, e, t), unseen);

describe('a room answering 404', () => {
  it('is missing from its first 404, and gone once they span LOST_GAP with no answer between', () => {
    expect(feed([{ type: 'missing' }, T0]).reach).toEqual({ kind: 'missing', since: T0 });
    expect(feed([{ type: 'missing' }, T0], [{ type: 'missing' }, T0 + LOST_GAP - 1]).reach).toEqual({ kind: 'missing', since: T0 });
    expect(feed([{ type: 'missing' }, T0], [{ type: 'missing' }, T0 + LOST_GAP]).reach).toEqual({ kind: 'gone' });
  });

  it('starts over after any answer: a scan, a read, a write', () => {
    for (const answer of [{ type: 'scanned', keys: [] }, { type: 'answered' }, { type: 'wrote', key: 'k' }] as RoomEvent[]) {
      const s = feed([{ type: 'missing' }, T0], [answer, T0 + 1], [{ type: 'missing' }, T0 + LOST_GAP]);
      expect(s.reach).toEqual({ kind: 'missing', since: T0 + LOST_GAP });
    }
  });

  it('gone stays gone through more 404s, a refusal or a delete, and ends only with an answer', () => {
    const gone = feed([{ type: 'missing' }, T0], [{ type: 'missing' }, T0 + LOST_GAP]);
    for (const e of [{ type: 'missing' }, { type: 'refused' }, { type: 'deleted', key: 'k' }] as RoomEvent[]) expect(next(gone, e, T0 + 2 * LOST_GAP).reach.kind).toBe('gone');
    expect(next(gone, { type: 'answered' }, T0 + 2 * LOST_GAP).reach.kind).toBe('there');
  });
});

describe('a room refused as malformed (400)', () => {
  it('is out for good, whatever it answers or holds later', () => {
    const s = feed([{ type: 'malformed' }, T0], [{ type: 'scanned', keys: ['a'] }, T0 + 1], [{ type: 'answered' }, T0 + 2], [{ type: 'wrote', key: 'b' }, T0 + 3]);
    expect(s.malformed).toBe(true);
  });

  it('keeps its own 404 clock, so an account room refused for one key can still be found lost', () => {
    const s = feed([{ type: 'malformed' }, T0], [{ type: 'missing' }, T0], [{ type: 'missing' }, T0 + LOST_GAP]);
    expect(s).toMatchObject({ malformed: true, reach: { kind: 'gone' } });
  });
});

describe('a room at its cap (413)', () => {
  const full = () => feed([{ type: 'scanned', keys: ['a'] }, T0], [{ type: 'refused' }, T0 + 1]);

  it('stays full while keys it holds update, and has space again after a full scan, a new key landing or a delete', () => {
    expect(next(full(), { type: 'wrote', key: 'a' }, T0 + 2).full).toBe(true);
    expect(next(full(), { type: 'scanned', keys: ['a'] }, T0 + 2).full).toBe(false);
    expect(next(full(), { type: 'wrote', key: 'b' }, T0 + 2).full).toBe(false);
    expect(next(full(), { type: 'deleted', key: 'z' }, T0 + 2).full).toBe(false);
  });

  it('still knows the keys it holds while missing or refused as malformed', () => {
    const s = feed([{ type: 'scanned', keys: ['a'] }, T0], [{ type: 'refused' }, T0], [{ type: 'missing' }, T0 + 1], [{ type: 'malformed' }, T0 + 2]);
    expect(s).toMatchObject({ full: true, malformed: true, reach: { kind: 'missing' } });
    expect(s.scan?.held).toEqual(new Set(['a']));
  });
});

describe('the keys a room holds', () => {
  it('are those of its last scan, with the keys written since and without those deleted', () => {
    const s = feed([{ type: 'scanned', keys: ['a', 'b'] }, T0], [{ type: 'wrote', key: 'c' }, T0 + 1], [{ type: 'deleted', key: 'a' }, T0 + 2]);
    expect(s.scan).toEqual({ at: T0, held: new Set(['b', 'c']) });
    expect(feed([{ type: 'wrote', key: 'c' }, T0]).scan).toBeNull();
  });
});

describe('RoomHealth', () => {
  const ACC = 'acc', SHARED = 'shared';
  const health = () => {
    let now = T0, account: string | null = ACC;
    const h = new RoomHealth(() => now, () => account);
    return { h, at: (t: number) => { now = t; }, switchTo: (room: string) => { account = room; } };
  };
  const goneAt = (h: RoomHealth, room: string, at: (t: number) => void) => {
    at(T0);
    h.missing(room, 404);
    at(T0 + LOST_GAP);
    h.missing(room, 404);
  };

  it('the account room gone is lost and still synced; a shared room gone is out of sync and told as gone', () => {
    const { h, at } = health();
    goneAt(h, ACC, at);
    goneAt(h, SHARED, at);
    expect([h.lost, h.isGone(ACC), h.isOut(ACC)]).toEqual([true, false, false]);
    expect([h.isGone(SHARED), h.isOut(SHARED), h.takes(SHARED, 'k')]).toEqual([true, true, false]);
  });

  it("lost follows the account: a switch to another room is not lost, and that room's 404s start their own clock", () => {
    const { h, at, switchTo } = health();
    at(T0);
    h.missing(ACC, 404);
    switchTo('next');
    at(T0 + LOST_GAP);
    h.missing('next', 404);
    expect(h.lost).toBe(false);
    at(T0 + 2 * LOST_GAP);
    h.missing('next', 404);
    expect(h.lost).toBe(true);
  });

  it('a full room takes only the keys it holds; one never scanned takes none', () => {
    const { h } = health();
    h.scanned(SHARED, { a: 1 });
    h.refused(SHARED);
    h.refused('unscanned');
    expect([h.takes(SHARED, 'a'), h.takes(SHARED, 'b'), h.takes('unscanned', 'a'), h.anyFull]).toEqual([true, false, false, true]);
  });

  it('a 400 leaves the room out of sync without its being gone', () => {
    const { h } = health(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.missing(SHARED, 400);
    expect([h.isOut(SHARED), h.isGone(SHARED)]).toEqual([true, false]);
    warn.mockRestore();
  });
});
