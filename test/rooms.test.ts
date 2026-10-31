import { describe, it, expect } from 'vitest';
import { RoomError, httpRooms } from '../src/rooms.js';
import { FakeRooms } from '../src/testing/fakeRooms.js';

const ORIGIN = 'https://rooms.test';
const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: RoomError) => [e.status, e.retryAfter]);

describe('the rooms API over HTTP', () => {
  it('makes a room, writes and reads keys, with slashed keys as path segments', async () => {
    const host = new FakeRooms(), api = httpRooms(ORIGIN, { fetch: host.fetch });
    const room = await api.create();
    await api.put(room, 'note/n1', { v: 1, id: 'n1' });
    expect(await api.get(room, 'note/n1')).toEqual({ v: 1, id: 'n1' });
    expect(await api.scan(room)).toEqual({ 'note/n1': { v: 1, id: 'n1' } });
    expect(host.log).toContain(`PUT /api/rooms/${room}/note/n1 204`);
  });

  it('reports each failure by its status: missing, full, rate limited with its wait, no connection', async () => {
    const host = new FakeRooms(), api = httpRooms(ORIGIN, { fetch: host.fetch });
    const room = await api.create();
    expect(await status(api.get(room, 'absent'))).toEqual([404, null]);
    expect(await status(api.scan('f0000000-0000-4000-8000-00000000abcd'))).toEqual([404, null]);
    host.maxKeys = 0;
    expect(await status(api.put(room, 'k', 1))).toEqual([413, null]);
    host.createLimit = 0;
    expect(await status(api.create())).toEqual([429, 3600]);
    host.appBytes = 0;
    host.maxKeys = 256;
    expect(await status(api.put(room, 'k', 1))).toEqual([507, null]);
    host.down = true;
    expect(await status(api.scan(room))).toEqual([0, null]);
  });

  it('takes a 2xx from something in the way (a captive portal) for a bad answer: not an empty room, not a write', async () => {
    const portal: typeof fetch = async () => new Response('<html>sign in to the wifi</html>', { status: 200 });
    const api = httpRooms(ORIGIN, { fetch: portal }), room = 'f0000000-0000-4000-8000-00000000abcd';
    expect(await status(api.scan(room))).toEqual([502, null]);
    expect(await status(api.put(room, 'k', 1))).toEqual([502, null]);
    expect(await status(api.delete(room, 'k'))).toEqual([502, null]);
  });

  it('a fresh scan asks past an edge that keeps a 404, by a query the server ignores, unique to each read', async () => {
    const host = new FakeRooms(), urls: string[] = [];
    const api = httpRooms(ORIGIN, { fetch: (u, i) => { urls.push(String(u)); return host.fetch(u, i); } });
    const room = await api.create();
    await api.put(room, 'k', 1);
    host.cdn = 60_000;
    host.failNext(404, 1, new RegExp(`^GET /api/rooms/${room}$`));
    expect(await status(api.scan(room))).toEqual([404, null]);
    expect(await status(api.scan(room))).toEqual([404, null]);
    expect(await api.scan(room, { fresh: true })).toEqual({ k: 1 });
    expect(await api.scan(room, { fresh: true })).toEqual({ k: 1 });
    const [plain, , first, second] = urls.slice(-4).map(u => new URL(u));
    expect([plain!.search, first!.search === '', first!.search === second!.search]).toEqual(['', false, false]);
    expect(host.log.at(-3)).toBe(`GET /api/rooms/${room} 404 cdn`);
  });

  it('hands the server\'s Date to the clock', async () => {
    const host = new FakeRooms(), seen: number[] = [];
    host.clock = () => Date.UTC(2026, 8, 1, 12, 0, 7);
    const api = httpRooms(ORIGIN, { fetch: host.fetch, now: () => 5, serverTime: at => seen.push(at) });
    await api.create();
    expect(seen).toEqual([Date.UTC(2026, 8, 1, 12, 0, 7)]);
  });

  it('gives up on a request that stalls, before or after its headers, as no connection', async () => {
    const quick = (p: Promise<unknown>) => Promise.race([status(p), new Promise(r => setTimeout(() => r('stalled'), 500))]);
    const never: typeof fetch = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    expect(await quick(httpRooms(ORIGIN, { fetch: never, timeoutMs: 20 }).scan('f0000000-0000-4000-8000-00000000abcd'))).toEqual([0, null]);
    const trickle: typeof fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    expect(await quick(httpRooms(ORIGIN, { fetch: trickle, timeoutMs: 20 }).scan('f0000000-0000-4000-8000-00000000abcd'))).toEqual([0, null]);
  });
});
