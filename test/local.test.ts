import { describe, it, expect, vi, afterEach } from 'vitest';
import { canon } from '../src/crdt.js';
import { Local, browserStorage, memoryStorage, readStore, storageName, type Storage } from '../src/local.js';
import { chips } from '../src/plan.js';
import { adoptAccount, queueForward, switchAccount } from '../src/store.js';
import { NOTES_V1, notes, notesOf, puzzles, slotKey, solve, tagNote, writeNote } from './models.js';
import { cutShort } from './storage.js';

/** The list as the build before sync left it. */
const V1 = JSON.stringify({ shopping: 'milk, eggs', call: 'the plumber', 'Bad Id': 'dropped' });
const META = 'notes.v2.meta', ACKS = 'notes.v2.acks', FOLD = 'notes.v2.v1';
const ROOM_A = '11111111-1111-4111-8111-111111111111', ROOM_B = '22222222-2222-4222-8222-222222222222';
const env = (t = 1_790_400_000_000) => ({ now: () => t });
const clockOf = (st: Storage) => (JSON.parse(st.get(META)!) as { clock: number }).clock;

/** localStorage near its quota: a write past `room` more bytes is refused without a word, as browserStorage swallows it. */
function nearFull(init: Record<string, string>, room: number): Storage & { data: Map<string, string> } {
  const st = memoryStorage(init), size = () => [...st.data].reduce((n, [k, v]) => n + k.length + v.length, 0), cap = size() + room;
  return { ...st, set: (k, v) => {
    const had = st.data.get(k);
    if (size() - (had === undefined ? 0 : k.length + had.length) + k.length + v.length > cap) return false;
    st.data.set(k, v);
    return true;
  } };
}

describe('folding in what was kept before sync', () => {
  const boot = () => {
    const st = memoryStorage({ [NOTES_V1]: V1, 'other.app': 'x' });
    return { st, local: new Local(st, notes, env()) };
  };

  it('moves every sound record in, with no account yet', () => {
    const { local } = boot(), s = local.store;
    expect(notesOf(s)).toEqual({ shopping: { text: 'milk, eggs', tags: [] }, call: { text: 'the plumber', tags: [] } });
    expect(s.account).toBeNull();
    expect(local.moved).toBe(true);
    expect(chips(notes, s)).toEqual({ items: { 'note/call': 'phone', 'note/shopping': 'phone' }, unsaved: 2 });
  });

  it('keeps the old key where it is, byte for byte, so a rollback or an old tab still finds it', () => {
    const { st } = boot();
    expect(st.get(NOTES_V1)).toBe(V1);
    expect(st.get('other.app')).toBe('x');
    expect(st.keys().filter(k => k.startsWith('notes.v2.')).sort()).toEqual([ACKS, META, FOLD, 'notes.v2.note.call', 'notes.v2.note.shopping'].sort());
  });

  it('runs once: the next boot reads the same store and folds nothing', () => {
    const { st, local } = boot();
    const again = new Local(st, notes, env(1_790_500_000_000));
    expect(canon(again.store)).toBe(canon(local.store));
    expect(again.moved).toBe(false);
  });

  it('near-full storage: a fold that cannot be written is not marked done, and the next boot still has everything', () => {
    const st = nearFull({ [NOTES_V1]: V1 }, 200);
    const first = new Local(st, notes, env());
    expect(notesOf(first.store).call!.text).toBe('the plumber');
    expect(st.get(FOLD)).toBeNull();
    expect(st.get(NOTES_V1)).toBe(V1);
    const next = new Local(memoryStorage(Object.fromEntries(st.data)), notes, env(1_790_500_000_000));
    expect(notesOf(next.store)).toEqual(notesOf(first.store));
  });

  it('an old tab writing after the fold: its change folds in on the storage event, and an edit made here it did not touch stays', () => {
    const st = memoryStorage({ [NOTES_V1]: V1 }), local = new Local(st, notes, env(1_790_400_000_000));
    local.edit((s, now) => writeNote(s, 'shopping', 'oat milk', now));
    st.set(NOTES_V1, JSON.stringify({ ...JSON.parse(V1), call: 'the plumber at 5', fresh: 'new on the old build' }));
    expect(local.folds(NOTES_V1)).toBe(true);
    local.refold();
    expect(notesOf(local.store)).toMatchObject({ shopping: { text: 'oat milk' }, call: { text: 'the plumber at 5' }, fresh: { text: 'new on the old build' } });
    const again = new Local(st, notes, env(1_790_500_000_000));
    expect(canon(again.store.records)).toBe(canon(local.store.records));
  });

  it('storage a newer build wrote is left alone: no fold over it, nothing written, what it holds still read', () => {
    const st = memoryStorage({ [NOTES_V1]: V1 }), local = new Local(st, notes, env());
    local.edit((s, now) => adoptAccount(s, ROOM_A, now, notes.salt), 'sync');
    st.set(META, JSON.stringify({ ...JSON.parse(st.get(META)!), v: 3 }));
    const before = new Map(st.data), again = new Local(st, notes, env(1_790_500_000_000));
    expect([again.newer, again.store.account, notesOf(again.store).call!.text]).toEqual([true, ROOM_A, 'the plumber']);
    again.edit((s, now) => writeNote(s, 'call', 'nobody', now));
    expect(notesOf(again.store).call!.text).toBe('nobody');
    expect(new Map(st.data)).toEqual(before);
  });

  it('a device with nothing kept starts empty', () => {
    const local = new Local(memoryStorage({ 'other.app': '1' }), notes, env());
    expect(local.store.records).toEqual({});
    expect(local.moved).toBe(false);
  });
});

