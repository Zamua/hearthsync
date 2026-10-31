import { describe, it, expect } from 'vitest';
import { codeFromRoom } from '../src/code.js';
import { gsetList } from '../src/crdt.js';
import { Local, memoryStorage, readStore } from '../src/local.js';
import type { Model } from '../src/model.js';
import { adoptAccount } from '../src/store.js';
import { device, fakeWorld } from '../src/testing/index.js';
import { LAST_V1, NOTES_V1, here, notes, notesHere, notesOf, openNote, writeNote, type Here, type Note } from './models.js';
import { cutShort } from './storage.js';

const META = 'notes.v2.meta', ROOM = '11111111-1111-4111-8111-111111111111';
const env = (t = 1_790_400_000_000) => ({ now: () => t });
const open = (l: Local<Note, Here>, id: string) => l.edit((s, now) => openNote(s, id, now));
const opened = (l: { store: { app: Here } }) => gsetList(l.store.app.opened);
const meta = (st: { get(k: string): string | null }) => JSON.parse(st.get(META)!) as Record<string, unknown>;

describe("the app's own state in the meta", () => {
  it('starts from its read of nothing, and round-trips through storage with the records', () => {
    const st = memoryStorage(), l = new Local(st, notesHere, env());
    expect(l.store.app).toEqual({ opened: {}, last: null });
    l.edit((s, now) => writeNote(s, 'a', 'milk', now));
    open(l, 'a');
    open(l, 'b');
    expect(meta(st)).toMatchObject({ v: 2, opened: { a: expect.any(Number), b: expect.any(Number) }, last: 'b' });
    const again = new Local(st, notesHere, env(1_790_500_000_000));
    expect([opened(again), again.store.app.last, notesOf(again.store)]).toEqual([['a', 'b'], 'b', { a: { text: 'milk', tags: [] } }]);
    expect(readStore(st, notesHere)!.app).toEqual(again.store.app);
  });

  it('is written with the meta, in the same write, after the records an edit changed', () => {
    const st = cutShort(), l = new Local(st, notesHere, env());
    st.writes = 1;
    l.edit((s, now) => openNote(writeNote(s, 'a', 'milk', now), 'a', now));
    // Cut short after one write: the record landed, and the meta holding the app's state, after it, did not.
    const cut = readStore(st, notesHere)!;
    expect([notesOf(cut), gsetList(cut.app.opened)]).toEqual([{ a: { text: 'milk', tags: [] } }, []]);
    st.writes = 1;
    open(l, 'b');
    // An edit of the app's state alone is one write, of the meta.
    expect([gsetList(readStore(st, notesHere)!.app.opened), meta(st).last]).toEqual([['a', 'b'], 'b']);
  });

  it("keeps the library's fields over any of the app's named the same", () => {
    const greedy: Model<Note, Here> = { ...notesHere, meta: { ...here, write: h => ({ ...here.write(h), v: 9, account: 'x', clock: -1 }) } };
    const st = memoryStorage(), l = new Local(st, greedy, env());
    l.edit((s, now) => adoptAccount(openNote(s, 'a', now), ROOM, now, greedy.salt));
    expect(meta(st)).toMatchObject({ v: 2, account: ROOM, clock: l.store.clock });
  });

  it('reads what is sound in the meta and repairs the rest', () => {
    const st = memoryStorage({ [META]: JSON.stringify({ v: 2, opened: { a: 3, 'Bad Id': 1, b: -1 }, last: 7 }) });
    expect(new Local(st, notesHere, env()).store.app).toEqual({ opened: { a: 3 }, last: null });
  });
});

describe('another tab', () => {
  it('two tabs opening notes: each edit builds on what the other wrote', () => {
    const st = memoryStorage(), a = new Local(st, notesHere, env()), b = new Local(st, notesHere, env());
    open(a, 'x');
    open(b, 'y');
    open(a, 'z');
    expect([opened(a), opened(new Local(st, notesHere, env()))]).toEqual([['x', 'y', 'z'], ['x', 'y', 'z']]);
  });

  it('a tab of a build without the hook writing the meta: merge keeps this tab\'s state, and the next write puts it back', () => {
    const st = memoryStorage(), mine = new Local(st, notesHere, env());
    open(mine, 'x');
    const older = new Local(st, notes, env());
    older.edit((s, now) => writeNote(s, 'b', 'from the older build', now));
    expect(meta(st)).not.toHaveProperty('opened');
    mine.reload();
    expect([opened(mine), mine.store.app.last, Object.keys(notesOf(mine.store))]).toEqual([['x'], 'x', ['b']]);
    expect(meta(st)).toMatchObject({ opened: { x: expect.any(Number) }, last: 'x' });
  });

  it('without merge, the copy another tab wrote wins', () => {
    const plain: Model<Note, Here> = { ...notesHere, meta: { read: here.read, write: here.write } };
    const st = memoryStorage(), mine = new Local(st, plain, env());
    open(mine, 'x');
    new Local(st, notes, env()).edit((s, now) => writeNote(s, 'b', 'b', now));
    mine.reload();
    expect([opened(mine), mine.store.app.last]).toEqual([[], null]);
  });
});

