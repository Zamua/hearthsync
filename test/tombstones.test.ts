import { describe, it, expect } from 'vitest';
import { codeFromRoom } from '../src/code.js';
import { canon, hash } from '../src/crdt.js';
import { Local, memoryStorage, readStore } from '../src/local.js';
import type { Kind, Model } from '../src/model.js';
import { accountDocs, chips, dirty, joinAccount, plan } from '../src/plan.js';
import { docsOf } from '../src/records.js';
import { adoptAccount, emptyStore, expire, oldestTombstone, purgeDone, purgeRecord, putRecord, roomFor, switchAccount, type LocalStore } from '../src/store.js';
import { device, fakeWorld } from '../src/testing/index.js';
import { PINNED, deleteNote, noteKey, noteKind, notes, notesOf, puzzleKind, puzzles, slotKey, solve, startOver, writeNote, type Note, type Puzzle } from './models.js';

const R = '11111111-2222-4333-8444-555555555555', B = '99999999-2222-4333-8444-555555555555';
const DAY = 24 * 3600_000;
const withNotes = (...ids: string[]) => ids.reduce((s, id, i) => writeNote(s, id, id, 1000 + i), adoptAccount(emptyStore<Note>(), R, 900, notes.salt));
/** Every doc of the store acknowledged in its account room. */
const acked = (s: LocalStore<Note>) => ({ ...s, acks: { [R]: Object.fromEntries(Object.entries(accountDocs(notes, s)).map(([k, d]) => [k, hash(d)])) } });

describe('tombstones', () => {
  it('a deleted record stays, uploads after the live ones, and shows no chip', () => {
    const s = deleteNote(withNotes('a', 'b'), 'a', 2000);
    expect(notesOf(s)).toEqual({ b: { text: 'b', tags: [] } });
    expect(Object.keys(docsOf(notes, s.records))).toEqual(['note/b', 'note/a']);
    expect(chips(notes, s)).toEqual({ items: { 'note/b': 'phone' }, unsaved: 1 });
    expect(dirty(notes, s).map(p => p.key)).toContain('note/a');
  });

  it('an older edit elsewhere does not bring it back; a later one does', () => {
    const base = withNotes('a'), gone = deleteNote(base, 'a', 2000);
    const older = writeNote(base, 'a', 'edited before', 1500), later = writeNote(base, 'a', 'edited after', 2500);
    expect(notesOf(joinAccount(notes, gone, accountDocs(notes, older)))).toEqual({});
    expect(notesOf(joinAccount(notes, gone, accountDocs(notes, later)))).toEqual({ a: { text: 'edited after', tags: [] } });
  });
});

describe('caps', () => {
  const cappedKind: Kind<Note> = { ...noteKind, cap: 2 };
  const kinds: Model<Note> = { ...notes, kind: key => (notes.kind(key) === noteKind ? cappedKind : notes.kind(key)) };
  const put = (s: LocalStore<Note>, id: string) => putRecord(kinds, s, noteKey(id), 5000, (_h, t) => ({ id, text: { val: id, t }, tags: {}, u: t, deleted: 0 }));

  it('a new record past its kind\'s cap takes the place of the oldest tombstone, and is refused when there is none', () => {
    const two = withNotes('a', 'b');
    expect(roomFor(kinds, two, noteKey('c'))).toBe(false);
    expect(roomFor(kinds, two, noteKey('a'))).toBe(true);
    expect(put(two, 'c')).toMatchObject({ result: 'full' });
    const s = deleteNote(deleteNote(two, 'b', 2000), 'a', 3000);
    expect(oldestTombstone(kinds, s)).toBe('note/b');
    const r = put(s, 'c');
    expect(r.result).toBe('saved');
    expect(Object.keys(r.store.records).sort()).toEqual(['note/a', 'note/c']);
  });
});

