import { UNTIMED, gsetAdd, gsetList, gsetMerge, hash, isStamp, lww, tick, type GSet, type Reg, type Stamp } from '../src/crdt.js';
import { playOrder, samePlay, type AppMeta, type Fold, type Kind, type Model, type Playthrough } from '../src/model.js';
import { gsetFrom, isObj, regFrom } from '../src/repair.js';
import { importRecords, putRecord, type LocalStore, type PutResult } from '../src/store.js';
import type { Records } from '../src/records.js';

// Two example apps for the tests. Notes: one record per note, merged field by field and deleted as a tombstone, with a
// fold of the list it kept before sync and the one note an earlier build pinned in the room; a variant also keeps the
// notes opened on this device in the store's meta. Puzzles: three save slots, each a playthrough that never mixes with
// another.

const isText = (x: unknown): x is string => typeof x === 'string' && x.length <= 2000;
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000;
const isId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-z-]{1,40}$/.test(x);

// Notes.

/** u: last edited; deleted: when deleted, 0 never. Gone while deleted > u. */
export interface Note { id: string; text: Reg<string>; tags: GSet; u: Stamp; deleted: Stamp }

const NOTE = /^note\/([0-9a-z-]{1,40})$/;
export const noteKey = (id: string): string => `note/${id}`;

export const noteKind: Kind<Note> = {
  from(raw, key) {
    const id = NOTE.exec(key)?.[1];
    if (!id || !isObj(raw) || raw.id !== id) return null;
    const u = isStamp(raw.u) ? raw.u : 0, deleted = isStamp(raw.deleted) ? raw.deleted : 0;
    return { id, text: regFrom(raw.text, isText) ?? { val: '', t: 0 }, tags: gsetFrom(raw.tags), u, deleted };
  },
  merge: (a, b) => ({ id: a.id, text: lww(a.text, b.text), tags: gsetMerge(a.tags, b.tags), u: Math.max(a.u, b.u), deleted: Math.max(a.deleted, b.deleted) }),
  stamp: r => Math.max(r.text.t, r.u, r.deleted, ...Object.values(r.tags)),
  life: r => ({ used: r.u, deleted: r.deleted }),
};

/** The one note the build before one key per note kept in the room, under `pinned`. */
export const PINNED = 'pinned';
export const pinnedKind: Kind<Note> = {
  ...noteKind,
  from: raw => (isObj(raw) && isId(raw.id) ? noteKind.from(raw, noteKey(raw.id)) : null),
  home: r => noteKey(r.id),
};

/** The list kept before sync: `notes.v1`, note id to text. */
export const NOTES_V1 = 'notes.v1';
export const V1_STAMP = UNTIMED;

/** The v1 list folded in: on the first fold every text at V1_STAMP, later only texts changed since stamped now. */
const v1Fold = <A>(): Fold<Note, A> => ({
  mark: 'v1',
  reads: key => key === NOTES_V1,
  fold(s, get, last, now) {
    const text = get(NOTES_V1);
    if (text === null) return null;
    const before = parseMark(last);
    if (before?.hash === hash(text)) return null;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = null; }
    const t = tick(s.clock, now), texts: Record<string, string> = {}, incoming: Record<string, Note> = {};
    for (const [id, val] of Object.entries(isObj(raw) ? raw : {})) {
      if (!isId(id) || !isText(val)) continue;
      texts[id] = hash(val);
      const at = before && before.texts[id] !== texts[id] ? t : V1_STAMP;
      incoming[noteKey(id)] = { id, text: { val, t: at }, tags: {}, u: at, deleted: 0 };
    }
    return { store: importRecords(notes, s, incoming), mark: JSON.stringify({ hash: hash(text), texts }) };
  },
});

function parseMark(text: string | null): { hash: string; texts: Record<string, string> } | null {
  try {
    const m: unknown = text === null ? null : JSON.parse(text);
    return isObj(m) && typeof m.hash === 'string' && isObj(m.texts) ? { hash: m.hash, texts: m.texts as Record<string, string> } : null;
  } catch { return null; }
}

export const notes: Model<Note> = {
  prefix: 'notes.v2.',
  salt: 'notes/public/',
  qrPrefix: 'NOTES',
  purgeAfter: 90 * 24 * 3600_000,
  kind: key => (NOTE.test(key) ? noteKind : key === PINNED ? pinnedKind : null),
  folds: [v1Fold()],
};

/** What the notes app keeps on this device alone: the notes opened here, in the order first opened, and the last one. */
export interface Here { opened: GSet; last: string | null }

export const here: AppMeta<Here> = {
  read: meta => ({ opened: gsetFrom(meta.opened), last: isId(meta.last) ? meta.last : null }),
  write: h => ({ opened: h.opened, last: h.last }),
  merge: (mine, theirs) => ({ opened: gsetMerge(mine.opened, theirs.opened), last: theirs.last ?? mine.last }),
};

/** The last note opened, as the build before sync kept it under a key of its own. */
export const LAST_V1 = 'notes.last';