describe('models without the hook', () => {
  it('keep the meta exactly as before, and no app state', () => {
    const st = memoryStorage(), l = new Local(st, notes, env());
    l.edit((s, now) => adoptAccount(writeNote(s, 'a', 'milk', now), ROOM, now, notes.salt));
    expect(Object.keys(meta(st))).toEqual(['v', 'account', 'profile', 'clock', 'forwards', 'purge', 'shared']);
    expect(l.store.app).toBeUndefined();
    expect(readStore(st, notes)!.app).toBeUndefined();
  });

  it('never read app fields another build kept in the meta', () => {
    const st = memoryStorage(), withHook = new Local(st, notesHere, env());
    open(withHook, 'x');
    const without = new Local(st, notes, env());
    expect(without.store.app).toBeUndefined();
  });
});

describe('newer builds', () => {
  it("a newer build's meta is read, the app's state with it, and never written over", () => {
    const st = memoryStorage({ [META]: JSON.stringify({ v: 3, account: ROOM, clock: 5, opened: { a: 2 }, last: 'a', future: true }) });
    const before = new Map(st.data), l = new Local(st, notesHere, env());
    expect([l.newer, l.store.account, opened(l), l.store.app.last]).toEqual([true, ROOM, ['a'], 'a']);
    open(l, 'b');
    expect(opened(l)).toEqual(['a', 'b']);
    expect(new Map(st.data)).toEqual(before);
  });
});

describe('folds and migrations', () => {
  it("carry the app's state through a refold, and a fold can bring old per-device state in", () => {
    const st = memoryStorage({ [NOTES_V1]: JSON.stringify({ a: 'milk' }), [LAST_V1]: 'a' });
    const l = new Local(st, notesHere, env());
    expect([Object.keys(notesOf(l.store)), l.store.app.last]).toEqual([['a'], 'a']);
    open(l, 'b');
    st.set(NOTES_V1, JSON.stringify({ a: 'milk', c: 'new on the old build' }));
    l.refold();
    expect([Object.keys(notesOf(l.store)).sort(), opened(l), l.store.app.last]).toEqual([['a', 'c'], ['b'], 'b']);
    expect(new Local(st, notesHere, env(1_790_500_000_000)).store.app).toEqual(l.store.app);
  });
});

describe('sync', () => {
  it('keeps the app state through rounds, links and merges, and never uploads it', async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, notesHere, 'a'), b = device(host, clock, notesHere, 'b');
    a.local.edit((s, now) => openNote(writeNote(s, 'x', 'from a', now), 'x', now));
    await a.sync.sync();
    b.local.edit((s, now) => openNote(writeNote(s, 'y', 'from b', now), 'y', now));
    await b.sync.sync();
    await b.sync.linkCode(codeFromRoom(a.local.store.account!));
    await a.sync.sync({ full: true });
    expect([opened(a.local), opened(b.local)]).toEqual([['x'], ['y']]);
    expect(Object.keys(notesOf(a.local.store)).sort()).toEqual(['x', 'y']);
    expect(Object.keys(host.snapshot(a.local.store.account!)).sort()).toEqual(['account', 'note/x', 'note/y']);
  });

  it('an edit of the app state alone uploads nothing', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notesHere, 'a');
    d.local.edit((s, now) => writeNote(s, 'x', 'x', now));
    await d.sync.sync();
    const puts = host.requests('PUT').length, heard: string[] = [];
    d.local.on((_n, _p, source) => heard.push(source));
    open(d.local, 'x');
    await d.sync.sync({ full: true });
    expect([heard[0], host.requests('PUT').length, d.sync.status.state]).toEqual(['app', puts, 'saved']);
  });
});
