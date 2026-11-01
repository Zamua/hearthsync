import { describe, it, expect } from 'vitest';
import { codeFromRoom, formatCode, qrText } from '../src/code.js';
import { publicId } from '../src/identity.js';
import { memoryStorage } from '../src/local.js';
import type { Model } from '../src/model.js';
import { dirty } from '../src/plan.js';
import { LOST_GAP } from '../src/health.js';
import { Sync, type SyncError } from '../src/sync.js';
import { device, fakeWorld, type Device, type FakeRooms, type TestClock } from '../src/testing/index.js';
import { cellsOf, notes, notesOf, puzzles, slotKey, solve, startOver, tagNote, writeNote, type Note, type Puzzle } from './models.js';

const write = (d: Device<Note>, id: string, text: string) => d.local.edit((s, now) => writeNote(s, id, text, now));
const tag = (d: Device<Note>, id: string, t: string) => d.local.edit((s, now) => tagNote(s, id, t, now));
const account = <R>(d: Device<R>) => d.local.store.account!;
const keysOf = (host: FakeRooms, room: string) => Object.keys(host.snapshot(room)).sort();
const code = <R>(d: Device<R>) => formatCode(codeFromRoom(account(d)));
const fail = (p: Promise<unknown>) => p.then(() => 'ok', (e: SyncError) => e.kind);
const held = (d: Device<Note>) => notesOf(d.local.store);
const textOn = (host: FakeRooms, room: string, id: string) => (host.snapshot(room)[`note/${id}`] as { text: { val: string } } | undefined)?.text.val;

/** A device with a note, backed up. */
async function backedUp(host: FakeRooms, clock: TestClock, name = 'a', text = 'milk'): Promise<Device<Note>> {
  const d = device(host, clock, notes, name);
  write(d, name, text);
  await d.sync.sync();
  return d;
}

describe('the account', () => {
  it('a device with nothing to save makes no room', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    await d.sync.sync();
    expect(host.log).toEqual([]);
    expect(d.sync.status).toMatchObject({ state: 'saved', items: {}, unsaved: 0, code: null });
  });

  it('first time online: the account room is made, every record uploads, and the code is told once', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    write(d, 'a', 'milk');
    write(d, 'b', 'call');
    expect(d.sync.status.items).toEqual({ 'note/a': 'phone', 'note/b': 'phone' });
    await d.sync.sync();
    const room = account(d);
    expect(host.requests('POST')).toHaveLength(1);
    expect(d.heard.account).toEqual([{ code: codeFromRoom(room) }]);
    expect(keysOf(host, room)).toEqual(['account', 'note/a', 'note/b']);
    expect(host.snapshot(room).account).toMatchObject({ v: 1, pid: publicId(room, notes.salt) });
    expect(d.sync.status).toMatchObject({ state: 'saved', problem: null, code: codeFromRoom(room), items: { 'note/a': 'saved', 'note/b': 'saved' }, unsaved: 0 });
    expect(d.heard.backlog).toEqual([]);
    await d.sync.sync();
    expect(host.requests('POST')).toHaveLength(1);
    expect(host.requests('PUT')).toHaveLength(3);
  });

  it('offline, nothing is sent and every record says Phone only', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    clock.on = false;
    write(d, 'a', 'milk');
    await d.sync.sync();
    expect(host.log).toEqual([]);
    expect(d.sync.status).toMatchObject({ state: 'offline', code: null, items: { 'note/a': 'phone' } });
  });
});