describe('the local store in storage', () => {
  it('reads back exactly what it wrote, one key per record', () => {
    const st = memoryStorage(), local = new Local(st, puzzles, env());
    local.edit((s, now) => solve(s, 2, { run: 0, game: 'g1' }, 'a1', 3, now).store);
    local.edit(s => ({ ...s, acks: { [ROOM_A]: { 'slot/2': 'abcdef0123456789' } } }), 'sync');
    expect(st.get(`puzzles.v2.${storageName(slotKey(2))}`)).toBe(JSON.stringify({ v: 1, ...local.store.records[slotKey(2)] }));
    expect(canon(readStore(st, puzzles))).toBe(canon(local.store));
  });

  it('writes only what an edit changed, and the meta last', () => {
    const st = cutShort(), local = new Local(st, notes, env());
    local.edit((s, now) => writeNote(writeNote(s, 'a', 'one', now), 'b', 'two', now));
    st.writes = 2;
    local.edit((s, now) => tagNote(s, 'b', 'work', now));
    // Two writes were enough: the record the edit changed, and the meta.
    const clock = local.store.clock;
    expect([notesOf(readStore(st, notes)!).b!.tags, clockOf(st)]).toEqual([['work'], clock]);
    st.writes = 1;
    local.edit((s, now) => tagNote(s, 'a', 'home', now));
    // Cut short after one: the record landed, and the meta after it did not.
    expect([notesOf(readStore(st, notes)!).a!.tags, clockOf(st)]).toEqual([['home'], clock]);
  });

  it('a record that leaves the store has its key removed', () => {
    const st = memoryStorage(), local = new Local(st, notes, env());
    local.edit((s, now) => writeNote(writeNote(s, 'a', 'one', now), 'b', 'two', now));
    local.edit(s => ({ ...s, records: { 'note/a': s.records['note/a']! } }), 'sync');
    expect(st.get('notes.v2.note.b')).toBeNull();
    expect(Object.keys(readStore(st, notes)!.records)).toEqual(['note/a']);
  });

  it('reads records even without a meta, and ignores junk and keys the model does not own', () => {
    const st = memoryStorage({
      'notes.v2.note.a': JSON.stringify({ v: 1, id: 'a', text: { val: 'x', t: 7 }, tags: {} }),
      'notes.v2.note.b': '{broken', 'notes.v2.note.c': JSON.stringify({ v: 1, id: 'other', text: { val: 'x', t: 1 }, tags: {} }),
      'notes.v2.note.d': JSON.stringify({ v: 4, id: 'd' }), 'notes.v2.stray': '1',
    });
    const s = readStore(st, notes)!;
    expect([Object.keys(s.records), s.account, s.clock]).toEqual([['note/a'], null, 7]);
    expect(readStore(memoryStorage({ 'notes.v2.stray': '1' }), notes)).toBeNull();
    expect(readStore(memoryStorage({ [META]: JSON.stringify({ v: 1 }) }), notes)).toBeNull();
  });

  it('reloads what another tab wrote, and skips reading when nothing changed', () => {
    const st = memoryStorage(), a = new Local(st, notes, env()), b = new Local(st, notes, env());
    a.edit((s, now) => writeNote(s, 'a', 'one', now));
    const heard: string[] = [];
    b.on((_n, _p, source) => heard.push(source));
    b.reload();
    expect(notesOf(b.store).a!.text).toBe('one');
    b.reload();
    expect(heard).toEqual(['reload']);
    expect(b.owns(META)).toBe(true);
    expect(b.owns('other.app')).toBe(false);
  });

  it("takes the server clock only past the Date header's resolution", () => {
    const local = new Local(memoryStorage(), notes, env());
    local.serverTime(1_000_000, 1_000_000, 1_000_100);
    expect(local.skew).toBe(0);
    local.serverTime(1_060_000, 1_000_000, 1_000_100);
    expect(local.skew).toBe(60_450);
  });
});