describe('the purge', () => {
  it('drops a tombstone, and lists its key for deletion only when the account room may hold it', () => {
    const s = deleteNote(withNotes('a', 'b'), 'a', 2000);
    expect(purgeRecord(notes, s, 'note/a')).toMatchObject({ purge: {} });
    expect(purgeRecord(notes, s, 'note/b')).toBe(s);
    const p = purgeRecord(notes, acked(s), 'note/a');
    expect([Object.keys(p.records), p.purge, p.acks[R]!['note/a']]).toEqual([['note/b'], { 'note/a': 2000 }, undefined]);
    expect(purgeDone(p, 'note/a').purge).toEqual({});
    expect(switchAccount(p, B, 3000, notes.salt).store.purge).toEqual({});
  });

  it('expires tombstones past purgeAfter, and keeps one without a time until a slot is needed', () => {
    let s = deleteNote(withNotes('a', 'b'), 'a', 2000);
    s = { ...s, records: { ...s.records, 'note/b': { ...s.records['note/b']!, deleted: 1, u: 0 } } };
    expect(expire(notes, s, 2000 + 89 * DAY)).toBe(s);
    expect(Object.keys(expire(notes, s, 2000 + 90 * DAY).records)).toEqual(['note/b']);
    expect(expire({ ...notes, purgeAfter: undefined }, s, 1e15)).toBe(s);
  });

  it('a purged key is not taken back from a room, unless used after its tombstone', () => {
    const s = purgeRecord(notes, acked(deleteNote(withNotes('a'), 'a', 2000)), 'note/a');
    const stale = { 'note/a': { v: 1, id: 'a', text: { val: 'a', t: 1000 }, tags: {}, u: 1000, deleted: 0 } };
    expect(plan(notes, s, R, stale).store.records).toEqual({});
    const used = { 'note/a': { ...stale['note/a'], text: { val: 'again', t: 3000 }, u: 3000 } };
    const p = plan(notes, s, R, used);
    expect([notesOf(p.store), p.store.purge]).toEqual([{ a: { text: 'again', tags: [] } }, {}]);
  });

  it('a tombstone another device purged is dropped here rather than uploaded again; one never uploaded still goes', () => {
    const held = acked(deleteNote(withNotes('a', 'b'), 'a', 2000)), room = accountDocs(notes, held);
    const { ['note/a']: _, ...without } = room;
    const p = plan(notes, held, R, without);
    expect([Object.keys(p.store.records), p.puts]).toEqual([['note/b'], []]);
    const fresh = deleteNote(withNotes('a', 'b'), 'a', 2000);
    expect(plan(notes, fresh, R, {}).puts.map(x => x.key)).toContain('note/a');
  });
});

describe('a key an earlier build wrote', () => {
  const pinned = { id: 'p', text: { val: 'pinned long ago', t: 50 }, tags: {}, u: 50, deleted: 0 };

  it('is read into its record\'s own key, never written, and read again only once it changed', () => {
    const s = withNotes('a'), p = plan(notes, s, R, { [PINNED]: { v: 1, ...pinned } });
    expect(notesOf(p.store)).toMatchObject({ p: { text: 'pinned long ago' } });
    expect(p.puts.map(x => x.key).sort()).toEqual(['account', 'note/a', 'note/p']);
    expect(p.store.acks[R]![PINNED]).toBe(hash({ v: 1, ...pinned }));
    const gone = purgeRecord(notes, acked(deleteNote(p.store, 'p', 3000)), 'note/p');
    const again = plan(notes, { ...gone, acks: { [R]: { ...gone.acks[R], [PINNED]: hash({ v: 1, ...pinned }) } } }, R, { [PINNED]: { v: 1, ...pinned } });
    expect(again.store.records['note/p']).toBeUndefined();
    const edited = { v: 1, ...pinned, text: { val: 'edited by the old build', t: 4000 }, u: 4000 };
    expect(notesOf(plan(notes, again.store, R, { [PINNED]: edited }).store).p!.text).toBe('edited by the old build');
  });

  it('counts as the app\'s in a room, but is never read from local storage', () => {
    const st = memoryStorage({ 'notes.v2.pinned': JSON.stringify({ v: 1, ...pinned }) });
    expect(readStore(st, notes)).toBeNull();
  });

  it('a code whose room holds only that key is an account', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    const old = host.make({ [PINNED]: { v: 1, ...pinned } });
    expect((await d.sync.peekCode(codeFromRoom(old))).records).toMatchObject({ 'note/p': { text: { val: 'pinned long ago' } } });
    await d.sync.linkCode(codeFromRoom(old));
    expect(Object.keys(host.snapshot(old)).sort()).toEqual(['account', 'note/p', PINNED]);
  });
});

