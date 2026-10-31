import type { Local } from './local.js';
import type { Sync, SyncEnv, SyncLock } from './sync.js';

// The engine's browser side: the clock, timers and connection it runs on, the Web Lock it syncs under, and the page
// events that drive it.

export const browserEnv = (): SyncEnv => ({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: Math.random,
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  visible: () => typeof document === 'undefined' || !document.hidden,
});

/** One tab syncs at a time, under a Web Lock of this name; without Web Locks, each tab on its own. */
export const webLock = (name: string): SyncLock => fn => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks?.request ? locks.request(name, fn) as Promise<Awaited<ReturnType<typeof fn>>> : fn();
};

/** The page's own triggers: connection changes, background and foreground, and another tab's writes (an older build's too). */
export function listen<R, A>(sync: Sync<R, A>, local: Local<R, A>): void {
  addEventListener('online', () => sync.online());
  addEventListener('offline', () => sync.offline());
  document.addEventListener('visibilitychange', () => { if (document.hidden) sync.hidden(); else sync.visible(); });
  addEventListener('pagehide', () => sync.hidden());
  let reload: ReturnType<typeof setTimeout> | null = null, refold: ReturnType<typeof setTimeout> | null = null;
  addEventListener('storage', e => {
    if (e.key === null || local.owns(e.key)) reload ??= setTimeout(() => { reload = null; local.reload(); }, 50);
    if (e.key === null || local.folds(e.key)) refold ??= setTimeout(() => { refold = null; local.refold(); }, 50);
  });
}