describe('two devices on one code', () => {
  it('a second device links by code, scanned or typed, and edits on both converge after a round trip', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = device(host, clock, notes, 'b');
    expect(await b.sync.linkCode(qrText(codeFromRoom(account(a)), 'notes'))).toEqual({ pending: false });
    expect(account(b)).toBe(account(a));
    expect(held(b)).toEqual(held(a));
    write(b, 'a', 'oat milk');
    tag(a, 'a', 'urgent');
    write(a, 'x', 'new');
    await b.sync.sync();
    await a.sync.sync({ full: true });
    await b.sync.sync({ full: true });
    expect(held(a)).toEqual(held(b));
    expect(held(a)).toEqual({ a: { text: 'oat milk', tags: ['urgent'] }, x: { text: 'new', tags: [] } });
    expect(a.heard.news.flatMap(n => n.keys)).toContain('note/a');
    expect(b.heard.news.flatMap(n => n.keys)).toContain('note/x');
    expect(dirty(notes, a.local.store).concat(dirty(notes, b.local.store))).toEqual([]);
  });

  it('a device with notes of its own that links brings them along, and its old account forwards', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b', 'mine');
    const old = account(b);
    expect(await b.sync.linkCode(code(a))).toEqual({ pending: false });
    expect(held(b)).toEqual({ a: { text: 'milk', tags: [] }, b: { text: 'mine', tags: [] } });
    expect(textOn(host, account(a), 'b')).toBe('mine');
    expect(host.snapshot(old)).toMatchObject({ forward: { v: 1, to: account(a) } });
  });

  it('two devices saving at once: the clobbered PUT heals on the next full round', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = device(host, clock, notes, 'b');
    await b.sync.linkCode(code(a));
    write(a, 'a', 'oat milk');
    tag(b, 'a', 'home');
    // Both read before either writes, so the later PUT drops the other's change at the server.
    await Promise.all([a.sync.sync(), b.sync.sync()]);
    for (let i = 0; i < 2; i++) { await a.sync.sync({ full: true }); await b.sync.sync({ full: true }); }
    for (const d of [a, b]) expect(held(d).a).toEqual({ text: 'oat milk', tags: ['home'] });
    expect(dirty(notes, a.local.store).concat(dirty(notes, b.local.store))).toEqual([]);
  });

  it('a device still on a code that was linked away follows its forward, and is told of what it now holds', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b', 'mine');
    const c = device(host, clock, notes, 'c'), old = account(b);
    await c.sync.linkCode(code(b));
    await b.sync.linkCode(code(a));
    expect(host.snapshot(old).forward).toMatchObject({ to: account(a) });
    await c.sync.sync({ full: true });
    expect(account(c)).toBe(account(a));
    expect(held(c)).toEqual({ a: { text: 'milk', tags: [] }, b: { text: 'mine', tags: [] } });
    expect(c.heard.news.flatMap(n => n.keys)).toContain('note/a');
    await c.sync.sync({ full: true });
    expect(dirty(notes, c.local.store)).toEqual([]);
  });

  it('merging another code brings its records in, keeps this tag, and forwards its room here; its devices follow', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b', 'theirs');
    const bRoom = account(b), tagBefore = a.sync.status.tag;
    expect(await a.sync.peekCode(code(b))).toMatchObject({ code: codeFromRoom(bRoom), same: false, records: { 'note/b': { text: { val: 'theirs' } } } });
    expect(await a.sync.mergeCode(code(b))).toEqual({ pending: false });
    expect(Object.keys(held(a)).sort()).toEqual(['a', 'b']);
    expect(host.snapshot(bRoom).forward).toMatchObject({ to: account(a) });
    expect(a.sync.status.tag).toBe(tagBefore);
    expect(a.heard.news.at(-1)).toEqual({ keys: ['note/b'] });
    await b.sync.sync({ full: true });
    expect([account(b), Object.keys(held(b)).sort()]).toEqual([account(a), ['a', 'b']]);
    expect(await fail(a.sync.mergeCode(code(a)))).toBe('same');
    expect(await fail(a.sync.mergeCode('0K7Q M2XD'))).toBe('code');
    expect((await a.sync.peekCode(code(a))).same).toBe(true);
  });

  it('an interrupted link, then a restart: the old account still gets its forward', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b', 'mine');
    const old = account(b);
    host.failNext(0, 1, new RegExp(`^PUT /api/rooms/${old}/forward`));
    expect(await b.sync.linkCode(code(a))).toEqual({ pending: true });
    expect(account(b)).toBe(account(a));
    expect(host.snapshot(old).forward).toBeUndefined();
    const again = device(host, clock, notes, 'b', b.storage);
    await again.sync.sync({ full: true });
    expect(host.snapshot(old).forward).toMatchObject({ to: account(a) });
  });

  it('a code with no account behind it is refused', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock);
    const empty = host.make({ unrelated: 1 }), missing = 'f0000000-0000-4000-8000-0000000fffff';
    expect(await fail(a.sync.linkCode(codeFromRoom(empty)))).toBe('notaccount');
    expect(await fail(a.sync.linkCode(codeFromRoom(missing)))).toBe('notfound');
    clock.on = false;
    expect(await fail(a.sync.linkCode(codeFromRoom(missing)))).toBe('offline');
  });
});

