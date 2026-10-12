import { describe, it, expect } from 'vitest';
import { accountFrom, forwardFrom, isNewer, mergeAccount, mergeForward } from '../src/account.js';
import { MAX_MEMBERS, gsetFrom, isMember, regFrom, regsFrom, winFrom, winsFrom } from '../src/repair.js';

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

describe('reading untrusted JSON', () => {
  it('keeps well-formed members, even unknown ones, and drops the rest without throwing', () => {
    for (const junk of [null, 1, 'x', [], [1, 2]]) {
      expect(gsetFrom(junk)).toEqual({});
      expect(regsFrom(junk, isCount)).toEqual({});
      expect(winsFrom(junk)).toEqual({});
    }
    expect(gsetFrom({ work: 3, 'Bad Tag': 1, home: -2, later: 1.5, 'future-tag': 0 })).toEqual({ 'future-tag': 0, work: 3 });
    expect(regsFrom({ open: { val: 2, t: 4 }, done: { val: -1, t: 4 }, 'Bad Key': { val: 1, t: 1 }, x: { val: 1 } }, isCount)).toEqual({ open: { val: 2, t: 4 } });
    expect(regFrom({ val: 'a', t: 2 }, (v): v is string => typeof v === 'string')).toEqual({ val: 'a', t: 2 });
    expect(regFrom({ val: 'a', t: -1 }, (v): v is string => typeof v === 'string')).toBeNull();
    expect(isMember('a'.repeat(48))).toBe(true);
    expect(isMember('a'.repeat(49))).toBe(false);
  });

  it('bounds a set, whatever a room holds', () => {
    const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`m${i}`, i]));
    expect(Object.keys(gsetFrom(big))).toHaveLength(MAX_MEMBERS);
  });

  it('keeps a win author only when it is a public id', () => {
    expect(winFrom({ at: 5, by: '0123456789abcdef' })).toEqual({ at: 5, by: '0123456789abcdef' });
    expect(winFrom({ at: 5, by: 'someone' })).toEqual({ at: 5 });
    expect(winFrom({ at: 'soon' })).toBeNull();
    expect(winsFrom({ first: { at: 3 }, 'Bad Id': { at: 1 } })).toEqual({ first: { at: 3 } });
  });
});

describe('the account docs', () => {
  const W = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';

  it('read only when sound', () => {
    expect(accountFrom({ pid: '0123456789abcdef', made: 4 })).toEqual({ pid: '0123456789abcdef', made: 4 });
    expect(accountFrom({ pid: 'short', made: 1 })).toBeNull();
    expect(forwardFrom({ to: W, at: 2 })).toEqual({ to: W, at: 2 });
    expect(forwardFrom({ to: 'local-x', at: 1 })).toBeNull();
  });

  it('keep the earliest, whichever side it is on', () => {
    const a = { pid: '0123456789abcdef', made: 5 }, b = { pid: 'fedcba9876543210', made: 3 };
    expect(mergeAccount(a, b)).toBe(b);
    expect(mergeAccount(b, a)).toBe(b);
    const f = { to: W, at: 9 }, g = { to: '11111111-2222-4333-8444-555555555555', at: 9 };
    expect(mergeForward(f, g)).toEqual(mergeForward(g, f));
  });

  it('a doc of a later format is a newer build\'s', () => {
    expect(isNewer({ v: 2 })).toBe(true);
    expect(isNewer({ v: 1 })).toBe(false);
    expect(isNewer({ v: 2 }, 2)).toBe(false);
    expect(isNewer('x')).toBe(false);
  });
});
