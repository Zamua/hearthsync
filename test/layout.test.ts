import { describe, it, expect } from 'vitest';
import { codeFromRoom } from '../src/code.js';
import { canon, hash, lww, type Reg } from '../src/crdt.js';
import { makeRng } from '../src/rng.js';
import { acknowledge, chips, dirty, plan, roomDocs, roomsOf, type Plan } from '../src/plan.js';
import { adoptAccount, emptyStore, joinRoom, placed, shareRecord, type LocalStore } from '../src/store.js';
import type { SyncError } from '../src/sync.js';
import { device, fakeWorld, type Device, type FakeRooms, type TestClock } from '../src/testing/index.js';
import {
  boardKey, boards, boardsOf, corkKey, corks, deleteBoard, editBoard, editCork, leaveCork, leavingBoards, pinsOf, type Cork,
} from './models.js';

const C1 = corkKey('c1'), B1 = boardKey('b1');
const account = <R>(d: Device<R>) => d.local.store.account!;
const keysOf = (host: FakeRooms, room: string) => Object.keys(host.snapshot(room)).sort();
const fail = (p: Promise<unknown>) => p.then(() => 'ok', (e: SyncError) => e.kind);
const cork = (d: Device<Cork>, o: { title?: string; pin?: string; star?: string } = {}) => d.local.edit((s, now) => editCork(s, 'c1', now, o));

/** a shares a corkboard; b, another account, joins it. */
async function corkPair(host: FakeRooms, clock: TestClock) {
  const a = device(host, clock, corks, 'a');
  cork(a, { title: 'trip', pin: 'map', star: 'map' });
  await a.sync.sync();
  const room = await a.sync.share(C1), b = device(host, clock, corks, 'b');
  expect(await b.sync.join(room)).toBe(C1);
  await b.sync.sync();
  await a.sync.sync();
  return { a, b, room };
}

describe('a record laid out over its room', () => {
  it('spreads one key per field and pin, never the fields an account keeps to itself', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    expect(keysOf(host, room)).toEqual(['id', 'made', 'pin/map', 'title']);
    expect(host.snapshot(room).title).toEqual({ v: 1, title: { val: 'trip', t: expect.any(Number) } });
    expect(pinsOf(b.local.store, 'c1')).toEqual(['map']);
    expect(Object.keys(b.local.store.records[C1]!.starred)).toEqual([]);
    expect(Object.keys(a.local.store.records[C1]!.starred)).toEqual(['map']);
    expect(dirty(corks, a.local.store).concat(dirty(corks, b.local.store))).toEqual([]);
  });

  it('two members pinning at once both keep their pins', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    cork(a, { pin: 'tickets' });
    cork(b, { pin: 'hotel' });
    await Promise.all([a.sync.sync(), b.sync.sync()]);
    await a.sync.sync({ full: true });
    await b.sync.sync({ full: true });
    expect(keysOf(host, room)).toEqual(['id', 'made', 'pin/hotel', 'pin/map', 'pin/tickets', 'title']);
    expect(pinsOf(a.local.store, 'c1')).toEqual(['hotel', 'map', 'tickets']);
    expect(pinsOf(b.local.store, 'c1')).toEqual(pinsOf(a.local.store, 'c1'));
    expect(host.snapshot(account(a))[C1]).toMatchObject({ pins: { hotel: expect.any(Number), tickets: expect.any(Number) } });
    expect(a.heard.news.flatMap(n => n.keys)).toContain(C1);
  });

  it('never writes a write-once key again, whatever the server holds there', async () => {
    const { host, clock } = fakeWorld(), { a, room } = await corkPair(host, clock);
    await host.fetch(`https://x/api/rooms/${room}/made`, { method: 'PUT', body: JSON.stringify({ v: 1, at: 7 }) });
    const puts = host.requests('PUT', /\/(id|made) /).length;
    cork(a, { pin: 'late' });
    await a.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(host.requests('PUT', /\/(id|made) /)).toHaveLength(puts);
    expect(host.snapshot(room).made).toEqual({ v: 1, at: 7 });
    expect(host.snapshot(room)['pin/late']).toBeTruthy();
    expect(dirty(corks, a.local.store)).toEqual([]);
  });

  it('keeps its room register in the record: the account room lists no shared rooms, and another device finds it there', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    expect(a.local.store.shared).toEqual({});
    expect(keysOf(host, account(b))).toEqual(['account', C1]);
    expect(host.snapshot(account(b))[C1]).toMatchObject({ room: { val: room } });
    const b2 = device(host, clock, corks, 'b2');
    await b2.sync.linkCode(codeFromRoom(account(b)));
    expect(placed(corks, b2.local.store)[C1]?.val).toBe(room);
    cork(a, { pin: 'late' });
    await a.sync.sync();
    await b2.sync.sync({ full: true });
    expect(pinsOf(b2.local.store, 'c1')).toContain('late');
  });

  it('peek and join find the record through roomKey; a room without one is not found', async () => {
    const { host, clock } = fakeWorld(), { a, room } = await corkPair(host, clock);
    cork(a, { pin: 'late' });
    await a.sync.sync();
    const c = device(host, clock, corks, 'c');
    const seen = await c.sync.peek(room);
    expect(seen).toMatchObject({ key: C1, room, record: { title: { val: 'trip' } } });
    expect(Object.keys(seen.record.pins).sort()).toEqual(['late', 'map']);
    expect(c.local.store.records).toEqual({});
    expect(await fail(c.sync.join(host.make({ title: { v: 1, title: { val: 'x', t: 1 } } })))).toBe('notfound');
    expect(await fail(c.sync.join(account(a)))).toBe('notfound');
  });
});

