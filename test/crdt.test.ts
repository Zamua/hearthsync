import { describe, it, expect } from 'vitest';
import { canon, gsetAdd, gsetList, gsetMerge, hash, lww, lwwOpt, regsMerge, tick, winMerge, winsList, winsMerge, type GSet, type Win } from '../src/crdt.js';
import { makeRng } from '../src/rng.js';
import { randomGSet, randomReg, randomRegs, randomWin, randomWins } from '../src/testing/random.js';
import { laws } from './laws.js';

const TAGS = ['work', 'home', 'urgent', 'later', 'ideas', 'reading', 'travel', 'future-tag'];
const MILESTONES = ['first-note', 'ten-notes', 'week-streak', 'shared', 'archived', 'imported'];
const COUNTERS = ['open', 'done', 'archived', 'future-count'];

describe('canonical JSON and hashes', () => {
  it('sorts object keys at every depth, keeps array order and drops undefined members', () => {
    expect(canon({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
    expect(hash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('merges are commutative, associative and idempotent', () => {
  it('last edit wins, ties broken by the value', () => laws(r => randomReg(r, ['a', 'b', 'c']), lww));
  it('an optional register', () => laws(r => (r.next() < 0.3 ? undefined : randomReg(r, [1, 2])), lwwOpt));
  it('grow-only sets', () => laws(r => randomGSet(r, TAGS), gsetMerge));
  it('wins', () => { laws(randomWin, winMerge); laws(r => randomWins(r, MILESTONES), winsMerge); });
  it('maps of registers', () => laws(r => randomRegs(r, COUNTERS, [0, 1, 2]), regsMerge));
});

describe('maps of registers', () => {
  it('merge each key on its own and keep keys held on one side only', () => {
    const a = { open: { val: 0, t: 5 }, done: { val: 2, t: 1 } }, b = { open: { val: 3, t: 2 }, archived: { val: 1, t: 4 } };
    expect(regsMerge(a, b)).toEqual({ archived: { val: 1, t: 4 }, done: { val: 2, t: 1 }, open: { val: 0, t: 5 } });
    expect(Object.keys(regsMerge(b, a))).toEqual(['archived', 'done', 'open']);
  });
});

describe('grow-only sets', () => {
  it('never lose a member, and keep the earliest stamp', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 300; i++) {
      const a = randomGSet(rng, TAGS), b = randomGSet(rng, TAGS), m = gsetMerge(a, b);
      for (const [k, t] of [...Object.entries(a), ...Object.entries(b)]) expect(m[k]).toBeLessThanOrEqual(t);
      expect(Object.keys(m).sort()).toEqual([...new Set([...Object.keys(a), ...Object.keys(b)])].sort());
    }
  });

  it('list in the order first added, then by id', () => {
    const s: GSet = { urgent: 2, work: 1, home: 1, later: 90 };
    expect(gsetList(s)).toEqual(['home', 'work', 'urgent', 'later']);
  });

  it('adding only what is new; the same set back when nothing is', () => {
    const s: GSet = { work: 1 };
    expect(gsetAdd(s, ['work'], 5)).toBe(s);
    expect(gsetAdd(s, ['work', 'home'], 5)).toEqual({ home: 5, work: 1 });
  });
});

describe('wins', () => {
  it('keep the earliest strong win and its author; a weak one only fills a gap', () => {
    const early: Win = { at: 5, by: 'fedcba9876543210' }, late: Win = { at: 9, by: '0123456789abcdef' }, weak: Win = { at: 0 };
    expect(winMerge(late, early)).toEqual(early);
    expect(winMerge(weak, late)).toEqual(late);
    expect(winMerge(weak, weak)).toEqual(weak);
    expect(winsMerge({ shared: weak }, { shared: late, imported: weak })).toEqual({ imported: weak, shared: late });
  });

  it('list in the order won, weak ones last', () => {
    expect(winsList({ shared: { at: 0 }, streak: { at: 7 }, first: { at: 3 }, imported: { at: 0 } })).toEqual(['first', 'streak', 'imported', 'shared']);
  });

  it('never lose one', () => {
    const rng = makeRng(4);
    for (let i = 0; i < 300; i++) {
      const a = randomWins(rng, MILESTONES), b = randomWins(rng, MILESTONES);
      expect(Object.keys(winsMerge(a, b)).sort()).toEqual(MILESTONES.filter(x => x in a || x in b).sort());
    }
  });
});

describe('the clock', () => {
  it('never runs behind the wall clock, and always passes everything seen', () => {
    expect(tick(0, 1000.7)).toBe(1000);
    expect(tick(5000, 1000)).toBe(5001);
    expect(tick(1000, 1000)).toBe(1001);
  });
});
