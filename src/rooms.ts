import { isRoomId } from './code.js';

// The rooms API as sync uses it: a POST makes a room (the server picks its id), a scan reads every key, a GET one key,
// a PUT writes one. Every failure is a RoomError with the HTTP status (0: no response at all), so the engine can
// tell a full room from a lost one from a dropped connection.

export class RoomError extends Error {
  constructor(readonly status: number, readonly retryAfter: number | null = null) {
    super(status ? `rooms: HTTP ${status}` : 'rooms: no connection');
  }
}

export interface RoomApi {
  create(): Promise<string>;
  /** Every key of the room. 404: no such room. fresh: past any cache on the way, which may keep a 404 for minutes. */
  scan(room: string, o?: { fresh?: boolean }): Promise<Record<string, unknown>>;
  /** One key. 404: the key, or the room, is absent. */
  get(room: string, key: string): Promise<unknown>;
  put(room: string, key: string, value: unknown, o?: { keepalive?: boolean }): Promise<void>;
  /** Removes one key (an absent key too). 404: no such room. */
  delete(room: string, key: string): Promise<void>;
}

export interface HttpDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** The server's Date header, with when the request left and its answer came back (for the clock skew). */
  serverTime?: (serverMs: number, sentMs: number, recvMs: number) => void;
  /** A request unanswered (headers and body) after this long fails as no connection. */
  timeoutMs?: number;
}

/** A stalled request must not hold up sync, the UI operations behind it, or other tabs waiting on the sync lock. */
const TIMEOUT = 15_000;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

const ROOMS = '/api/rooms';

/** Keys like `note/<id>` travel as path segments: a slash encoded as %2F may be refused or rewritten on the way. */
const keyPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
const roomPath = (room: string, key?: string): string => (key === undefined ? `${ROOMS}/${room}` : `${ROOMS}/${room}/${keyPath(key)}`);

let reads = 0;
/** A query no cache holds an answer for: an edge cache keys on it, and the server ignores it. */
const fresh = (): string => `?fresh=${(++reads).toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The rooms API at origin (`https://example.com`): its rooms live under `/api/rooms`. */
export function httpRooms(origin: string, deps: HttpDeps = {}): RoomApi {
  const now = deps.now ?? Date.now;
  /** One request, its body read in full. */
  const call = async (path: string, init?: RequestInit): Promise<string> => {
    const f = deps.fetch ?? fetch, sent = now(), ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new RoomError(0)); }, deps.timeoutMs ?? TIMEOUT); });
    const answer = async (): Promise<string> => {
      let r: Response;
      try { r = await f(`${origin}${path}`, { cache: 'no-store', ...init, signal: ctl.signal }); } catch { throw new RoomError(0); }
      const date = Date.parse(r.headers.get('date') ?? '');
      if (Number.isFinite(date)) deps.serverTime?.(date, sent, now());
      if (!r.ok) {
        const ra = Number(r.headers.get('retry-after'));
        throw new RoomError(r.status, Number.isFinite(ra) && ra > 0 ? ra : null);
      }
      // A body cut off mid-read is a dropped connection, not a bad value.
      try { return await r.text(); } catch { throw new RoomError(0); }
    };
    try { return await Promise.race([answer(), expired]); } finally { clearTimeout(timer); }
  };
  const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };
  /** A write answers with no body; one that has a body came from something in the way, so the write is not known to have landed. */
  const written = (text: string): void => { if (text !== '') throw new RoomError(502); };
  return {
    async create() {
      const o = json(await call(ROOMS, { method: 'POST' }));
      if (!isObj(o) || !isRoomId(o.id)) throw new RoomError(502);
      return o.id;
    },
    async scan(room, o) {
      const got = json(await call(`${roomPath(room)}${o?.fresh ? fresh() : ''}`));
      // A room, even an empty one, scans as an object; anything else came from something in the way, like a captive portal.
      if (!isObj(got)) throw new RoomError(502);
      return got;
    },
    async get(room, key) {
      return json(await call(roomPath(room, key)));
    },
    async put(room, key, value, o) {
      written(await call(roomPath(room, key), { method: 'PUT', body: JSON.stringify(value), ...(o?.keepalive ? { keepalive: true } : {}) }));
    },
    async delete(room, key) {
      written(await call(roomPath(room, key), { method: 'DELETE' }));
    },
  };
}
