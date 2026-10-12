import { describe, it, expect } from 'vitest';
import { codeFromRoom } from '../src/code.js';
import { canon, hash, lww, type Reg } from '../src/crdt.js';
import { makeRng, type Rng } from '../src/rng.js';
import { acknowledge, dirty, plan, roomDocs, roomsOf, type Plan } from '../src/plan.js';
import { adoptAccount, emptyStore, followRoom, joinRoom, shareRecord, type LocalStore } from '../src/store.js';
import { LOST_GAP, type SyncError } from '../src/sync.js';
import { device, fakeWorld, type Device, type FakeRooms, type TestClock } from '../src/testing/index.js';
import { boardKey, boards, boardsOf, deleteBoard, editBoard, listKey, type Board } from './models.js';

const edit = (d: Device<Board>, key: string, o: { title?: string; pin?: string }) => d.local.edit((s, now) => editBoard(s, key, now, o));
const account = <R>(d: Device<R>) => d.local.store.account!;
const keysOf = (host: FakeRooms, room: string) => Object.keys(host.snapshot(room)).sort();
const fail = (p: Promise<unknown>) => p.then(() => 'ok', (e: SyncError) => e.kind);
const B1 = boardKey('b1');

/** A device with a board and a list of its own, backed up. */
async function backedUp(host: FakeRooms, clock: TestClock, name: string): Promise<Device<Board>> {
  const d = device(host, clock, boards, name);
  edit(d, B1, { title: `${name}'s board` });
  edit(d, listKey(name), { title: 'mine' });
  await d.sync.sync();
  return d;
}

/** a shares its board; b, another account, joins it. */
async function sharedPair(host: FakeRooms, clock: TestClock) {
  const a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1);
  const b = device(host, clock, boards, 'b');
  edit(b, listKey('b'), { title: 'mine' });
  await b.sync.sync();
  expect(await b.sync.join(room)).toBe(B1);
  await b.sync.sync();
  return { a, b, room };
}

describe('sharing a record', () => {
  it('makes its room once, uploads the record there, and lists the room in the account', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a');
    const posts = host.requests('POST').length, room = await a.sync.share(B1);
    expect(host.requests('POST')).toHaveLength(posts + 1);
    expect(keysOf(host, room)).toEqual([B1]);
    expect(host.snapshot(room)[B1]).toMatchObject({ title: { val: "a's board" } });
    await a.sync.sync();
    expect(keysOf(host, account(a))).toEqual(['account', B1, listKey('a'), 'shared']);
    expect(host.snapshot(account(a)).shared).toMatchObject({ v: 1, rooms: { [B1]: { val: room } } });
    expect(dirty(boards, a.local.store)).toEqual([]);
  });

  it('is idempotent: sharing again returns the same room, and sends nothing when nothing changed', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1);
    await a.sync.sync();
    const sent = host.log.length;
    expect(await a.sync.share(B1)).toBe(room);
    expect(host.log).toHaveLength(sent);
    expect(host.requests('POST')).toHaveLength(2);
  });

  it('works before the account room exists, which then lists it', async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, boards, 'a');
    edit(a, B1, { title: 'early' });
    const room = await a.sync.share(B1);
    expect(account(a)).toBeFalsy();
    await a.sync.sync();
    expect(host.snapshot(account(a)).shared).toMatchObject({ rooms: { [B1]: { val: room } } });
  });

  it('refuses a record that is not shareable, absent or deleted, and needs a connection', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a');
    expect(await fail(a.sync.share(listKey('a')))).toBe('notfound');
    expect(await fail(a.sync.share(boardKey('nope')))).toBe('notfound');
    a.local.edit((s, now) => deleteBoard(s, B1, now));
    expect(await fail(a.sync.share(B1))).toBe('notfound');
    clock.on = false;
    expect(await fail(a.sync.share(B1))).toBe('offline');
  });

  it("the account's own records never reach a shared room, and a shared room is not an account", async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock);
    expect(keysOf(host, room)).toEqual([B1]);
    expect(keysOf(host, account(b))).toEqual(['account', B1, listKey('b'), 'shared']);
    expect(Object.keys(b.local.store.records).sort()).toEqual([B1, listKey('b')]);
    expect(await fail(b.sync.peekCode(codeFromRoom(room)))).toBe('notaccount');
    expect(account(a)).not.toBe(account(b));
  });
});

