import { memoryStorage, type Storage } from '../src/local.js';

/** Memory storage that refuses every write once `writes` runs out: an app killed, or storage filled, mid-write. */
export function cutShort(): Storage & { data: Map<string, string>; writes: number } {
  const st = memoryStorage(), out = { ...st, writes: Infinity, set: (k: string, v: string) => out.writes-- > 0 && st.set(k, v) };
  return out;
}