describe('two devices of one account sharing a laid out record at once', () => {
  it('the later share wins in the record on both; the other room forwards there, and its members follow', async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, corks, 'a');
    cork(a, { title: 'trip' });
    await a.sync.sync();
    const a2 = device(host, clock, corks, 'a2');
    await a2.sync.linkCode(codeFromRoom(account(a)));
    const first = await a.sync.share(C1);
    clock.t += 10;
    const second = await a2.sync.share(C1);
    const b = device(host, clock, corks, 'b');
    expect(await b.sync.join(first)).toBe(C1);
    await a.sync.sync({ full: true });
    await a2.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(a.local.store.records[C1]!.room?.val).toBe(second);
    expect(a2.local.store.records[C1]!.room?.val).toBe(second);
    expect(host.snapshot(first).forward).toMatchObject({ v: 1, to: second });
    cork(b, { pin: 'from-b' });
    await b.sync.sync({ full: true });
    expect(b.local.store.records[C1]!.room?.val).toBe(second);
    await b.sync.sync({ full: true });
    await a2.sync.sync({ full: true });
    expect(pinsOf(a2.local.store, 'c1')).toEqual(['from-b']);
  });
});

describe("leaving a laid out record (deleting is this account's alone)", () => {
  it('keeps the room for the others; the leaver stops syncing it once it owes nothing', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    cork(b, { pin: 'last' });
    b.local.edit((s, now) => leaveCork(s, 'c1', now));
    expect(roomsOf(corks, b.local.store)).toContain(room);
    await b.sync.sync();
    expect(host.snapshot(room)['pin/last']).toBeTruthy();
    expect(roomsOf(corks, b.local.store)).toEqual([account(b)]);
    expect(host.snapshot(account(b))[C1]).toMatchObject({ left: expect.any(Number) });
    cork(a, { pin: 'after' });
    await a.sync.sync();
    const reads = host.requests('GET', new RegExp(room)).length;
    await b.sync.sync({ full: true });
    expect(host.requests('GET', new RegExp(room))).toHaveLength(reads);
    expect(pinsOf(a.local.store, 'c1')).toEqual(['after', 'last', 'map']);
    expect(b.local.store.records[C1]!.pins).not.toHaveProperty('after');
  });

  it('joining again brings it back, with what the room gained meanwhile', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    b.local.edit((s, now) => leaveCork(s, 'c1', now));
    await b.sync.sync();
    cork(a, { pin: 'after' });
    await a.sync.sync();
    clock.t += 1000;
    expect(await b.sync.join(room)).toBe(C1);
    const r = b.local.store.records[C1]!;
    expect(r.u > r.left).toBe(true);
    expect(pinsOf(b.local.store, 'c1')).toEqual(['after', 'map']);
  });

  it('a record left before it was ever used here, and never uploaded to its room, owes the room nothing', () => {
    const room = 'f0000000-0000-4000-8000-0000000000aa';
    const s = { ...emptyStore<Cork>(), records: { [C1]: { id: 'c1', room: { val: room, t: 1 }, title: { val: 'x', t: 1 }, made: 0, u: 0, left: 5, pins: {}, starred: {} } } };
    expect(roomsOf(corks, s)).toEqual([]);
    const used = { ...s, records: { [C1]: { ...s.records[C1], u: 2 } } };
    expect(roomsOf(corks, used)).toEqual([room]);
    expect(plan(corks, used, room, {}).puts.map(p => p.key).sort()).toEqual(['id', 'title']);
  });
});

