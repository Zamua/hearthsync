import { describe, it, expect } from 'vitest';
import { accountDoc, forwardDoc } from '../src/account.js';
import { canon, hash, lww, type Reg } from '../src/crdt.js';
import { playOrder, type Model, type Playthrough } from '../src/model.js';
import { docsOf } from '../src/records.js';
import { makeRng, type Rng } from '../src/rng.js';
import { NEWER, absorbAccount, accountDocs, acknowledge, chips, dirty, joinAccount, plan, roomsOf, takeIn, type Plan } from '../src/plan.js';
import { adoptAccount, emptyStore, switchAccount, type LocalStore } from '../src/store.js';
import { laws } from './laws.js';
import { cellsOf, newPuzzle, noteKind, notes, notesOf, puzzleKind, puzzles, slotKey, solve, startOver, tagNote, writeNote, type Note, type Puzzle } from './models.js';

// A model of a rooms server: last write wins per key, values stored as parsed JSON, PUTs to a missing room fail.
type Server = Map<string, Map<string, unknown>>;
const snap = (srv: Server, room: string): Record<string, unknown> => Object.fromEntries(srv.get(room) ?? []);

function push<R>(srv: Server, p: Plan<R>): LocalStore<R> {
  let out = p.store;
  for (const put of p.puts) {
    const room = srv.get(put.room);
    if (!room) continue;
    room.set(put.key, JSON.parse(JSON.stringify(put.value)));
    out = acknowledge(out, put.room, put.key, put.hash);
  }
  return out;
}

/** One read, merge and upload of the account room. moved counts puts and news: anything that moved. */
function round<R>(m: Model<R>, s: LocalStore<R>, srv: Server): { store: LocalStore<R>; moved: number } {
  const room = roomsOf(s)[0];
  if (!room) return { store: s, moved: 0 };
  const p = plan(m, s, room, snap(srv, room));
  return { store: push(srv, p), moved: p.puts.length + p.news.length };
}

const R = '11111111-2222-4333-8444-555555555555', B = '99999999-2222-4333-8444-555555555555';
const P1 = { run: 0, game: 'g1' };

function account(room = R): { srv: Server; a: LocalStore<Note> } {
  const srv: Server = new Map([[room, new Map()]]);
  const a = writeNote(writeNote(emptyStore<Note>(), 'a', 'milk', 1000), 'b', 'call', 1001);
  return { srv, a: adoptAccount(a, room, 1200, notes.salt) };
}

const linked = <R>(m: Model<R>, room = R) => switchAccount(emptyStore<R>(), room, 2100, m.salt).store;

describe('example records', () => {
  it('merge by the laws, whatever the inputs', () => {
    const notesGen = (rng: Rng): Note => ({ id: 'n', text: { val: rng.pick(['a', 'b']), t: rng.int(0, 4) }, tags: rng.next() < 0.5 ? { work: rng.int(0, 3) } : {}, u: rng.int(0, 4), deleted: rng.pick([0, 0, 2, 5]) });
    laws(notesGen, noteKind.merge);
    const puzzleGen = (rng: Rng): Puzzle => ({ run: rng.int(0, 1), game: rng.pick(['g1', 'g2']), cells: rng.next() < 0.5 ? { a1: rng.int(0, 3) } : {}, score: { val: rng.int(0, 2), t: rng.int(0, 3) } });
    laws(puzzleGen, puzzleKind.merge);
  });
});

