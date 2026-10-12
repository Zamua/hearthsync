import { gsetAdd, gsetList, gsetMerge, hash, lww, tick, type GSet, type Reg, type Stamp } from '../src/crdt.js';
import { playOrder, samePlay, type Fold, type Kind, type Model, type Playthrough } from '../src/model.js';
import { gsetFrom, isObj, regFrom } from '../src/repair.js';
import { importRecords, putRecord, type LocalStore, type PutResult } from '../src/store.js';

// Two example apps for the tests. Notes: one record per note, merged field by field, with a fold of the list it kept
// before sync. Puzzles: three save slots, each a playthrough that never mixes with another.

const isText = (x: unknown): x is string => typeof x === 'string' && x.length <= 2000;
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000;
const isId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-z-]{1,40}$/.test(x);

// Notes.

export interface Note { id: string; text: Reg<string>; tags: GSet }

const NOTE = /^note\/([0-9a-z-]{1,40})$/;
export const noteKey = (id: string): string => `note/${id}`;

export const noteKind: Kind<Note> = {
  from(raw, key) {
    const id = NOTE.exec(key)?.[1];
    if (!id || !isObj(raw) || raw.id !== id) return null;
    return { id, text: regFrom(raw.text, isText) ?? { val: '', t: 0 }, tags: gsetFrom(raw.tags) };
  },
  merge: (a, b) => ({ id: a.id, text: lww(a.text, b.text), tags: gsetMerge(a.tags, b.tags) }),
  stamp: r => Math.max(r.text.t, ...Object.values(r.tags)),
};

/** The list kept before sync: `notes.v1`, note id to text. */
export const NOTES_V1 = 'notes.v1';
/** A value from before sync: any edit made since beats it, and it beats a record's placeholders (stamp 0). */
export const V1_STAMP = 1;

/** The v1 list folded in: on the first fold every text at V1_STAMP, later only texts changed since stamped now. */
const v1Fold: Fold<Note> = {
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
      incoming[noteKey(id)] = { id, text: { val, t: before && before.texts[id] !== texts[id] ? t : V1_STAMP }, tags: {} };
    }
    return { store: importRecords(notes, s, incoming), mark: JSON.stringify({ hash: hash(text), texts }) };
  },
};

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
  kind: key => (NOTE.test(key) ? noteKind : null),
  folds: [v1Fold],
};

export function writeNote(s: LocalStore<Note>, id: string, text: string, now: number): LocalStore<Note> {
  return putRecord(notes, s, noteKey(id), now, (held, t) =>
    held?.text.val === text ? held : { id, text: { val: text, t }, tags: held?.tags ?? {} }).store;
}

export function tagNote(s: LocalStore<Note>, id: string, tag: string, now: number): LocalStore<Note> {
  return putRecord(notes, s, noteKey(id), now, (held, t) => {
    const base = held ?? { id, text: { val: '', t: 0 }, tags: {} }, tags = gsetAdd(base.tags, [tag], t);
    return held && tags === held.tags ? held : { ...base, tags };
  }).store;
}

/** Each note as the app shows it: id to text and tags in the order added. */
export function notesOf(s: LocalStore<Note>): Record<string, { text: string; tags: string[] }> {
  return Object.fromEntries(Object.values(s.records).map(n => [n.id, { text: n.text.val, tags: gsetList(n.tags) }]));
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
