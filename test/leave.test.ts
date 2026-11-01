import { describe, it, expect } from 'vitest';
import { LEFT, isNewer } from '../src/account.js';
import { codeFromRoom } from '../src/code.js';
import type { Kind, Model } from '../src/model.js';
import { roomsOf } from '../src/plan.js';
import { placed } from '../src/store.js';
import { device, fakeWorld, type Device, type FakeRooms, type TestClock } from '../src/testing/index.js';
import { boardKey, boards, boardsOf, corkKey, corks, editBoard, editCork, pinsOf, type Board, type Cork } from './models.js';

const C1 = corkKey('c1'), B1 = boardKey('b1');
const account = <R>(d: Device<R>) => d.local.store.account!;

/** a shares the record at key; b, another account, joins it; b2 is b's second device. */
async function trio<R>(host: FakeRooms, clock: TestClock, model: Model<R>, key: string, make: (d: Device<R>) => void) {
  const a = device(host, clock, model, 'a');
  make(a);
  await a.sync.sync();
  const room = await a.sync.share(key), b = device(host, clock, model, 'b');
  await b.sync.join(room);
  await b.sync.sync();
  const b2 = device(host, clock, model, 'b2');
  await b2.sync.linkCode(codeFromRoom(account(b)));
  return { a, b, b2, room };
}

const board = (d: Device<Board>, o: { title?: string; pin?: string }) => d.local.edit((s, now) => editBoard(s, B1, now, o));
const cork = (d: Device<Cork>, o: { title?: string; pin?: string } = {}) => d.local.edit((s, now) => editCork(s, 'c1', now, o));

describe('leaving, across the devices of the account that left', () => {
  it('a register kept in the record carries the leave to the other device, and a restart keeps it', async () => {
    const { host, clock } = fakeWorld(), { b, b2, room } = await trio(host, clock, corks, C1, d => cork(d, { title: 'trip' }));
    expect(roomsOf(corks, b2.local.store)).toContain(room);
    await b.sync.leave(C1);
    await b.sync.sync();
    await b2.sync.sync({ full: true });
    expect(placed(corks, b2.local.store)[C1]?.val).toBe(LEFT);
    expect(roomsOf(corks, b2.local.store)).toEqual([account(b)]);
    const again = device(host, clock, corks, 'b2', b2.storage);
    expect(roomsOf(corks, again.local.store)).toEqual([account(b)]);
  });

  it('a register in the account room does the same', async () => {
    const { host, clock } = fakeWorld(), { b, b2 } = await trio(host, clock, boards, B1, d => board(d, { title: 'ours' }));
    await b.sync.leave(B1);
    await b.sync.sync();
    await b2.sync.sync({ full: true });
    expect(roomsOf(boards, b2.local.store)).toEqual([account(b)]);
    expect(roomsOf(boards, device(host, clock, boards, 'b2', b2.storage).local.store)).toEqual([account(b)]);
  });

  it('a shared room at its cap stops saying full once it is left', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await trio(host, clock, corks, C1, d => cork(d, { title: 'trip' }));
    // full even after giving up a tombstone and trying once more
    host.failNext(413, 2, new RegExp(`^PUT /api/rooms/${room}/`));
    cork(b, { pin: 'one too many' });
    await b.sync.sync();
    expect(b.sync.status.problem).toBe('full');
    await b.sync.leave(C1);
    await b.sync.sync({ full: true });
    expect(roomsOf(corks, b.local.store)).toEqual([account(b)]);
    expect(b.sync.status.problem).toBeNull();
  });

  it('online, what the device owes the room is uploaded first; offline, it stays in the account alone', async () => {
    const { host, clock } = fakeWorld(), { b, room } = await trio(host, clock, boards, B1, d => board(d, { title: 'ours' }));
    board(b, { pin: 'before' });
    await b.sync.leave(B1);
    expect(host.snapshot(room)[B1]).toMatchObject({ pins: { before: expect.any(Number) } });
    const other = await trio(host, clock, boards, B1, d => board(d, { title: 'ours' }));
    board(other.b, { pin: 'private' });
    clock.on = false;
    await other.b.sync.leave(B1);
    clock.on = true;
    await other.b.sync.sync({ full: true });
    expect(host.snapshot(other.room)[B1]).not.toMatchObject({ pins: { private: expect.any(Number) } });
    expect(host.snapshot(account(other.b))[B1]).toMatchObject({ pins: { private: expect.any(Number) } });
  });
});

describe('older builds and a leave', () => {
  it("the account room's shared doc takes a newer format once it holds a leave, so a 0.2 device leaves it alone", async () => {
    const { host, clock } = fakeWorld(), { b } = await trio(host, clock, boards, B1, d => board(d, { title: 'ours' }));
    await b.sync.sync();
    expect(host.snapshot(account(b)).shared).toMatchObject({ v: 1 });
    await b.sync.leave(B1);
    await b.sync.sync();
    const doc = host.snapshot(account(b)).shared;
    expect(doc).toMatchObject({ v: 2, rooms: { [B1]: { val: LEFT } } });
    expect(isNewer(doc)).toBe(true);
  });
});

describe('a model mixing whole records and laid out ones', () => {
  type Item = Board | Cork;
  const mixed: Model<Item> = {
    prefix: 'mixed.v1.', salt: 'mixed/public/',
    kind: key => (corks.kind(key) ?? boards.kind(key)) as Kind<Item> | null,
    roomKey: (snap, room) => corks.roomKey!(snap, room),
  };

  it('shares, joins and converges both, each in its own way', async () => {
    const { host, clock } = fakeWorld(), a = device(host, clock, mixed, 'a');
    a.local.edit((s, now) => editBoard(s as never, B1, now, { title: 'board' }) as never);
    a.local.edit((s, now) => editCork(s as never, 'c1', now, { title: 'cork' }) as never);
    await a.sync.sync();
    const rb = await a.sync.share(B1), rc = await a.sync.share(C1), b = device(host, clock, mixed, 'b');
    expect(await b.sync.join(rb)).toBe(B1);
    expect(await b.sync.join(rc)).toBe(C1);
    b.local.edit((s, now) => editBoard(s as never, B1, now, { pin: 'p' }) as never);
    b.local.edit((s, now) => editCork(s as never, 'c1', now, { pin: 'q' }) as never);
    await b.sync.sync();
    await a.sync.sync({ full: true });
    expect(Object.keys(host.snapshot(rb))).toEqual([B1]);
    expect(Object.keys(host.snapshot(rc)).sort()).toEqual(['id', 'made', 'pin/q', 'title']);
    expect(boardsOf(a.local.store as never)[B1]?.pins).toEqual(['p']);
    expect(pinsOf(a.local.store as never, 'c1')).toEqual(['q']);
    expect(host.snapshot(account(a)).shared).toMatchObject({ rooms: { [B1]: { val: rb } } });
    expect(host.snapshot(account(a)).shared).not.toHaveProperty(['rooms', C1]);
  });
});