describe('uploading', () => {
  it('nothing is sendable before the account room exists, and every record shows Phone only', () => {
    const s = writeNote(emptyStore<Note>(), 'a', 'milk', 1000);
    expect(dirty(notes, s)).toEqual([]);
    expect(chips(notes, s)).toEqual({ items: { 'note/a': 'phone' }, unsaved: 1 });
    expect(chips(notes, emptyStore())).toEqual({ items: {}, unsaved: 0 });
  });

  it('a new account uploads every doc once, then all is Saved and the next round sends nothing', () => {
    const { srv, a } = account();
    expect(dirty(notes, a).map(p => p.key).sort()).toEqual(['account', 'note/a', 'note/b']);
    const r = round(notes, a, srv);
    expect(r.moved).toBe(3);
    expect(canon(snap(srv, R))).toBe(canon(accountDocs(notes, r.store)));
    expect(snap(srv, R)['note/a']).toEqual({ v: 1, id: 'a', text: { val: 'milk', t: 1000 }, tags: {}, u: 1000, deleted: 0 });
    expect(dirty(notes, r.store)).toEqual([]);
    expect(chips(notes, r.store)).toEqual({ items: { 'note/a': 'saved', 'note/b': 'saved' }, unsaved: 0 });
    expect(plan(notes, r.store, R, snap(srv, R)).puts).toEqual([]);
  });

  it('a change made while its upload was in flight stays dirty, its record Waiting', () => {
    const { srv, a } = account();
    const p = plan(notes, a, R, snap(srv, R)), put = p.puts.find(x => x.key === 'note/a')!;
    const edited = writeNote(p.store, 'a', 'oat milk', 3000);
    const acked = acknowledge(edited, R, put.key, put.hash);
    expect(dirty(notes, acked).map(x => x.key)).toContain('note/a');
    expect(chips(notes, acked).items['note/a']).toBe('waiting');
  });

  it('planning twice against the same read changes nothing more', () => {
    const { srv, a } = account();
    srv.get(R)!.set('note/c', { v: 1, id: 'c', text: { val: 'remote', t: 900 }, tags: { home: 900 } });
    const read = snap(srv, R), once = plan(notes, a, R, read), twice = plan(notes, once.store, R, read);
    expect(once.news).toEqual(['note/c']);
    expect(canon(twice.store)).toBe(canon(once.store));
    expect(twice.puts).toEqual(once.puts);
    expect(twice.news).toEqual([]);
  });

  it('a scoped round reads and writes only the keys asked for', () => {
    const { srv, a } = account();
    const p = plan(notes, a, R, snap(srv, R), ['note/b']);
    expect(p.puts.map(x => x.key)).toEqual(['note/b']);
  });

  it('keys the app does not own are left alone, and their acks dropped', () => {
    const { srv, a } = account();
    srv.get(R)!.set('other', { v: 1, x: 1 });
    const p = plan(notes, acknowledge(a, R, 'other', 'abc'), R, snap(srv, R));
    expect(p.puts.map(x => x.key)).not.toContain('other');
    expect(p.store.acks[R]!.other).toBeUndefined();
    expect(p.store.records).not.toHaveProperty('other');
  });
});