describe('joining from an invite', () => {
  it('another account joins by the room id; edits on either side converge', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock);
    expect(boardsOf(b.local.store)[B1]).toEqual({ title: "a's board", pins: [] });
    edit(a, B1, { pin: 'photo' });
    clock.t += 10;
    edit(b, B1, { title: 'our board', pin: 'map' });
    await a.sync.sync();
    await b.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(boardsOf(a.local.store)[B1]).toEqual({ title: 'our board', pins: ['photo', 'map'] });
    expect(boardsOf(b.local.store)[B1]).toEqual(boardsOf(a.local.store)[B1]);
    expect(host.snapshot(room)[B1]).toEqual(host.snapshot(account(a))[B1]);
    expect(host.snapshot(account(b))[B1]).toEqual(host.snapshot(room)[B1]);
    expect(a.heard.news.flatMap(n => n.keys)).toContain(B1);
    expect(b.heard.news.flatMap(n => n.keys)).toContain(B1);
    expect(dirty(boards, a.local.store).concat(dirty(boards, b.local.store))).toEqual([]);
  });

  it("a second device of the joiner's account syncs the shared room too, found through the account room", async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock);
    const b2 = device(host, clock, boards, 'b2');
    await b2.sync.linkCode(codeFromRoom(account(b)));
    expect(b2.local.store.shared[B1]?.val).toBe(room);
    edit(a, B1, { pin: 'late' });
    await a.sync.sync();
    await b2.sync.sync({ full: true });
    expect(boardsOf(b2.local.store)[B1]?.pins).toEqual(['late']);
  });

  it('joining twice changes nothing; a join survives a restart', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await sharedPair(host, clock);
    const before = canon(b.local.store);
    expect(await b.sync.join(room)).toBe(B1);
    expect(canon(b.local.store)).toBe(before);
    const again = device(host, clock, boards, 'b', b.storage);
    expect(again.local.store.shared).toEqual(b.local.store.shared);
    await again.sync.sync({ full: true });
    expect(dirty(boards, again.local.store)).toEqual([]);
  });

  it('a garbage id, an unknown room, an empty one and an account room are not found; offline is offline', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), b = device(host, clock, boards, 'b');
    const sent = host.log.length;
    expect(await fail(b.sync.join('not a room'))).toBe('notfound');
    expect(host.log).toHaveLength(sent);
    expect(await fail(b.sync.join('f0000000-0000-4000-8000-0000000000ff'))).toBe('notfound');
    expect(await fail(b.sync.join(host.make()))).toBe('notfound');
    expect(await fail(b.sync.join(account(a)))).toBe('notfound');
    expect(await fail(b.sync.join(host.make({ [B1]: { v: 1, id: 'other' } })))).toBe('notfound');
    clock.on = false;
    expect(await fail(b.sync.join(host.make()))).toBe('offline');
    expect(b.local.store.records).toEqual({});
  });

  it("a deleted record's room cannot be joined", async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1);
    a.local.edit((s, now) => deleteBoard(s, B1, now));
    await a.sync.sync();
    expect(await fail(device(host, clock, boards, 'b').sync.join(room))).toBe('notfound');
  });

  it("past its kind's cap, with no tombstone to make way, a join is refused as full", async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1);
    const b = device(host, clock, boards, 'b');
    for (const id of ['x', 'y', 'z']) edit(b, boardKey(id), { title: id });
    expect(await fail(b.sync.join(room))).toBe('full');
    b.local.edit((s, now) => deleteBoard(s, boardKey('x'), now));
    expect(await b.sync.join(room)).toBe(B1);
    expect(Object.keys(b.local.store.records).sort()).toEqual([B1, boardKey('y'), boardKey('z')]);
  });

  it('offline, a record already joined is joined from its copy', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await sharedPair(host, clock);
    clock.on = false;
    expect(await b.sync.join(room)).toBe(B1);
  });
});