describe('playthroughs across devices', () => {
  const P = { run: 3, game: 'mine' };
  const save = (d: Device<Puzzle>, slot: number, play = P, cell = 'a1') => {
    let result = '';
    d.local.edit((s, now) => { const r = solve(s, slot, play, cell, 1, now); result = r.result; return r.store; });
    return result;
  };

  async function withSaves(host: FakeRooms, clock: TestClock, name: string, play: { run: number; game: string }, cell: string): Promise<Device<Puzzle>> {
    const d = device(host, clock, puzzles, name);
    save(d, 1, play, cell);
    await d.sync.sync();
    return d;
  }

  it("linking plays the account's playthrough; a session still running the device's own is refused as moved and never saves back over it", async () => {
    const { host, clock } = fakeWorld();
    const a = await withSaves(host, clock, 'a', { run: 0, game: 'acct' }, 'a1');
    // This device's own game is further along by run, which would win a merge.
    const b = await withSaves(host, clock, 'b', P, 'z9');
    const old = account(b);
    await b.sync.linkCode(code(a));
    expect([b.local.store.records[slotKey(1)]!.game, cellsOf(b.local.store, 1)]).toEqual(['acct', ['a1']]);
    expect(save(b, 1, P, 'y8')).toBe('moved');
    await b.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(cellsOf(a.local.store, 1)).toEqual(['a1']);
    expect((host.snapshot(account(a))[slotKey(1)] as Puzzle).game).toBe('acct');
    expect((host.snapshot(old)[slotKey(1)] as Puzzle).game).toBe('mine');
    expect(save(b, 1, { run: 0, game: 'acct' }, 'b2')).toBe('saved');
  });

  it('a forward followed does the same: the running session is told it moved', async () => {
    const { host, clock } = fakeWorld();
    const a = await withSaves(host, clock, 'a', { run: 0, game: 'acct' }, 'a1');
    const b = await withSaves(host, clock, 'b', P, 'z9');
    const c = device(host, clock, puzzles, 'c');
    await c.sync.linkCode(code(b));
    await b.sync.linkCode(code(a));
    await c.sync.sync({ full: true });
    expect(account(c)).toBe(account(a));
    expect(save(c, 1, P, 'y8')).toBe('moved');
    expect(c.heard.news.flatMap(n => n.keys)).toContain(slotKey(1));
  });

  it('merging another code keeps this account\'s playthrough, and its other slots come in', async () => {
    const { host, clock } = fakeWorld();
    const a = await withSaves(host, clock, 'a', { run: 0, game: 'acct' }, 'a1');
    const b = device(host, clock, puzzles, 'b');
    save(b, 1, P, 'z9');
    save(b, 2, { run: 0, game: 'two' }, 'q1');
    await b.sync.sync();
    await a.sync.mergeCode(code(b));
    expect([a.local.store.records[slotKey(1)]!.game, cellsOf(a.local.store, 2)]).toEqual(['acct', ['q1']]);
    expect(save(a, 1, { run: 0, game: 'acct' }, 'b2')).toBe('saved');
  });

  it('a new game on one device replaces the slot on the other, whose session is then refused', async () => {
    const { host, clock } = fakeWorld();
    const a = await withSaves(host, clock, 'a', P, 'a1'), b = device(host, clock, puzzles, 'b');
    await b.sync.linkCode(code(a));
    a.local.edit((s, now) => startOver(s, 1, 'g9', now));
    await a.sync.sync();
    await b.sync.sync({ full: true });
    expect(b.local.store.records[slotKey(1)]!.run).toBe(4);
    expect(save(b, 1, P, 'z9')).toBe('moved');
    expect(cellsOf(b.local.store, 1)).toEqual([]);
  });
});