describe('two devices on one account', () => {
  it("another device's records arrive and are reported by key; the account keeps its manifest", () => {
    const { srv, a } = account();
    round(notes, a, srv);
    const p = plan(notes, linked(notes), R, snap(srv, R));
    expect(notesOf(p.store)).toEqual(notesOf(a));
    expect(p.news).toEqual(['note/a', 'note/b']);
    expect(p.store.profile).toEqual(a.profile);
    expect(p.puts).toEqual([]);
  });

  it('a clobbered PUT heals: the loser sees the server lacks its edit, shows Waiting, and sends the merge', () => {
    const { srv, a: a0 } = account();
    let a = round(notes, a0, srv).store;
    let b = round(notes, linked(notes), srv).store;
    a = writeNote(a, 'a', 'oat milk', 3000);
    b = tagNote(b, 'a', 'urgent', 3001);
    const read = snap(srv, R), pa = plan(notes, a, R, read), pb = plan(notes, b, R, read);
    a = push(srv, pa);
    b = push(srv, pb);
    expect(chips(notes, a).items['note/a']).toBe('saved');
    const again = plan(notes, a, R, snap(srv, R));
    expect(chips(notes, again.store).items['note/a']).toBe('waiting');
    a = push(srv, again);
    b = round(notes, b, srv).store;
    for (const s of [a, b]) expect(notesOf(s).a).toEqual({ text: 'oat milk', tags: ['urgent'] });
    expect(round(notes, a, srv).moved + round(notes, b, srv).moved).toBe(0);
  });

  it('a new game in one slot replaces it on the other device, and leaves the other slots be', () => {
    const srv: Server = new Map([[R, new Map()]]);
    let a = adoptAccount(solve(solve(emptyStore<Puzzle>(), 1, P1, 'a1', 1, 1000).store, 2, { run: 0, game: 'g2' }, 'b1', 1, 1000).store, R, 1100, puzzles.salt);
    a = round(puzzles, a, srv).store;
    let b = round(puzzles, linked(puzzles), srv).store;
    a = round(puzzles, startOver(a, 1, 'g9', 3000), srv).store;
    b = solve(b, 1, P1, 'c3', 2, 3100).store;
    b = round(puzzles, b, srv).store;
    expect([b.records[slotKey(1)]!.run, cellsOf(b, 1), cellsOf(b, 2)]).toEqual([1, [], ['b1']]);
    expect(round(puzzles, a, srv).store.records[slotKey(1)]!.run).toBe(1);
  });
});