describe('peeking at an invite', () => {
  it("reads the room's record, merged with this device's copy; offline, the copy alone", async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock);
    edit(a, B1, { pin: 'news' });
    await a.sync.sync();
    const stranger = device(host, clock, boards, 'c');
    const seen = await stranger.sync.peek(room);
    expect(seen).toMatchObject({ key: B1, room, record: { title: { val: "a's board" } } });
    expect(Object.keys(seen.record.pins)).toEqual(['news']);
    expect(stranger.local.store.records).toEqual({});
    edit(b, B1, { pin: 'mine' });
    expect(Object.keys((await b.sync.peek(room)).record.pins).sort()).toEqual(['mine', 'news']);
    clock.on = false;
    expect(Object.keys((await b.sync.peek(room)).record.pins)).toEqual(['mine']);
    expect(await fail(stranger.sync.peek(room))).toBe('offline');
  });

  it('fails as not found for a room with no shared record', async () => {
    const { host, clock } = fakeWorld(), d = device(host, clock, boards, 'c');
    expect(await fail(d.sync.peek(host.make()))).toBe('notfound');
    expect(await fail(d.sync.peek('nope'))).toBe('notfound');
  });
});

describe('a retired shared room', () => {
  /** The board moves to a new room, and the old one forwards there. */
  async function retire(host: FakeRooms, from: string): Promise<string> {
    const to = host.make({ [B1]: host.snapshot(from)[B1] });
    await host.fetch(`https://x/api/rooms/${from}/forward`, { method: 'PUT', body: JSON.stringify({ v: 1, to, at: 5 }) });
    return to;
  }

  it('its members follow the forward, keep syncing in the new room, and tell their accounts', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock), to = await retire(host, room);
    await a.sync.sync({ full: true });
    await b.sync.sync({ full: true });
    expect(a.local.store.shared[B1]?.val).toBe(to);
    expect(b.local.store.shared[B1]?.val).toBe(to);
    expect(host.snapshot(account(b)).shared).toMatchObject({ rooms: { [B1]: { val: to } } });
    edit(a, B1, { pin: 'moved' });
    await a.sync.sync();
    await b.sync.sync({ full: true });
    expect(boardsOf(b.local.store)[B1]?.pins).toEqual(['moved']);
    expect(host.snapshot(room)[B1]).not.toMatchObject({ pins: { moved: expect.any(Number) } });
  });

  it('an old invite leads to the new room, for a peek and a join', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1), to = await retire(host, room);
    const b = device(host, clock, boards, 'b');
    expect((await b.sync.peek(room)).room).toBe(to);
    expect(await b.sync.join(room)).toBe(B1);
    expect(b.local.store.shared[B1]?.val).toBe(to);
  });

  it('two rooms forwarding to each other settle on the smaller id', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await sharedPair(host, clock);
    const other = host.make({ [B1]: host.snapshot(room)[B1], forward: { v: 1, to: room, at: 5 } });
    await host.fetch(`https://x/api/rooms/${room}/forward`, { method: 'PUT', body: JSON.stringify({ v: 1, to: other, at: 6 }) });
    await b.sync.sync({ full: true });
    await b.sync.sync({ full: true });
    expect(b.local.store.shared[B1]?.val).toBe([room, other].sort()[0]);
  });

  it('a room gone for LOST_GAP is reported; sharing again makes a new one', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), room = await a.sync.share(B1);
    host.rooms.delete(room);
    await a.sync.sync({ full: true });
    expect(a.sync.status.gone).toEqual([]);
    clock.t += LOST_GAP;
    await a.sync.sync({ full: true });
    expect(a.sync.status.gone).toEqual([B1]);
    expect(a.sync.status.problem).toBeNull();
    const fresh = await a.sync.share(B1);
    expect(fresh).not.toBe(room);
    expect(keysOf(host, fresh)).toEqual([B1]);
    expect(a.sync.status.gone).toEqual([]);
  });
});

describe('two devices of one account sharing at once', () => {
  it('the later share wins on both; the other room forwards there, and its members follow', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), a2 = device(host, clock, boards, 'a2');
    await a2.sync.linkCode(codeFromRoom(account(a)));
    const first = await a.sync.share(B1);
    clock.t += 10;
    const second = await a2.sync.share(B1);
    const b = device(host, clock, boards, 'b');
    expect(await b.sync.join(first)).toBe(B1);
    await a.sync.sync({ full: true });
    await a2.sync.sync({ full: true });
    await a.sync.sync({ full: true });
    expect(a.local.store.shared[B1]?.val).toBe(second);
    expect(a2.local.store.shared[B1]?.val).toBe(second);
    expect(host.snapshot(first).forward).toMatchObject({ v: 1, to: second });
    expect(host.snapshot(second).forward).toBeUndefined();
    expect(a.local.store.forwards).toEqual({});
    edit(b, B1, { pin: 'from-b' });
    await b.sync.sync({ full: true });
    expect(b.local.store.shared[B1]?.val).toBe(second);
    await b.sync.sync({ full: true });
    await a2.sync.sync({ full: true });
    expect(boardsOf(a2.local.store)[B1]?.pins).toEqual(['from-b']);
  });
});

