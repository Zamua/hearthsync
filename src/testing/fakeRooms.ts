// A rooms server in memory for tests, behind a fetch. As the API contract has it: POST picks the room id (201), a
// missing room or key is 404, a malformed room id 400, a write past 256 keys or 256 KiB in a room 413, past the app's
// byte ceiling 507, and too many creations 429 with Retry-After; the query string is ignored. Values are kept as the
// text PUT. With `cdn` set, an edge in front keeps every GET answered 404 (an injected one too) and answers that URL,
// query included, from it until it expires.

const ROOM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FakeRooms {
  readonly rooms = new Map<string, Map<string, string>>();
  /** The server's clock, sent as the Date header. */
  clock: () => number = () => Date.UTC(2026, 8, 1, 12);
  /** No connection: every request fails before reaching the server. */
  down = false;
  creates = 0;
  createLimit = Infinity;
  retryAfter = 3600;
  maxKeys = 256;
  maxBytes = 256 * 1024;
  appBytes = 64 * 1024 * 1024;
  /** How long the edge keeps a 404, in ms; 0: no edge. */
  cdn = 0;
  private edge = new Map<string, number>();
  /** Every request, as `METHOD /path STATUS` (`-` when it never arrived). */
  readonly log: string[] = [];
  private failures: { status: number; match?: RegExp; times: number }[] = [];
  private n = 0;

  /** The next matching requests answer with this status (0: the connection drops). */
  failNext(status: number, times = 1, match?: RegExp): void { this.failures.push({ status, match, times }); }

  /** A room made directly on the server (another account's, or one to test against). */
  make(kv: Record<string, unknown> = {}): string {
    const id = this.newId();
    this.rooms.set(id, new Map(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)])));
    return id;
  }

  snapshot(room: string): Record<string, unknown> {
    const kv = this.rooms.get(room);
    return kv ? Object.fromEntries([...kv].map(([k, v]) => [k, parse(v)])) : {};
  }

  requests(method: string, pattern?: RegExp): string[] {
    return this.log.filter(l => l.startsWith(`${method} `) && (!pattern || pattern.test(l)));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), method = (init?.method ?? 'GET').toUpperCase(), line = `${method} ${url.pathname}`;
    await Promise.resolve();
    if (this.down) { this.log.push(`${line} -`); throw new TypeError('Failed to fetch'); }
    const at = url.pathname + url.search;
    if (method === 'GET' && (this.edge.get(at) ?? -Infinity) > this.clock()) {
      this.log.push(`${line} 404 cdn`);
      return new Response('not found\n', { status: 404, headers: { date: new Date(this.clock()).toUTCString() } });
    }
    const res = this.origin(line, method, url.pathname, typeof init?.body === 'string' ? init.body : '');
    if (method === 'GET' && res.status === 404 && this.cdn > 0) this.edge.set(at, this.clock() + this.cdn);
    return res;
  };

  private origin(line: string, method: string, path: string, body: string): Response {
    const f = this.failures.find(x => !x.match || x.match.test(line));
    if (!f) return this.route(line, method, path, body);
    if (--f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
    if (f.status === 0) { this.log.push(`${line} -`); throw new TypeError('Failed to fetch'); }
    return this.answer(line, f.status, `injected ${f.status}\n`, f.status === 429 ? { 'retry-after': String(this.retryAfter) } : {});
  }

  private route(line: string, method: string, path: string, body: string): Response {
    if (path === '/api/rooms' || path === '/api/rooms/') {
      if (method !== 'POST') return this.answer(line, 405, 'method not allowed\n');
      if (this.creates >= this.createLimit) return this.answer(line, 429, 'room creation rate limit reached\n', { 'retry-after': String(this.retryAfter) });
      if (this.used() >= this.appBytes) return this.answer(line, 507, 'app room storage is at capacity\n');
      this.creates++;
      const id = this.newId();
      this.rooms.set(id, new Map());
      return this.answer(line, 201, JSON.stringify({ id }), { 'content-type': 'application/json' });
    }
    const m = /^\/api\/rooms\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!m) return this.answer(line, 404, 'not found\n');
    const id = m[1]!, rawKey = m[2];
    if (!ROOM.test(id)) return this.answer(line, 400, 'malformed room id\n');
    const kv = this.rooms.get(id);
    if (rawKey === undefined) {
      if (method !== 'GET') return this.answer(line, 405, 'method not allowed\n');
      return kv ? this.answer(line, 200, JSON.stringify(this.snapshot(id)), { 'content-type': 'application/json' }) : this.answer(line, 404, 'not found\n');
    }
    const key = rawKey.split('/').map(decodeURIComponent).join('/');
    if (!kv) return this.answer(line, 404, 'not found\n');
    if (method === 'GET') return kv.has(key) ? this.answer(line, 200, kv.get(key)!) : this.answer(line, 404, 'not found\n');
    if (method === 'PUT') {
      const before = kv.get(key)?.length ?? 0, room = [...kv.values()].reduce((a, v) => a + v.length, 0);
      if ((!kv.has(key) && kv.size >= this.maxKeys) || room - before + body.length > this.maxBytes) return this.answer(line, 413, 'room is at its data cap\n');
      if (this.used() - before + body.length > this.appBytes) return this.answer(line, 507, 'app room storage is at capacity\n');
      kv.set(key, body);
      return this.answer(line, 204, null);
    }
    if (method === 'DELETE') { kv.delete(key); return this.answer(line, 204, null); }
    return this.answer(line, 405, 'method not allowed\n');
  }

  private used(): number {
    let n = 0;
    for (const kv of this.rooms.values()) for (const v of kv.values()) n += v.length;
    return n;
  }

  private answer(line: string, status: number, body: string | null, headers: Record<string, string> = {}): Response {
    this.log.push(`${line} ${status}`);
    return new Response(body, { status, headers: { date: new Date(this.clock()).toUTCString(), ...headers } });
  }

  private newId(): string {
    const h = (++this.n).toString(16).padStart(12, '0');
    return `f0000000-0000-4000-8000-${h}`;
  }
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