describe('offline and failures', () => {
  it('offline edits, then reconnecting, uploads the backlog and tells it once, by key', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    clock.on = false;
    write(d, 'a', 'oat milk');
    await clock.advance(3 * 60_000, [d]);
    expect(d.sync.status).toMatchObject({ state: 'offline', items: { 'note/a': 'waiting' }, unsaved: 1 });
    clock.on = true;
    d.sync.online();
    await clock.advance(0, [d]);
    expect(d.heard.backlog).toEqual([{ keys: ['note/a'], at: clock.t }]);
    expect(d.sync.status).toMatchObject({ state: 'saved', items: { 'note/a': 'saved' }, unsaved: 0 });
    expect(textOn(host, account(d), 'a')).toBe('oat milk');
    // A routine save while online is no backlog.
    write(d, 'a', 'milk again');
    await clock.advance(20_000, [d]);
    expect(textOn(host, account(d), 'a')).toBe('milk again');
    expect(d.heard.backlog).toHaveLength(1);
    d.sync.stop();
  });

  it("two devices, both offline, both editing: back online, each keeps the other's changes", async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = device(host, clock, notes, 'b');
    await b.sync.linkCode(code(a));
    a.down = b.down = true;
    tag(a, 'a', 'work');
    write(b, 'b', 'from b');
    await Promise.all([a.sync.sync(), b.sync.sync()]);
    expect([a.sync.status.state, b.sync.status.state]).toEqual(['offline', 'offline']);
    a.down = b.down = false;
    for (let i = 0; i < 2; i++) { await a.sync.sync({ full: true }); await b.sync.sync({ full: true }); }
    for (const d of [a, b]) expect(held(d)).toEqual({ a: { text: 'milk', tags: ['work'] }, b: { text: 'from b', tags: [] } });
  });

  it('429 on the first POST: Phone only until Retry-After, then the account is made', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    host.createLimit = 0;
    host.retryAfter = 120;
    write(d, 'a', 'milk');
    d.sync.start();
    await clock.advance(0, [d]);
    expect(d.sync.status).toMatchObject({ problem: 'rate', code: null, items: { 'note/a': 'phone' }, retryAt: clock.t + 120_000 });
    host.createLimit = Infinity;
    await clock.advance(60_000, [d]);
    expect(host.requests('POST')).toEqual(['POST /api/rooms 429']);
    await clock.advance(60_000, [d]);
    expect(host.requests('POST')).toEqual(['POST /api/rooms 429', 'POST /api/rooms 201']);
    expect(d.sync.status).toMatchObject({ problem: null, items: { 'note/a': 'saved' } });
    d.sync.stop();
  });

  it('a 429 holding the whole hour is retried once early, then waited out', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, notes, 'a');
    host.createLimit = 0;
    write(d, 'a', 'milk');
    d.sync.start();
    await clock.advance(0, [d]);
    await clock.advance(5 * 60_000, [d]);
    expect(host.requests('POST')).toHaveLength(2);
    await clock.advance(59 * 60_000, [d]);
    expect(host.requests('POST')).toHaveLength(2);
    await clock.advance(60_000, [d]);
    expect(host.requests('POST')).toHaveLength(3);
    d.sync.stop();
  });

  it('server errors back off from 2 s, doubling, each wait jittered down by up to half; repeated ones show Not saved until an upload works', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    write(d, 'a', 'oat milk');
    host.failNext(503, 3);
    d.sync.soon();
    await clock.advance(0, [d]);
    const tries = () => host.log.filter(l => l.endsWith(' 503')).length, start = clock.t, at = (ms: number) => clock.advance(start + ms - clock.t, [d]);
    expect(tries()).toBe(1);
    // Waits of 1-2 s, 2-4 s, then 4-8 s: each check sits at the earliest or the latest a try may land.
    await at(999);
    expect(tries()).toBe(1);
    await at(2000);
    expect(tries()).toBe(2);
    await at(2999);
    expect(tries()).toBe(2);
    await at(6000);
    expect(tries()).toBe(3);
    expect(d.sync.status).toMatchObject({ state: 'error', problem: 'failing', items: { 'note/a': 'failed' } });
    await at(6999);
    expect(d.sync.status.state).toBe('error');
    await at(14_000);
    expect(d.sync.status).toMatchObject({ state: 'saved', problem: null, items: { 'note/a': 'saved' } });
    d.sync.stop();
  });

  it('a network drop backs off too, and shows offline', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    write(d, 'a', 'oat milk');
    d.down = true;
    await d.sync.sync();
    expect(d.sync.status.state).toBe('offline');
    d.down = false;
    await d.sync.sync();
    expect(d.sync.status).toMatchObject({ state: 'saved', items: { 'note/a': 'saved' } });
  });

  it('a UI operation that finds no connection shows offline only until a pass gets through', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b');
    b.sync.start();
    await clock.advance(0, [b]);
    b.down = true;
    expect(await fail(b.sync.peekCode(code(a)))).toBe('offline');
    expect(b.sync.status.state).toBe('offline');
    b.down = false;
    await clock.advance(10_000, [b]);
    expect(b.sync.status.state).toBe('saved');
    b.sync.stop();
  });

  it('a full scan asked for and cut short by a failure is still a full scan when retried', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = device(host, clock, notes, 'b');
    await b.sync.linkCode(code(a));
    a.sync.start();
    await clock.advance(0, [a]);
    a.sync.hidden();
    await clock.advance(0, [a]);
    write(b, 'b', 'from b');
    await b.sync.sync();
    await clock.advance(2 * 60_000, [a]);
    host.failNext(0, 1, new RegExp(`^GET /api/rooms/${account(a)}`));
    a.sync.visible();
    await clock.advance(10_000, [a]);
    expect(held(a).b?.text).toBe('from b');
    a.sync.stop();
  });

  it("the connection coming back retries a dropped request at once, but still waits out a server's Retry-After", async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    const puts = () => host.requests('PUT').length;
    write(d, 'a', 'oat milk');
    host.failNext(0, 1, /^PUT /);
    d.sync.soon();
    await clock.advance(0, [d]);
    const dropped = puts();
    d.sync.online();
    await clock.advance(0, [d]);
    expect(puts()).toBe(dropped + 1);
    write(d, 'a', 'soy milk');
    host.retryAfter = 120;
    host.failNext(429, 1, /^PUT /);
    d.sync.soon();
    await clock.advance(0, [d]);
    const limited = puts();
    d.sync.online();
    await clock.advance(60_000, [d]);
    expect(puts()).toBe(limited);
    await clock.advance(60_000, [d]);
    expect(puts()).toBe(limited + 1);
    expect(d.sync.status.items['note/a']).toBe('saved');
    d.sync.stop();
  });

  it('a request that never answers fails as no connection, and a UI operation does not wait behind it', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock), b = await backedUp(host, clock, 'b');
    write(b, 'b', 'edited');
    b.stall = /^PUT /;
    const pass = b.sync.sync();
    expect((await b.sync.peekCode(code(a))).same).toBe(false);
    b.release();
    await pass;
    expect(textOn(host, account(b), 'b')).toBe('edited');
  });

  it('a room at its cap (413): new keys wait, existing ones still update, and it says full', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    host.maxKeys = 2;
    write(d, 'a', 'oat milk');
    write(d, 'z', 'one too many');
    await d.sync.sync({ full: true });
    expect(textOn(host, account(d), 'a')).toBe('oat milk');
    expect(textOn(host, account(d), 'z')).toBeUndefined();
    expect(d.sync.status).toMatchObject({ problem: 'full', items: { 'note/a': 'saved', 'note/z': 'failed' } });
    host.maxKeys = 256;
    await d.sync.sync({ full: true });
    expect(d.sync.status).toMatchObject({ problem: null, items: { 'note/z': 'saved' } });
  });

  it('the app at its storage ceiling (507): every upload pauses for 30 minutes', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    host.appBytes = 0;
    write(d, 'a', 'oat milk');
    d.sync.soon();
    await clock.advance(0, [d]);
    expect(d.sync.status.problem).toBe('full');
    const puts = () => host.requests('PUT').length, before = puts();
    host.appBytes = 64 * 1024 * 1024;
    write(d, 'a', 'milk again');
    d.sync.soon();
    await clock.advance(29 * 60_000, [d]);
    expect(puts()).toBe(before);
    await clock.advance(60_000, [d]);
    expect(d.sync.status).toMatchObject({ problem: null, items: { 'note/a': 'saved' } });
    d.sync.stop();
  });

  it('an edge cache keeping a 404 for minutes never makes a room look lost or absent', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock), room = account(d);
    host.cdn = 3 * 60_000;
    host.failNext(404, 1, new RegExp(`^GET /api/rooms/${room}$`));
    await d.sync.sync({ full: true });
    expect(host.log.filter(l => l.startsWith(`GET /api/rooms/${room}`)).slice(-2)).toEqual([`GET /api/rooms/${room} 404`, `GET /api/rooms/${room} 200`]);
    write(d, 'a', 'oat milk');
    await d.sync.sync();
    expect(textOn(host, room, 'a')).toBe('oat milk');
    expect(d.sync.status.problem).toBeNull();
  });

  it('the account room gone: lost only once its 404s span LOST_GAP; a new code uploads everything', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock), old = account(d);
    host.rooms.delete(old);
    await d.sync.sync({ full: true });
    expect(d.sync.status.problem).toBeNull();
    clock.t += 5 * 60_000;
    await d.sync.sync({ full: true });
    expect(d.sync.status.problem).toBeNull();
    clock.t += LOST_GAP;
    await d.sync.sync({ full: true });
    expect(d.sync.status).toMatchObject({ problem: 'lost', items: { 'note/a': 'saved' } });
    write(d, 'a', 'kept here');
    expect(d.sync.status.items['note/a']).toBe('failed');
    const made = await d.sync.remakeAccount();
    expect(made).toBe(codeFromRoom(account(d)));
    expect(keysOf(host, account(d))).toEqual(['account', 'note/a']);
    expect(textOn(host, account(d), 'a')).toBe('kept here');
    expect(d.sync.status.problem).toBeNull();
    expect(d.heard.account.at(-1)).toEqual({ code: made });
  });

  it('an app killed mid-round loses nothing: the next start uploads the rest', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    write(d, 'a', 'oat milk');
    host.failNext(0, 1, /^PUT .*\/note\/a/);
    await d.sync.sync();
    const again = device(host, clock, notes, 'a', d.storage);
    expect(dirty(notes, again.local.store).map(x => x.key)).toEqual(['note/a']);
    await again.sync.sync({ full: true });
    expect(textOn(host, account(d), 'a')).toBe('oat milk');
    expect(dirty(notes, again.local.store)).toEqual([]);
  });

  it("a newer build's doc is left alone and reported", async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    await host.fetch(`https://x/api/rooms/${account(d)}/note/a`, { method: 'PUT', body: JSON.stringify({ v: 2, id: 'a' }) });
    await d.sync.sync({ full: true });
    expect(d.sync.status.newer).toBe(true);
    expect(host.snapshot(account(d))['note/a']).toEqual({ v: 2, id: 'a' });
  });
});