describe('Sync.leave on a whole record', () => {
  async function boardPair(host: FakeRooms, clock: TestClock) {
    const a = device(host, clock, boards, 'a');
    a.local.edit((s, now) => editBoard(s, B1, now, { title: 'ours' }));
    await a.sync.sync();
    const room = await a.sync.share(B1), b = device(host, clock, boards, 'b');
    await b.sync.join(room);
    await b.sync.sync();
    return { a, b, room };
  }

  it('keeps the record live and private in the account room, and the room carries on for the others', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await boardPair(host, clock);
    await b.sync.leave(B1);
    expect(boardsOf(b.local.store)[B1]).toEqual({ title: 'ours', pins: [] });
    expect(roomsOf(boards, b.local.store)).toEqual([account(b)]);
    await b.sync.sync();
    expect(host.snapshot(account(b)).shared).toMatchObject({ rooms: { [B1]: { val: '' } } });
    b.local.edit((s, now) => editBoard(s, B1, now, { pin: 'mine' }));
    a.local.edit((s, now) => editBoard(s, B1, now, { pin: 'theirs' }));
    await b.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(boardsOf(a.local.store)[B1]!.pins).toEqual(['theirs']);
    expect(boardsOf(b.local.store)[B1]!.pins).toEqual(['mine']);
    expect(host.snapshot(account(b))[B1]).toMatchObject({ pins: { mine: expect.any(Number) } });
    const b2 = device(host, clock, boards, 'b2');
    await b2.sync.linkCode(codeFromRoom(account(b)));
    expect(roomsOf(boards, b2.local.store)).toEqual([account(b)]);
  });

  it('works offline, and sharing again makes a new room', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await boardPair(host, clock);
    clock.on = false;
    await b.sync.leave(B1);
    expect(roomsOf(boards, b.local.store)).toEqual([account(b)]);
    clock.on = true;
    const again = await b.sync.share(B1);
    expect(again).not.toBe(room);
  });

  it("with deletes: 'account', deleting is leaving: the tombstone never reaches the room", async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, leavingBoards, 'a');
    a.local.edit((s, now) => editBoard(s, B1, now, { title: 'ours' }));
    await a.sync.sync();
    const room = await a.sync.share(B1), b = device(host, clock, leavingBoards, 'b');
    await b.sync.join(room);
    b.local.edit((s, now) => deleteBoard(s, B1, now));
    await b.sync.sync();
    expect(host.snapshot(room)[B1]).toMatchObject({ deleted: 0 });
    expect(roomsOf(leavingBoards, b.local.store)).toEqual([account(b)]);
    expect(await device(host, clock, leavingBoards, 'c').sync.join(room)).toBe(B1);
    clock.t += 1000;
    await b.sync.join(room);
    expect(boardsOf(b.local.store)[B1]).toEqual({ title: 'ours', pins: [] });
  });
});

describe('a fed room', () => {
  it("is read from the app's live copy instead of scans, and a change fed in lands in the account room", async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    const kv = new Map(Object.entries(host.snapshot(room))), feed = { ready: true, kv };
    const detach = b.sync.attach(room, feed);
    b.sync.start();
    const scans = () => b.sent.filter(l => l === `GET /api/rooms/${room}`).length, before = scans();
    cork(a, { pin: 'live' });
    await a.sync.sync();
    for (const [k, v] of Object.entries(host.snapshot(room))) kv.set(k, v);
    b.sync.fed(room);
    await clock.advance(200, [a, b]);
    expect(scans()).toBe(before);
    expect(pinsOf(b.local.store, 'c1')).toContain('live');
    await clock.advance(60_000, [a, b]);
    expect(host.snapshot(account(b))[C1]).toMatchObject({ pins: { live: expect.any(Number) } });
    detach();
    await b.sync.sync({ full: true });
    expect(scans()).toBeGreaterThan(before);
    b.sync.stop();
  });

  it('a feed not ready yet is passed over for a scan', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await corkPair(host, clock);
    b.sync.attach(room, { ready: false, kv: new Map() });
    const scans = () => b.sent.filter(l => l === `GET /api/rooms/${room}`).length, before = scans();
    await b.sync.sync({ full: true });
    expect(scans()).toBe(before + 1);
  });
});

describe('holding the account room', () => {
  it('passes leave it for later while shared rooms sync, and letting go runs what waited', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await corkPair(host, clock);
    b.sync.start();
    await clock.advance(100, [a, b]);
    b.sync.hold(true);
    cork(b, { pin: 'held' });
    const before = host.requests('PUT', new RegExp(account(b))).length;
    await clock.advance(20_000, [a, b]);
    expect(host.snapshot(room)['pin/held']).toBeTruthy();
    expect(host.requests('PUT', new RegExp(account(b)))).toHaveLength(before);
    b.sync.hold(false);
    await clock.advance(100, [a, b]);
    expect(host.snapshot(account(b))[C1]).toMatchObject({ pins: { held: expect.any(Number) } });
    b.sync.stop();
  });
});

