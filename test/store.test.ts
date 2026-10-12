import { describe, it, expect } from 'vitest';
import { publicId } from '../src/identity.js';
import { adoptAccount, editRecords, emptyStore, forwardDone, importRecords, moved, putRecord, queueForward, switchAccount, type LocalStore } from '../src/store.js';
import { cellsOf, newPuzzle, notes, notesOf, puzzles, slotKey, solve, startOver, tagNote, writeNote, type Note, type Puzzle } from './models.js';

const R = '11111111-2222-4333-8444-555555555555', W = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';
const P1 = { run: 0, game: 'g1' };

describe('records in the store', () => {
  it('a save stamps through the clock, and changes nothing when nothing changed', () => {
    const s = writeNote(emptyStore<Note>(), 'a', 'milk', 1000);
    expect([notesOf(s), s.clock]).toEqual([{ a: { text: 'milk', tags: [] } }, 1000]);
    expect(writeNote(s, 'a', 'milk', 2000)).toBe(s);
    expect(writeNote(s, 'a', 'eggs', 10).records['note/a']!.text).toEqual({ val: 'eggs', t: 1001 });
  });

  it('keeps tags in the order added', () => {
    let s = tagNote(emptyStore<Note>(), 'a', 'work', 1000);
    s = tagNote(tagNote(s, 'a', 'urgent', 2000), 'a', 'work', 3000);
    expect(notesOf(s).a!.tags).toEqual(['work', 'urgent']);
  });

  it('refuses a key that is not the model\'s', () => {
    expect(() => putRecord(notes, emptyStore<Note>(), 'meta', 1, (_h, t) => ({ id: 'x', text: { val: '', t }, tags: {} }))).toThrow();
  });

  it('an edit of the records takes the next stamp, or leaves the store as it was', () => {
    const s = emptyStore<Note>();
    expect(editRecords(s, 50, r => r)).toBe(s);
    expect(editRecords(s, 50, (r, t) => ({ ...r, 'note/x': { id: 'x', text: { val: 'hi', t }, tags: {} } })).clock).toBe(50);
  });

  it('records from before sync merge in, never past a newer edit, and a record of another playthrough stays out', () => {
    const s = writeNote(emptyStore<Note>(), 'a', 'new', 1000);
    const old = { 'note/a': { id: 'a', text: { val: 'old', t: 1 }, tags: { work: 1 } }, 'note/b': { id: 'b', text: { val: 'kept', t: 1 }, tags: {} } };
    expect(notesOf(importRecords(notes, s, old))).toEqual({ a: { text: 'new', tags: ['work'] }, b: { text: 'kept', tags: [] } });
    const p = solve(emptyStore<Puzzle>(), 1, P1, 'a1', 3, 1000).store;
    const other = { [slotKey(1)]: { ...newPuzzle({ run: 4, game: 'g9' }, 1), cells: { z9: 1 } } };
    expect(importRecords(puzzles, p, other)).toBe(p);
  });
});

describe('playthroughs', () => {
  it('a session saves its own playthrough, and starting over replaces the slot with the next run', () => {
    let s = solve(emptyStore<Puzzle>(), 1, P1, 'a1', 3, 1000).store;
    s = solve(s, 1, P1, 'b2', 5, 2000).store;
    expect([cellsOf(s, 1), s.records[slotKey(1)]!.score.val]).toEqual([['a1', 'b2'], 5]);
    s = startOver(s, 1, 'g2', 3000);
    expect([s.records[slotKey(1)]!.run, cellsOf(s, 1)]).toEqual([1, []]);
  });

  it("a session's save of a playthrough the store no longer holds is refused as moved, not merged", () => {
    const s0 = solve(emptyStore<Puzzle>(), 1, P1, 'a1', 3, 1000).store;
    // A link brought in the account's own playthrough, of a lower run than the one this session plays.
    const linked: LocalStore<Puzzle> = { ...s0, records: { [slotKey(1)]: { ...newPuzzle({ run: 0, game: 'acct' }, 900), cells: { c3: 900 } } } };
    const late = { ...P1, run: 7 };
    expect(moved(puzzles, linked, slotKey(1), late)).toBe(true);
    const r = solve(linked, 1, late, 'z9', 99, 2000);
    expect(r.result).toBe('moved');
    expect(r.store).toBe(linked);
    expect(cellsOf(r.store, 1)).toEqual(['c3']);
    expect(solve(linked, 1, { run: 0, game: 'acct' }, 'd4', 1, 2000).result).toBe('saved');
    expect(solve(linked, 2, late, 'z9', 1, 2000).result).toBe('saved');
  });

  it('slots are separate records: each keeps its own playthrough', () => {
    let s = solve(emptyStore<Puzzle>(), 1, P1, 'a1', 1, 1000).store;
    s = solve(s, 2, { run: 0, game: 'g2' }, 'b1', 2, 1100).store;
    s = startOver(s, 2, 'g3', 1200);
    expect([s.records[slotKey(1)]!.game, s.records[slotKey(2)]!.game, cellsOf(s, 1)]).toEqual(['g1', 'g3', ['a1']]);
    expect(solve(s, 2, { run: 0, game: 'g2' }, 'b2', 2, 1300).result).toBe('moved');
  });
});

describe('the account', () => {
  it('adopts the first room the server made, and only that one', () => {
    const s = adoptAccount(emptyStore<Note>(), R, 1000, notes.salt);
    expect(s.account).toBe(R);
    expect(s.profile).toEqual({ pid: publicId(R, 'notes/public/'), made: 1000 });
    expect(adoptAccount(s, W, 2000, notes.salt)).toBe(s);
    expect(adoptAccount(emptyStore<Note>(), 'local-x', 1, notes.salt)).toEqual(emptyStore());
  });

  it('switching to a code keeps the records on this device and names the room left behind', () => {
    const s = adoptAccount(writeNote(emptyStore<Note>(), 'a', 'milk', 500), R, 1000, notes.salt);
    const { store, previous } = switchAccount(s, W, 2000, notes.salt);
    expect([previous, store.account, notesOf(store)]).toEqual([R, W, notesOf(s)]);
    expect(switchAccount(store, W, 3000, notes.salt).previous).toBeNull();
  });

  it('a room left is owed one forward to the current account, until it is written', () => {
    const s = switchAccount(adoptAccount(emptyStore<Note>(), R, 1000, notes.salt), W, 2000, notes.salt).store;
    const owed = queueForward(s, R);
    expect(owed.forwards).toEqual({ [R]: W });
    expect(queueForward(owed, R)).toBe(owed);
    expect(queueForward(owed, W)).toBe(owed);
    expect(forwardDone(owed, R).forwards).toEqual({});
    expect(forwardDone(s, R)).toBe(s);
  });
});
