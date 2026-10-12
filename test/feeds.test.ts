import { describe, it, expect } from 'vitest';
import type { Kind, Model } from '../src/model.js';
import { dirty } from '../src/plan.js';
import { device, fakeWorld, type Device, type FakeRooms, type TestClock } from '../src/testing/index.js';
import { corkKey, corkKind, corks, editCork, leaveCork, type Cork } from './models.js';

const C1 = corkKey('c1');
const account = <R>(d: Device<R>) => d.local.store.account!;
const cork = (d: Device<Cork>, o: { title?: string; pin?: string } = {}) => d.local.edit((s, now) => editCork(s, 'c1', now, o));
const puts = (d: Device<Cork>, room: string) => d.sent.filter(l => l.startsWith(`PUT /api/rooms/${room}/`));

/** Corkboards whose pins are written once too. */
const onceKind: Kind<Cork> = { ...corkKind, layout: { ...corkKind.layout!, once: k => k === 'id' || k === 'made' || k.startsWith('pin/') } };
const onceCorks: Model<Cork> = { ...corks, prefix: 'oncecorks.v1.', kind: key => (corks.kind(key) ? onceKind : null) };

/** a shares a corkboard; b, another account, joins it, starts its engine and feeds the room from a live copy. */
async function fed(host: FakeRooms, clock: TestClock, model: Model<Cork> = corks) {
  const a = device(host, clock, model, 'a');
  cork(a, { title: 'trip', pin: 'map' });
  await a.sync.sync();
  const room = await a.sync.share(C1), b = device(host, clock, model, 'b');
  await b.sync.join(room);
  await b.sync.sync();
  const kv = new Map(Object.entries(host.snapshot(room)));
  b.sync.start();
  await clock.advance(10, [a, b]);
  return { a, b, room, kv, detach: b.sync.attach(room, { ready: true, kv }) };
}

describe('a feed and the engine around it', () => {
  it('stopping the engine drops a burst still waiting', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await fed(host, clock);
    cork(b, { pin: 'new' });
    b.sync.fed(room);
    b.sync.stop();
    await clock.advance(1000, [a, b]);
    expect(puts(b, room).filter(l => l.includes('pin/new'))).toEqual([]);
  });

  it('a burst waits out being offline, a full app pause (507) and a backoff', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await fed(host, clock);
    cork(b, { pin: 'off' });
    clock.on = false;
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    expect(b.sent.filter(l => l.includes('pin/off'))).toEqual([]);
    clock.on = true;
    host.failNext(507, 1, /pin\/off/);
    await b.sync.sync();
    const sent = b.sent.length;
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    expect(b.sent).toHaveLength(sent);
    await clock.advance(31 * 60_000, [a, b]);
    cork(b, { pin: 'late' });
    host.failNext(500, 1, /pin\/late/);
    await b.sync.sync();
    const after = b.sent.length;
    b.sync.fed(room);
    await clock.advance(500, [a, b]);
    expect(b.sent).toHaveLength(after);
  });

  it('a write-once key missing from the copy is never written over the one the server holds', async () => {
    const { host, clock } = fakeWorld(), { a, b, room, kv } = await fed(host, clock);
    kv.delete('made');
    kv.delete('id');
    cork(b, { pin: 'p' });
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    expect(puts(b, room).filter(l => /\/(id|made)$/.test(l))).toEqual([]);
    expect(host.snapshot(room)['pin/p']).toBeTruthy();
  });

  it('a write-once key made while fed, which the copy lacks, is read for and uploaded', async () => {
    const { host, clock } = fakeWorld(), { a, b, room } = await fed(host, clock, onceCorks);
    cork(b, { pin: 'entry' });
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    await b.sync.sync({ full: true });
    expect(host.snapshot(room)['pin/entry']).toBeTruthy();
    expect(dirty(onceCorks, b.local.store)).toEqual([]);
    expect(b.sync.status.items[C1]).toBe('saved');
  });

  it('a key missing from the copy is not taken as absent: what the device holds stays acknowledged', async () => {
    const { host, clock } = fakeWorld(), { a, b, room, kv } = await fed(host, clock);
    kv.delete('title');
    const sent = puts(b, room).length;
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    expect(puts(b, room)).toHaveLength(sent);
    expect(b.local.store.acks[room]!.title).toBeDefined();
  });

  it('a feed of the account room is ignored: a tombstone just acknowledged there stays', async () => {
    const { host, clock } = fakeWorld(), { a, b } = await fed(host, clock);
    b.local.edit((s, now) => leaveCork(s, 'c1', now));
    await b.sync.sync();
    b.sync.attach(account(b), { ready: true, kv: new Map() });
    b.sync.fed(account(b));
    await clock.advance(1000, [a, b]);
    await b.sync.sync({ full: true });
    expect(b.local.store.records[C1]).toBeDefined();
    expect(b.sent).toContain(`GET /api/rooms/${account(b)}`);
  });

  it('a detached feed is read no more', async () => {
    const { host, clock } = fakeWorld(), { a, b, room, kv, detach } = await fed(host, clock);
    detach();
    kv.set('pin/ghost', { v: 1, at: 5 });
    b.sync.fed(room);
    await clock.advance(1000, [a, b]);
    await b.sync.sync({ full: true });
    expect(b.local.store.records[C1]!.pins).not.toHaveProperty('ghost');
  });
});