describe('playthroughs that merge when accounts meet', () => {
  const mergingKind: Kind<Puzzle> = { ...puzzleKind, otherPlay: 'merge' };
  const merging: Model<Puzzle> = { ...puzzles, kind: key => (puzzles.kind(key) ? mergingKind : null) };

  it('linking lets the kind\'s merge decide: here the later run wins, whichever side it is on', () => {
    const mine = startOver(solve(emptyStore(), 1, { run: 0, game: 'g1' }, 'a1', 1, 1000).store, 1, 'restart', 2000);
    const theirs = solve(emptyStore(), 1, { run: 0, game: 'acct' }, 'z9', 1, 3000).store;
    expect(joinAccount(merging, mine, accountDocs(merging, theirs)).records[slotKey(1)]!.game).toBe('restart');
    expect(joinAccount(puzzles, mine, accountDocs(puzzles, theirs)).records[slotKey(1)]!.game).toBe('acct');
  });
});

describe('the purge through the engine', () => {
  it('an expired tombstone is deleted from the room, and another device drops it instead of uploading it again', async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, notes, 'a');
    a.local.edit((s, now) => writeNote(writeNote(s, 'x', 'x', now), 'y', 'y', now));
    await a.sync.sync();
    const b = device(host, clock, notes, 'b');
    await b.sync.linkCode(codeFromRoom(a.local.store.account!));
    a.local.edit((s, now) => deleteNote(s, 'x', now));
    await a.sync.sync();
    await b.sync.sync({ full: true });
    clock.t += 91 * DAY;
    await a.sync.sync({ full: true });
    expect(host.requests('DELETE')).toEqual([`DELETE /api/rooms/${a.local.store.account}/note/x 204`]);
    expect(Object.keys(host.snapshot(a.local.store.account!)).sort()).toEqual(['account', 'note/y']);
    await b.sync.sync({ full: true });
    expect(Object.keys(b.local.store.records)).toEqual(['note/y']);
    expect(host.requests('PUT', /note\/x/)).toHaveLength(2);
  });

  it('a room at its cap gives up its oldest tombstone for a new key', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    d.local.edit((s, now) => deleteNote(writeNote(writeNote(s, 'x', 'x', now), 'y', 'y', now), 'x', now + 1));
    await d.sync.sync();
    host.maxKeys = 3;
    d.local.edit((s, now) => writeNote(s, 'z', 'z', now));
    await d.sync.sync({ full: true });
    const room = d.local.store.account!;
    expect(Object.keys(host.snapshot(room)).sort()).toEqual(['account', 'note/y', 'note/z']);
    expect(d.sync.status).toMatchObject({ problem: null, items: { 'note/y': 'saved', 'note/z': 'saved' } });
  });
});

describe('the store format', () => {
  it("an app's own store version is read, and one above it is a newer build's", () => {
    const v3: Model<Note> = { ...notes, storeVersion: 3 };
    const st = memoryStorage(), l = new Local(st, v3, { now: () => 1000 });
    l.edit((s, now) => writeNote(s, 'a', 'one', now));
    expect(JSON.parse(st.get('notes.v2.meta')!).v).toBe(3);
    expect(new Local(st, notes, { now: () => 2000 }).newer).toBe(true);
    expect(new Local(st, v3, { now: () => 2000 }).newer).toBe(false);
    expect(canon(readStore(st, v3)!.records)).toBe(canon(l.store.records));
  });
});
