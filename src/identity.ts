import { sha256Hex } from './sha256.js';

// What others may see of an account, and where a retired account room leads.

/**
 * 64 bits of a hash of the account room, salted per app ('notes/public/'): safe to show others or write into shared
 * rooms, as the room id (so the code) cannot be recovered from it. A salt never changes once accounts exist.
 */
export const publicId = (room: string, salt: string): string => sha256Hex(`${salt}${room}`).slice(0, 16);

export const tagOf = (pid: string): string => pid.slice(0, 4).toUpperCase();

/** How a name reads to others: "Robin #3F9A". */
export const nameTag = (name: string, pid: string): string => `${name} #${tagOf(pid)}`;

/**
 * Follows forward records from start. forwardOf gives a room's forward target, null for none, undefined when the room
 * has not been read yet (the answer is then `need`). In a cycle (two accounts merged into each other at once), every
 * device settles on the cycle's smallest room id.
 */
export function resolveForward(start: string, forwardOf: (room: string) => string | null | undefined): { room: string } | { need: string } {
  const path: string[] = [];
  for (let cur = start; ;) {
    const seen = path.indexOf(cur);
    if (seen !== -1) return { room: path.slice(seen).sort()[0]! };
    path.push(cur);
    const next = forwardOf(cur);
    if (next === undefined) return { need: cur };
    if (next === null) return { room: cur };
    cur = next;
  }
}