describe('chips of a laid out record', () => {
  it('wait until its keys are in its room too, unless that room is passed over', async () => {
    const { host, clock } = fakeWorld(), { a, room } = await corkPair(host, clock);
    expect(a.sync.status.items[C1]).toBe('saved');
    host.failNext(500, 10, new RegExp(`PUT /api/rooms/${room}`));
    cork(a, { pin: 'stuck' });
    await a.sync.sync();
    expect(host.snapshot(account(a))[C1]).toMatchObject({ pins: { stuck: expect.any(Number) } });
    expect(a.sync.status.items[C1]).not.toBe('saved');
    expect(chips(corks, a.local.store).items[C1]).toBe('waiting');
    expect(chips(corks, a.local.store, r => r === room).items[C1]).toBe('saved');
  });
});

describe('random histories of two accounts pinning to a laid out corkboard converge', () => {
  type Server = Map<string, Map<string, unknown>>;
  const snap = (srv: Server, room: string): Record<string, unknown> => Object.fromEntries(srv.get(room) ?? []);
  const RA = '11111111-2222-4333-8444-555555555555', RB = '22222222-2222-4333-8444-555555555555', RS = '33333333-2222-4333-8444-555555555555';

  function push(srv: Server, p: Plan<Cork>): LocalStore<Cork> {
    let out = p.store;
    for (const put of p.puts) {
      srv.get(put.room)?.set(put.key, JSON.parse(JSON.stringify(put.value)));
      out = acknowledge(out, put.room, put.key, put.hash);
    }
    return out;
  }

  function rounds(d: { s: LocalStore<Cork> }, srv: Server): number {
    let moved = 0;
    for (const room of roomsOf(corks, d.s)) {
      const p = plan(corks, d.s, room, snap(srv, room));
      d.s = push(srv, p);
      moved += p.puts.length + p.news.length;
    }
    return moved;
  }

  it('no pin is lost, the title is the last edit made, the room holds what each device would, and each account keeps its own', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = makeRng(seed), srv: Server = new Map([[RA, new Map()], [RB, new Map()], [RS, new Map()]]);
      const start = (room: string) => adoptAccount(emptyStore<Cork>(), room, 900, corks.salt);
      const ds = [{ s: shareRecord(corks, editCork(start(RA), 'c1', 1000, { title: 'first' }), C1, RS, 1001), skew: 0 }, { s: start(RA), skew: 3 }, { s: start(RB), skew: -2 }];
      ds[0]!.s = push(srv, plan(corks, ds[0]!.s, RS, {}));
      const joined = joinRoom(corks, ds[2]!.s, RS, snap(srv, RS), 1002);
      if (typeof joined === 'string') throw new Error(joined);
      ds[2]!.s = joined.store;
      const pins = new Set<string>(), titles: Reg<string>[] = [ds[0]!.s.records[C1]!.title];
      let now = 1100;
      for (let step = 0; step < 150; step++) {
        now += rng.int(0, 2);
        const d = rng.pick(ds), op = rng.int(0, 9);
        if (op <= 4) {
          if (!d.s.records[C1]) continue;
          const o = rng.next() < 0.4 ? { title: rng.pick(['red', 'blue', 'green']) } : rng.next() < 0.7 ? { pin: rng.pick(['p1', 'p2', 'p3', 'p4', 'p5']) } : { star: rng.pick(['p1', 'p2']) };
          d.s = editCork(d.s, 'c1', now + d.skew, o);
          const r = d.s.records[C1]!;
          for (const p of Object.keys(r.pins)) pins.add(p);
          titles.push(r.title);
        } else if (op === 5) {
          const [x, y] = [rng.pick(ds), rng.pick(ds)], read = snap(srv, RS);
          if (!roomsOf(corks, x.s).includes(RS) || !roomsOf(corks, y.s).includes(RS)) continue;
          const px = plan(corks, x.s, RS, read), py = plan(corks, y.s, RS, read);
          x.s = push(srv, px);
          y.s = push(srv, py);
        } else rounds(d, srv);
      }
      let quiet = false;
      for (let pass = 0; pass < 12 && !quiet; pass++) quiet = ds.reduce((n, d) => n + rounds(d, srv), 0) === 0;
      expect(quiet).toBe(true);
      const [a, a2, b] = ds.map(d => d.s.records[C1]!);
      expect(canon(a2)).toBe(canon(a));
      for (const r of [a!, b!]) {
        expect(Object.keys(r.pins).sort()).toEqual([...pins].sort());
        expect(canon(r.title)).toBe(canon(titles.reduce(lww)));
      }
      for (const d of ds) {
        expect(dirty(corks, d.s)).toEqual([]);
        expect(canon(roomDocs(corks, d.s, RS))).toBe(canon(snap(srv, RS)));
        expect(canon(roomDocs(corks, d.s, d.s.account!))).toBe(canon(snap(srv, d.s.account!)));
      }
      for (const [k, v] of Object.entries(snap(srv, RS))) expect(ds[2]!.s.acks[RS]![k]).toBe(hash(v));
    }
  }, 30000);
});
