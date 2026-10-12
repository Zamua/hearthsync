import { Local, memoryStorage, type Storage } from '../local.js';
import type { Model } from '../model.js';
import { httpRooms } from '../rooms.js';
import { Sync, type SyncEnv, type SyncEvents } from '../sync.js';
import { FakeRooms } from './fakeRooms.js';

// Devices for sync tests: each its own storage, store and engine, all on one fake clock and one fake rooms server.

/** Any origin: the fake server answers every request it is handed. */
export const TEST_ORIGIN = 'https://rooms.test';

export class TestClock implements SyncEnv {
  t = Date.UTC(2026, 8, 1, 12);
  on = true;
  shown = true;
  private timers: { at: number; fn: () => void }[] = [];
  readonly now = (): number => this.t;
  readonly setTimer = (fn: () => void, ms: number): unknown => { const h = { at: this.t + ms, fn }; this.timers.push(h); return h; };
  readonly clearTimer = (h: unknown): void => { this.timers = this.timers.filter(x => x !== h); };
  readonly random = (): number => 0.5;
  readonly online = (): boolean => this.on;
  readonly visible = (): boolean => this.shown;

  /** Moves time on, firing each due timer in order and letting the engines finish what it started. */
  async advance(ms: number, devices: readonly { sync: { idle(): Promise<void> } }[]): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await Promise.all(devices.map(d => d.sync.idle()));
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

export interface Device<R> {
  name: string;
  storage: Storage & { data: Map<string, string> };
  local: Local<R>;
  sync: Sync<R>;
  /** This device alone has no connection. */
  down: boolean;
  /** Requests sent as keepalive (the page going away). */
  keepalive: string[];
  /** Every request this device sent, as `METHOD /path`. */
  sent: string[];
  /** Requests matching this get no answer until release() (or until they time out). */
  stall: RegExp | null;
  release(): void;
  heard: { [K in keyof SyncEvents]: SyncEvents[K][] };
}

/** A device on the fake server; storage carries over to model an app restart. */
export function device<R>(host: FakeRooms, clock: TestClock, model: Model<R>, name: string, storage = memoryStorage()): Device<R> {
  const local = new Local(storage, model, { now: clock.now });
  const held: (() => void)[] = [];
  const d = {
    name, storage, local, down: false, keepalive: [], sent: [], heard: { status: [], account: [], backlog: [], news: [] }, stall: null,
    release: () => { d.stall = null; for (const go of held.splice(0)) go(); },
  } as unknown as Device<R>;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const line = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    d.sent.push(line);
    if (init?.keepalive) d.keepalive.push(line);
    if (d.down) return Promise.reject(new TypeError('Failed to fetch'));
    if (d.stall?.test(line)) return new Promise((resolve, reject) => {
      held.push(() => { host.fetch(input, init).then(resolve, reject); });
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
    return host.fetch(input, init);
  };
  const api = httpRooms(TEST_ORIGIN, { fetch, now: clock.now, serverTime: (at, sent, recv) => local.serverTime(at, sent, recv) });
  d.sync = new Sync(local, api, clock);
  for (const k of ['status', 'account', 'backlog', 'news'] as const) d.sync.on(k, v => (d.heard[k] as unknown[]).push(v));
  return d;
}

export function fakeWorld(): { host: FakeRooms; clock: TestClock } {
  const host = new FakeRooms(), clock = new TestClock();
  host.clock = clock.now;
  return { host, clock };
}