describe('two tabs on one storage', () => {
  it('an edit in a tab that has not reloaded yet builds on what the other tab wrote: the account it adopted stays', () => {
    const st = memoryStorage(), a = new Local(st, notes, env()), b = new Local(st, notes, env());
    a.edit((s, now) => writeNote(s, 'a', 'one', now));
    b.reload();
    a.edit((s, now) => adoptAccount(s, ROOM_A, now, notes.salt), 'sync');
    b.edit((s, now) => writeNote(s, 'b', 'two', now));
    expect([readStore(st, notes)!.account, b.store.account]).toEqual([ROOM_A, ROOM_A]);
    expect(Object.keys(notesOf(readStore(st, notes)!)).sort()).toEqual(['a', 'b']);
  });

  it('a link in one tab survives the other tab writing mid-pass', () => {
    const st = memoryStorage(), a = new Local(st, notes, env());
    a.edit((s, now) => writeNote(s, 'a', 'one', now));
    a.edit((s, now) => adoptAccount(s, ROOM_A, now, notes.salt), 'sync');
    const b = new Local(st, notes, env());
    b.edit((s, now) => queueForward(switchAccount(s, ROOM_B, now, notes.salt).store, ROOM_A), 'sync');
    a.edit((s, now) => writeNote(s, 'a', 'two', now), 'sync');
    b.reload();
    expect([readStore(st, notes)!.account, b.store.account, readStore(st, notes)!.forwards]).toEqual([ROOM_B, ROOM_B, { [ROOM_A]: ROOM_B }]);
  });
});

describe('browser storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('falls back to memory when localStorage refuses, so the app goes on', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError'); } });
    const st = browserStorage();
    st.set('a', '1');
    expect(st.get('a')).toBe('1');
  });
});

describe('model helpers', () => {
  it('names a record in storage by its key, each slash a dot', () => {
    expect(storageName('note/a')).toBe('note.a');
    expect(storageName('save')).toBe('save');
  });

  it('keeps one model\'s store apart from another\'s on the same storage', () => {
    const st = memoryStorage(), n = new Local(st, notes, env());
    n.edit((s, now) => writeNote(s, 'a', 'one', now));
    const p = new Local(st, puzzles, env());
    expect(p.store.records).toEqual({});
    expect(readStore(st, notes)!.records['note/a']).toBeDefined();
  });

  it('empty storage reads as no store', () => {
    expect(readStore(memoryStorage(), notes)).toBeNull();
  });
});
