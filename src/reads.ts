import { FORWARD_KEY, forwardFrom } from './account.js';
import { resolveForward } from './identity.js';
import type { Snapshot } from './model.js';
import { RoomError, type RoomApi } from './rooms.js';

// Reading a room as it is now: past an edge cache that keeps a 404, and down a chain of forwards to where its account
// or record lives.

/** A room past any forwards, with its scan. */
export interface Landing { room: string; snapshot: Snapshot }

/** A scan whose 404 counts only once a read past any cache agrees: an edge may keep a 404 for minutes. */
export async function scanRoom(api: RoomApi, room: string): Promise<Snapshot> {
  try { return await api.scan(room); } catch (e) {
    if (!(e instanceof RoomError) || e.status !== 404) throw e;
    return api.scan(room, { fresh: true });
  }
}

/** Where a chain of forwards from a scanned room ends, with that room's scan; null if it leads to a missing room. */
export async function forwardsFrom(api: RoomApi, start: string, snap: Snapshot): Promise<Landing | null> {
  const snaps = new Map<string, Snapshot>([[start, snap]]);
  const forwardOf = (room: string): string | null | undefined => {
    const s = snaps.get(room);
    if (!s) return undefined;
    const f = forwardFrom(s[FORWARD_KEY]);
    return f && f.to !== room ? f.to : null;
  };
  for (let i = 0; i < 16; i++) {
    const r = resolveForward(start, forwardOf);
    if ('room' in r) return { room: r.room, snapshot: snaps.get(r.room)! };
    try { snaps.set(r.need, await scanRoom(api, r.need)); } catch (e) {
      if (e instanceof RoomError && e.status === 404) return null;
      throw e;
    }
  }
  return null;
}