/** That key folded into the meta, when nothing newer is held. */
const lastFold: Fold<Note, Here> = {
  mark: 'last',
  reads: key => key === LAST_V1,
  fold(s, get, last) {
    const id = get(LAST_V1);
    if (id === null || id === last) return null;
    return { store: isId(id) && !s.app.last ? { ...s, app: { ...s.app, last: id } } : s, mark: id };
  },
};

export const notesHere: Model<Note, Here> = { ...notes, meta: here, folds: [v1Fold(), lastFold] };

/** A note opened on this device. */
export function openNote(s: LocalStore<Note, Here>, id: string, now: number): LocalStore<Note, Here> {
  const t = tick(s.clock, now), opened = gsetAdd(s.app.opened, [id], t);
  return opened === s.app.opened && s.app.last === id ? s : { ...s, clock: t, app: { opened, last: id } };
}

export function writeNote<A>(s: LocalStore<Note, A>, id: string, text: string, now: number): LocalStore<Note, A> {
  return putRecord(notes, s, noteKey(id), now, (held, t) =>
    held?.text.val === text ? held : { id, text: { val: text, t }, tags: held?.tags ?? {}, u: t, deleted: held?.deleted ?? 0 }).store;
}

export function tagNote<A>(s: LocalStore<Note, A>, id: string, tag: string, now: number): LocalStore<Note, A> {
  return putRecord(notes, s, noteKey(id), now, (held, t) => {
    const base = held ?? { id, text: { val: '', t: 0 }, tags: {}, u: t, deleted: 0 }, tags = gsetAdd(base.tags, [tag], t);
    return held && tags === held.tags ? held : { ...base, tags, u: t };
  }).store;
}

/** A tombstone: the note stays, so another device does not bring it back with older edits; a later edit does. */
export function deleteNote<A>(s: LocalStore<Note, A>, id: string, now: number): LocalStore<Note, A> {
  return putRecord(notes, s, noteKey(id), now, (held, t) => (held ? { ...held, deleted: t } : { id, text: { val: '', t: 0 }, tags: {}, u: 0, deleted: t })).store;
}

/** Each live note as the app shows it: id to text and tags in the order added. */
export function notesOf(s: { records: Records<Note> }): Record<string, { text: string; tags: string[] }> {
  return Object.fromEntries(Object.values(s.records).filter(n => n.deleted <= n.u).map(n => [n.id, { text: n.text.val, tags: gsetList(n.tags) }]));
}

// Puzzles.

export interface Puzzle extends Playthrough { cells: GSet; score: Reg<number> }

const SLOT = /^slot\/[1-3]$/;
export const slotKey = (n: number): string => `slot/${n}`;

export const puzzleKind: Kind<Puzzle> = {
  from(raw) {
    if (!isObj(raw) || !isCount(raw.run) || !isId(raw.game)) return null;
    return { run: raw.run, game: raw.game, cells: gsetFrom(raw.cells), score: regFrom(raw.score, isCount) ?? { val: 0, t: 0 } };
  },
  /** The later playthrough wins whole; within one, cells only grow and the score is the last edit. */
  merge: (a, b) => (samePlay(a, b) ? { run: a.run, game: a.game, cells: gsetMerge(a.cells, b.cells), score: lww(a.score, b.score) } : playOrder(a, b) > 0 ? a : b),
  stamp: r => Math.max(r.score.t, ...Object.values(r.cells)),
  play: r => ({ run: r.run, game: r.game }),
};

export const puzzles: Model<Puzzle> = {
  prefix: 'puzzles.v2.',
  salt: 'puzzles/public/',
  qrPrefix: 'PUZZLES',
  kind: key => (SLOT.test(key) ? puzzleKind : null),
};

export const newPuzzle = (play: Playthrough, t: Stamp): Puzzle => ({ ...play, cells: {}, score: { val: 0, t } });

/** A running session's save of its slot: refused when the slot holds another playthrough now. */
export function solve(s: LocalStore<Puzzle>, slot: number, play: Playthrough, cell: string, score: number, now: number): { store: LocalStore<Puzzle>; result: PutResult } {
  return putRecord(puzzles, s, slotKey(slot), now, (held, t) => {
    const base = held && samePlay(held, play) ? held : newPuzzle(play, t);
    return { ...base, cells: gsetAdd(base.cells, [cell], t), score: base.score.val === score ? base.score : { val: score, t } };
  }, play);
}

/** Starting the slot over: one run past the playthrough held, replacing it on every device. */
export function startOver(s: LocalStore<Puzzle>, slot: number, game: string, now: number): LocalStore<Puzzle> {
  const t = tick(s.clock, now), held = s.records[slotKey(slot)];
  return { ...s, clock: t, records: { ...s.records, [slotKey(slot)]: newPuzzle({ run: (held?.run ?? -1) + 1, game }, t) } };
}

export const cellsOf = (s: LocalStore<Puzzle>, slot: number): string[] => gsetList(s.records[slotKey(slot)]?.cells ?? {});