describe('accounts', () => {
  it('a retired account room gets nothing uploaded, gives up its content, and names its successor', () => {
    const { srv, a } = account();
    srv.get(R)!.set('note/c', { v: 1, id: 'c', text: { val: 'left here', t: 500 }, tags: {} });
    srv.get(R)!.set('forward', forwardDoc(B, 1));
    const p = plan(notes, a, R, snap(srv, R));
    expect(p.forward).toBe(B);
    expect(p.puts).toEqual([]);
    expect(Object.keys(notesOf(p.store)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('records with no playthrough always merge, whether absorbed, joined or taken in', () => {
    const { a } = account();
    const other = adoptAccount(writeNote(tagNote(emptyStore<Note>(), 'a', 'work', 500), 'z', 'theirs', 600), B, 700, notes.salt);
    for (const merged of [absorbAccount(notes, a, accountDocs(notes, other)), takeIn(notes, a, accountDocs(notes, other)), joinAccount(notes, a, accountDocs(notes, other))]) {
      expect(notesOf(merged)).toEqual({ a: { text: 'milk', tags: ['work'] }, b: { text: 'call', tags: [] }, z: { text: 'theirs', tags: [] } });
      expect(merged.profile).toEqual(a.profile);
      expect(merged.clock).toBeGreaterThanOrEqual(a.clock);
    }
  });

  it("joining an account plays its playthrough per slot, setting this device's own aside; merging one in keeps this account's", () => {
    const mine = solve(solve(emptyStore<Puzzle>(), 1, { run: 5, game: 'mine' }, 'a1', 9, 1000).store, 3, { run: 0, game: 'only-here' }, 'q1', 1, 1000).store;
    const theirs = solve(emptyStore<Puzzle>(), 1, { run: 0, game: 'theirs' }, 'z9', 2, 9000).store;
    const joined = joinAccount(puzzles, mine, accountDocs(puzzles, theirs));
    expect([joined.records[slotKey(1)]!.game, cellsOf(joined, 1), cellsOf(joined, 3)]).toEqual(['theirs', ['z9'], ['q1']]);
    expect(joined.clock).toBeGreaterThanOrEqual(9000);
    expect(takeIn(puzzles, mine, accountDocs(puzzles, theirs))).toBe(mine);
    expect(joinAccount(puzzles, mine, {})).toBe(mine);
    expect(cellsOf(joinAccount(puzzles, emptyStore(), accountDocs(puzzles, mine)), 1)).toEqual(['a1']);
    const same = solve(emptyStore<Puzzle>(), 1, { run: 5, game: 'mine' }, 'b2', 3, 2000).store;
    for (const f of [joinAccount, takeIn]) expect(cellsOf(f(puzzles, mine, accountDocs(puzzles, same)), 1)).toEqual(['a1', 'b2']);
  });

  it("leaves a newer build's docs alone and counts them as saved; a manifest of a later format too", () => {
    const { srv, a } = account();
    srv.get(R)!.set('note/a', { v: 2, anything: true });
    srv.get(R)!.set('account', { ...accountDoc(a.profile!), v: 2 });
    const p = plan(notes, a, R, snap(srv, R));
    expect(p.newer.sort()).toEqual(['account', 'note/a']);
    expect(p.puts.map(x => x.key)).toEqual(['note/b']);
    expect(p.store.acks[R]!['note/a']).toBe(NEWER);
    expect(notesOf(p.store).a!.text).toBe('milk');
    expect(chips(notes, push(srv, p)).items['note/a']).toBe('saved');
  });

  it('an app at a later doc format reads docs of its own format, and takes earlier ones', () => {
    const v2: Model<Note> = { ...notes, version: 2 };
    const srv: Server = new Map([[R, new Map<string, unknown>([['note/x', { v: 2, id: 'x', text: { val: 'two', t: 5 }, tags: {} }], ['note/y', { v: 1, id: 'y', text: { val: 'one', t: 5 }, tags: {} }]])]]);
    const p = plan(v2, linked(v2), R, snap(srv, R));
    expect(p.newer).toEqual([]);
    expect(Object.keys(notesOf(p.store)).sort()).toEqual(['x', 'y']);
    expect(docsOf(v2, p.store.records)['note/y']).toMatchObject({ v: 2 });
  });
});

describe('random histories converge', () => {
  type Device<R> = { s: LocalStore<R>; skew: number };

  function devices<R>(m: Model<R>): Device<R>[] {
    return [
      { s: adoptAccount(emptyStore<R>(), R, 1000, m.salt), skew: 0 },
      { s: switchAccount(emptyStore<R>(), R, 1000, m.salt).store, skew: -40 },
      { s: switchAccount(emptyStore<R>(), R, 1000, m.salt).store, skew: 25 },
    ];
  }

  /** Random edits, clobbered writes and scoped rounds; then rounds until quiet, and every device holds what the room holds. */
  function run<R>(m: Model<R>, seed: number, edit: (rng: Rng, d: Device<R>, i: number, t: number, step: number) => void): LocalStore<R> {
    const rng = makeRng(seed), srv: Server = new Map([[R, new Map()]]), ds = devices(m);
    let now = 1000;
    for (let step = 0; step < 200; step++) {
      now += rng.int(0, 2);
      const i = rng.int(0, 2), d = ds[i]!, t = now + d.skew, op = rng.int(0, 11);
      if (op <= 6) edit(rng, d, i, t, step);
      else if (op === 7) {
        // Two devices read the same state, then both write: the second clobbers the first.
        const [x, y] = [rng.pick(ds), rng.pick(ds)], read = snap(srv, R);
        const px = plan(m, x.s, R, read), py = plan(m, y.s, R, read);
        x.s = push(srv, px);
        y.s = push(srv, py);
      } else if (op === 8) {
        const keys = dirty(m, d.s).map(x => x.key);
        const read = Object.fromEntries(Object.entries(snap(srv, R)).filter(([k]) => keys.includes(k)));
        d.s = push(srv, plan(m, d.s, R, read, keys));
      } else d.s = round(m, d.s, srv).store;
    }
    let quiet = false;
    for (let pass = 0; pass < 12 && !quiet; pass++) {
      let moved = 0;
      for (const d of ds) { const r = round(m, d.s, srv); d.s = r.store; moved += r.moved; }
      quiet = moved === 0;
    }
    expect(quiet).toBe(true);
    const s = ds[0]!.s;
    for (const d of ds) {
      expect(canon(accountDocs(m, d.s))).toBe(canon(accountDocs(m, s)));
      expect(canon(accountDocs(m, d.s))).toBe(canon(snap(srv, R)));
      expect(dirty(m, d.s)).toEqual([]);
    }
    for (const [k, v] of Object.entries(snap(srv, R))) expect(s.acks[R]![k]).toBe(hash(v));
    return s;
  }

  it('notes on three devices: no tag is lost, and every text is the last edit made', () => {
    const IDS = ['a', 'b', 'c', 'd'], TAGS = ['work', 'home', 'urgent'], TEXTS = ['', 'milk', 'eggs', 'call'];
    for (let seed = 1; seed <= 40; seed++) {
      const tags = new Map<string, Set<string>>(), texts = new Map<string, Reg<string>[]>();
      const s = run(notes, seed, (rng, d, _i, t) => {
        const id = rng.pick(IDS);
        d.s = rng.next() < 0.5 ? writeNote(d.s, id, rng.pick(TEXTS), t) : tagNote(d.s, id, rng.pick(TAGS), t);
        const n = d.s.records[`note/${id}`]!;
        tags.set(id, new Set([...(tags.get(id) ?? []), ...Object.keys(n.tags)]));
        texts.set(id, [...(texts.get(id) ?? []), n.text]);
      });
      for (const [id, set] of tags) expect(Object.keys(s.records[`note/${id}`]!.tags).sort()).toEqual([...set].sort());
      for (const [id, list] of texts) expect(canon(s.records[`note/${id}`]!.text)).toBe(canon(list.reduce(lww)));
    }
  }, 30000);

  it('puzzle slots on three devices, with new games: the current playthrough of each slot wins and keeps every cell set in it', () => {
    for (let seed = 1; seed <= 40; seed++) {
      // Each device's first save, before it reads, starts a playthrough of its own; what each playthrough was given.
      const plays = new Map<string, { slot: number; play: Playthrough; cells: Set<string> }>();
      const s = run(puzzles, seed, (rng, d, i, t, step) => {
        const slot = rng.int(1, 2), held = d.s.records[slotKey(slot)];
        if (rng.next() < 0.1) d.s = startOver(d.s, slot, `new${step}`, t);
        else {
          const play = held ? { run: held.run, game: held.game } : { run: 0, game: `d${i}s${slot}` };
          d.s = solve(d.s, slot, play, rng.pick(['a1', 'b2', 'c3', 'd4']), rng.int(0, 9), t).store;
        }
        const r = d.s.records[slotKey(slot)]!, key = `${slot}:${r.run}/${r.game}`;
        const seen = plays.get(key) ?? { slot, play: { run: r.run, game: r.game }, cells: new Set<string>() };
        for (const c of Object.keys(r.cells)) seen.cells.add(c);
        plays.set(key, seen);
      });
      for (const slot of [1, 2]) {
        const mine = [...plays.values()].filter(p => p.slot === slot);
        if (!mine.length) continue;
        const last = mine.reduce((a, b) => (playOrder(a.play, b.play) >= 0 ? a : b)), r = s.records[slotKey(slot)]!;
        expect([r.run, r.game]).toEqual([last.play.run, last.play.game]);
        expect(Object.keys(r.cells).sort()).toEqual([...last.cells].sort());
      }
    }
  }, 30000);
});

describe('a newer doc never reaches the store', () => {
  it('a device starting from a newer build\'s slot keeps nothing of it', () => {
    const srv: Server = new Map([[R, new Map<string, unknown>([[slotKey(1), { ...newPuzzle(P1, 5), v: 9 }]])]]);
    const p = plan(puzzles, linked(puzzles), R, snap(srv, R));
    expect(p.store.records).toEqual({});
    expect(p.newer).toEqual([slotKey(1)]);
  });
});