describe('deleting a shared record', () => {
  it('reaches every member as a tombstone, and its room then leaves sync', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await sharedPair(host, clock);
    a.local.edit((s, now) => deleteBoard(s, B1, now));
    await a.sync.sync();
    expect(roomsOf(boards, a.local.store)).toEqual([account(a)]);
    await b.sync.sync({ full: true });
    expect(boardsOf(b.local.store)[B1]).toBeUndefined();
    expect(roomsOf(boards, b.local.store)).toEqual([account(b)]);
    const reads = host.requests('GET', new RegExp(room)).length;
    await b.sync.sync({ full: true });
    expect(host.requests('GET', new RegExp(room))).toHaveLength(reads);
  });
});

describe('purging a shared record', () => {
  it('drops its room with its tombstone, here and on the account\'s other devices', async () => {
    const { host, clock } = fakeWorld(), a = await backedUp(host, clock, 'a'), a2 = device(host, clock, boards, 'a2');
    await a2.sync.linkCode(codeFromRoom(account(a)));
    await a.sync.share(B1);
    await a.sync.sync();
    await a2.sync.sync({ full: true });
    expect(Object.keys(a2.local.store.shared)).toEqual([B1]);
    a.local.edit((s, now) => deleteBoard(s, B1, now));
    await a.sync.sync();
    await a2.sync.sync({ full: true });
    clock.t += boards.purgeAfter! + 60_000;
    await a.sync.sync({ full: true });
    expect(a.local.store.records[B1]).toBeUndefined();
    expect(a.local.store.shared).toEqual({});
    expect(keysOf(host, account(a))).not.toContain(B1);
    await a2.sync.sync({ full: true });
    expect(a2.local.store.records[B1]).toBeUndefined();
    expect(a2.local.store.shared).toEqual({});
    await a.sync.sync({ full: true });
    expect(a.local.store.shared).toEqual({});
    expect(device(host, clock, boards, 'a', a.storage).local.store.shared).toEqual({});
  });
});

// A model of a rooms server for the plan, as in plan.test.ts.
type Server = Map<string, Map<string, unknown>>;
const snap = (srv: Server, room: string): Record<string, unknown> => Object.fromEntries(srv.get(room) ?? []);

function push<R>(srv: Server, p: Plan<R>): LocalStore<R> {
  let out = p.store;
  for (const put of p.puts) {
    const room = srv.get(put.room);
    if (!room) continue;
    room.set(put.key, JSON.parse(JSON.stringify(put.value)));
    out = acknowledge(out, put.room, put.key, put.hash);
  }
  return out;
}

const RA = '11111111-2222-4333-8444-555555555555', RB = '22222222-2222-4333-8444-555555555555';
const RS = '33333333-2222-4333-8444-555555555555', RS2 = '44444444-2222-4333-8444-555555555555';

describe('the plan for a shared room', () => {
  it('takes only the records living there, and a forward moves them', () => {
    const s = shareRecord(boards, editBoard(adoptAccount(emptyStore<Board>(), RA, 900, boards.salt), B1, 1000, { title: 't' }), B1, RS, 1100);
    const stray = { v: 1, id: 'stray', title: { val: 'x', t: 5 }, pins: {}, u: 5, deleted: 0 };
    const p = plan(boards, s, RS, { [boardKey('stray')]: stray, [listKey('l')]: { ...stray, id: 'l' } });
    expect(Object.keys(p.store.records)).toEqual([B1]);
    expect(p.puts.map(x => x.key)).toEqual([B1]);
    const f = plan(boards, p.store, RS, { forward: { v: 1, to: RS2, at: 5 } });
    expect(f.forward).toBe(RS2);
    expect(f.puts).toEqual([]);
    const moved = followRoom(boards, f.store, RS, RS2, 1200);
    expect(roomDocs(boards, moved, RS)).toEqual({});
    expect(Object.keys(roomDocs(boards, moved, RS2))).toEqual([B1]);
  });

  it('a join keeps the key this device held, and a room with only junk is none', () => {
    const doc = { v: 1, id: 'b1', title: { val: 'theirs', t: 5 }, pins: { a: 5 }, u: 5, deleted: 0 };
    const s = editBoard(emptyStore<Board>(), B1, 1000, { pin: 'b' });
    const j = joinRoom(boards, s, RS, { [B1]: doc }, 1100);
    if (typeof j === 'string') throw new Error(j);
    expect(Object.keys(j.store.records[B1]!.pins).sort()).toEqual(['a', 'b']);
    expect(j.store.shared[B1]).toEqual({ val: RS, t: j.store.clock });
    expect(joinRoom(boards, s, RS, { junk: 1, [listKey('x')]: { ...doc, id: 'x' } }, 1100)).toBe('none');
  });
});