describe('triggers', () => {
  it('a local change is saved 15 s after changes stop, and never over a minute after the first', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    const puts = () => host.requests('PUT').length, base = puts();
    write(d, 'a', 'one');
    await clock.advance(10_000, [d]);
    write(d, 'a', 'two');
    await clock.advance(14_000, [d]);
    expect(puts()).toBe(base);
    await clock.advance(1000, [d]);
    expect(puts()).toBe(base + 1);
    for (let i = 0; i < 7; i++) {
      write(d, 'a', `edit ${i}`);
      await clock.advance(10_000, [d]);
    }
    expect(puts()).toBeGreaterThan(base + 1);
    d.sync.stop();
  });

  it('going to the background sends what is dirty as keepalive PUTs; back after a minute, a full scan', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    write(d, 'a', 'oat milk');
    d.sync.hidden();
    await clock.advance(0, [d]);
    expect(d.keepalive).toEqual([`PUT /api/rooms/${account(d)}/note/a`]);
    expect(d.sync.status.items['note/a']).toBe('saved');
    const scans = () => host.requests('GET', new RegExp(`${account(d)} `)).length, before = scans();
    await clock.advance(2 * 60_000, [d]);
    d.sync.visible();
    await clock.advance(0, [d]);
    expect(scans()).toBe(before + 1);
    d.sync.stop();
  });

  it('every pass runs under the tab lock', async () => {
    const { host, clock } = fakeWorld(), l = device(host, clock, notes, 'a').local;
    let locked = 0;
    const api = { create: async () => 'f0000000-0000-4000-8000-000000000001', scan: async () => ({}), get: async () => ({}), put: async () => {}, delete: async () => {} };
    const s = new Sync(l, api, clock, fn => { locked++; return fn(); });
    l.edit((st, now) => writeNote(st, 'a', 'milk', now));
    await s.sync();
    await s.sync();
    expect(locked).toBe(2);
  });
});