describe('random histories across two accounts sharing a board converge', () => {
  interface Dev { s: LocalStore<Board>; skew: number }

  /** One read, merge and upload of each room the device syncs: how much moved. */
  function rounds(d: Dev, srv: Server): number {
    let moved = 0;
    for (const room of roomsOf(boards, d.s)) {
      const p = plan(boards, d.s, room, snap(srv, room));
      d.s = push(srv, p);
      moved += p.puts.length + p.news.length;
    }
    return moved;
  }

  it('no pin is lost, every title is the last edit made, and every room holds what each device would', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng: Rng = makeRng(seed), srv: Server = new Map([[RA, new Map()], [RB, new Map()], [RS, new Map()]]);
      const start = (room: string) => adoptAccount(emptyStore<Board>(), room, 900, boards.salt);
      const owner = shareRecord(boards, editBoard(start(RA), B1, 1000, { title: 'first' }), B1, RS, 1001);
      const ds: Dev[] = [{ s: owner, skew: 0 }, { s: start(RA), skew: 3 }, { s: start(RB), skew: -2 }];
      ds[0]!.s = push(srv, plan(boards, ds[0]!.s, RS, {}));
      const joined = joinRoom(boards, ds[2]!.s, RS, snap(srv, RS), 1002);
      if (typeof joined === 'string') throw new Error(joined);
      ds[2]!.s = joined.store;
      const pins = new Set<string>(), titles: Reg<string>[] = [ds[0]!.s.records[B1]!.title];
      let now = 1100;
      for (let step = 0; step < 150; step++) {
        now += rng.int(0, 2);
        const d = rng.pick(ds), op = rng.int(0, 9);
        if (op <= 4) {
          const key = rng.next() < 0.8 || !d.s.account ? B1 : listKey(d.s.account === RA ? 'a' : 'b');
          if (key === B1 && !d.s.records[B1]) continue;
          d.s = editBoard(d.s, key, now + d.skew, rng.next() < 0.5 ? { title: rng.pick(['red', 'blue', 'green']) } : { pin: rng.pick(['p1', 'p2', 'p3', 'p4']) });
          const b = d.s.records[B1];
          if (b) { for (const p of Object.keys(b.pins)) pins.add(p); titles.push(b.title); }
        } else if (op === 5) {
          // Two devices read the shared room at once, then both write: the second clobbers the first.
          const [x, y] = [rng.pick(ds), rng.pick(ds)], read = snap(srv, RS);
          if (!roomsOf(boards, x.s).includes(RS) || !roomsOf(boards, y.s).includes(RS)) continue;
          const px = plan(boards, x.s, RS, read), py = plan(boards, y.s, RS, read);
          x.s = push(srv, px);
          y.s = push(srv, py);
        } else rounds(d, srv);
      }
      let quiet = false;
      for (let pass = 0; pass < 12 && !quiet; pass++) quiet = ds.reduce((n, d) => n + rounds(d, srv), 0) === 0;
      expect(quiet).toBe(true);
      const board = ds[0]!.s.records[B1]!;
      for (const d of ds) {
        expect(canon(d.s.records[B1])).toBe(canon(board));
        expect(dirty(boards, d.s)).toEqual([]);
        expect(canon(roomDocs(boards, d.s, RS))).toBe(canon(snap(srv, RS)));
        expect(canon(roomDocs(boards, d.s, d.s.account!))).toBe(canon(snap(srv, d.s.account!)));
      }
      expect(Object.keys(board.pins).sort()).toEqual([...pins].sort());
      expect(canon(board.title)).toBe(canon(titles.reduce(lww)));
      for (const [k, v] of Object.entries(snap(srv, RS))) expect(ds[2]!.s.acks[RS]![k]).toBe(hash(v));
    }
  }, 30000);
});