describe('restarts', () => {
  it('stopping drops a save still waiting, and the first change after starting again waits the full 15 s', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    d.sync.start();
    await clock.advance(0, [d]);
    const puts = () => host.requests('PUT').length, base = puts();
    write(d, 'a', 'one');
    await clock.advance(10_000, [d]);
    d.sync.stop();
    await clock.advance(2 * 60_000, [d]);
    expect(puts()).toBe(base);
    d.sync.start();
    await clock.advance(0, [d]);
    expect(textOn(host, account(d), 'a')).toBe('one');
    const started = puts();
    write(d, 'a', 'two');
    await clock.advance(14_000, [d]);
    expect(puts()).toBe(started);
    await clock.advance(1000, [d]);
    expect(textOn(host, account(d), 'a')).toBe('two');
    d.sync.stop();
  });

  it('a restarted app keeps its account and acks: nothing is sent twice', async () => {
    const { host, clock } = fakeWorld(), d = await backedUp(host, clock);
    const puts = host.requests('PUT').length, again = device(host, clock, notes, 'a', d.storage);
    expect(again.local.store.account).toBe(account(d));
    await again.sync.sync({ full: true });
    expect(host.requests('PUT')).toHaveLength(puts);
    expect(again.sync.status.state).toBe('saved');
  });

  it('two tabs: the second adopts nothing when the first already made the account', async () => {
    const { host, clock } = fakeWorld(), storage = memoryStorage(), a = device(host, clock, notes, 'a', storage), b = device(host, clock, notes, 'a', storage);
    write(a, 'a', 'milk');
    b.local.reload();
    await Promise.all([a.sync.sync(), b.sync.sync()]);
    expect(host.requests('POST')).toHaveLength(2);
    b.local.reload();
    expect(b.local.store.account).toBe(a.local.store.account);
  });

  it('a model of another app on the same server keeps its own account', async () => {
    const { host, clock } = fakeWorld(), storage = memoryStorage(), n = device(host, clock, notes, 'n', storage);
    write(n, 'a', 'milk');
    await n.sync.sync();
    const other: Model<Note> = { ...notes, prefix: 'todo.v2.', salt: 'todo/public/' }, t = device(host, clock, other, 't', storage);
    expect(t.local.store.account).toBeNull();
  });
});
