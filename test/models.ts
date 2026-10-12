import { UNTIMED, gsetAdd, gsetList, gsetMerge, hash, isStamp, lww, lwwOpt, tick, type GSet, type Reg, type Stamp } from '../src/crdt.js';
import { playOrder, samePlay, type AppMeta, type Fold, type Kind, type Model, type Playthrough } from '../src/model.js';
import { gsetFrom, isMember, isObj, regFrom } from '../src/repair.js';
import { isRoomId } from '../src/code.js';
import { importRecords, putRecord, type LocalStore, type PutResult } from '../src/store.js';
import type { Records } from '../src/records.js';

// Four example apps for the tests. Notes: one record per note, merged field by field and deleted as a tombstone, with a
// fold of the list it kept before sync and the one note an earlier build pinned in the room; a variant also keeps the
// notes opened on this device in the store's meta. Puzzles: three save slots, each a playthrough that never mixes with
// another. Boards: each shared with friends in a room of its own, beside lists the account keeps to itself. Corkboards:
// shared like boards, but laid out in their room one key per field and per pin.

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

// Boards.

/** A board, shared with friends in a room of its own; a list, the account's alone. Deleted as tombstones. */
export interface Board { id: string; title: Reg<string>; pins: GSet; u: Stamp; deleted: Stamp }

const BOARD = /^(board|list)\/([0-9a-z-]{1,40})$/;
export const boardKey = (id: string): string => `board/${id}`;
export const listKey = (id: string): string => `list/${id}`;

const boardFrom = (raw: unknown, key: string): Board | null => {
  const id = BOARD.exec(key)?.[2];
  if (!id || !isObj(raw) || raw.id !== id) return null;
  const u = isStamp(raw.u) ? raw.u : 0, deleted = isStamp(raw.deleted) ? raw.deleted : 0;
  return { id, title: regFrom(raw.title, isText) ?? { val: '', t: 0 }, pins: gsetFrom(raw.pins), u, deleted };
};

export const listKind: Kind<Board> = {
  from: boardFrom,
  merge: (a, b) => ({ id: a.id, title: lww(a.title, b.title), pins: gsetMerge(a.pins, b.pins), u: Math.max(a.u, b.u), deleted: Math.max(a.deleted, b.deleted) }),
  stamp: r => Math.max(r.title.t, r.u, r.deleted, ...Object.values(r.pins)),
  life: r => ({ used: r.u, deleted: r.deleted }),
};

export const boardKind: Kind<Board> = { ...listKind, room: 'own', cap: 3 };

export const boards: Model<Board> = {
  prefix: 'boards.v1.',
  salt: 'boards/public/',
  purgeAfter: 30 * 24 * 3600_000,
  kind: key => (key.startsWith('board/') && BOARD.test(key) ? boardKind : key.startsWith('list/') && BOARD.test(key) ? listKind : null),
};

/** A save of a board or list at key: its title, and pins added. */
export function editBoard(s: LocalStore<Board>, key: string, now: number, o: { title?: string; pin?: string }): LocalStore<Board> {
  const id = BOARD.exec(key)![2]!;
  return putRecord(boards, s, key, now, (held, t) => {
    const base = held ?? { id, title: { val: '', t: 0 }, pins: {}, u: t, deleted: 0 };
    const title = o.title === undefined || base.title.val === o.title ? base.title : { val: o.title, t };
    const pins = o.pin === undefined ? base.pins : gsetAdd(base.pins, [o.pin], t);
    return held && title === held.title && pins === held.pins ? held : { ...base, title, pins, u: t };
  }).store;
}

export function deleteBoard(s: LocalStore<Board>, key: string, now: number): LocalStore<Board> {
  return putRecord(boards, s, key, now, (held, t) => ({ ...held!, deleted: t })).store;
}

/** Each live board or list as the app shows it: key to title and pins in the order added. */
export function boardsOf(s: { records: Records<Board> }): Record<string, { title: string; pins: string[] }> {
  return Object.fromEntries(Object.entries(s.records).filter(([, b]) => b.deleted <= b.u).map(([k, b]) => [k, { title: b.title.val, pins: gsetList(b.pins) }]));
}

/** Boards whose deleting is leaving: a member's delete keeps the board for the others. */
export const leavingBoardKind: Kind<Board> = { ...boardKind, deletes: 'account', enter: (r, t) => ({ ...r, u: t }) };
export const leavingBoards: Model<Board> = { ...boards, prefix: 'leaving.v1.', kind: key => (boards.kind(key) === boardKind ? leavingBoardKind : boards.kind(key)) };

// Corkboards.

/**
 * A corkboard: its room register kept in the record, a title, when it was made, and pins, each a key of its own in its
 * room so members pinning at once never overwrite each other. Starred pins and when it was used and left are the
 * account's own, never in the room. Deleting (left > u) is this account leaving.
 */
export interface Cork { id: string; room?: Reg<string>; title: Reg<string>; made: Stamp; u: Stamp; left: Stamp; pins: GSet; starred: GSet }

const CORK = /^cork\/([0-9a-z-]{1,40})$/;
export const corkKey = (id: string): string => `cork/${id}`;

const blankCork = (id: string): Cork => ({ id, title: { val: '', t: 0 }, made: 0, u: 0, left: 0, pins: {}, starred: {} });
const earliest = (a: Stamp, b: Stamp): Stamp => (a === 0 ? b : b === 0 ? a : Math.min(a, b));

export const corkKind: Kind<Cork> = {
  from(raw, key) {
    const id = CORK.exec(key)?.[1];
    if (!id || !isObj(raw) || raw.id !== id) return null;
    const room = regFrom(raw.room, isRoomId), st = (x: unknown) => (isStamp(x) ? x : 0);
    return { id, ...(room ? { room } : {}), title: regFrom(raw.title, isText) ?? { val: '', t: 0 }, made: st(raw.made), u: st(raw.u), left: st(raw.left), pins: gsetFrom(raw.pins), starred: gsetFrom(raw.starred) };
  },
  merge(a, b) {
    const room = lwwOpt(a.room, b.room);
    return {
      id: a.id, ...(room ? { room } : {}), title: lww(a.title, b.title), made: earliest(a.made, b.made), u: Math.max(a.u, b.u), left: Math.max(a.left, b.left),
      pins: gsetMerge(a.pins, b.pins), starred: gsetMerge(a.starred, b.starred),
    };
  },
  stamp: r => Math.max(r.title.t, r.made, r.u, r.left, r.room?.t ?? 0, ...Object.values(r.pins), ...Object.values(r.starred)),
  life: r => ({ used: r.u, deleted: r.left }),
  room: 'own',
  deletes: 'account',
  cap: 4,
  enter: (r, t) => ({ ...r, u: t }),
  register: { get: r => r.room, set: (r, room) => ({ ...r, room }) },
  layout: {
    docs(r) {
      const out: Record<string, unknown> = { id: { v: 1, id: r.id }, title: { v: 1, title: r.title } };
      if (r.made) out.made = { v: 1, at: r.made };
      for (const [p, at] of Object.entries(r.pins)) out[`pin/${p}`] = { v: 1, at };
      return out;
    },
    read(snap, key) {
      const id = CORK.exec(key)?.[1];
      if (!id || !Object.keys(snap).some(k => k === 'id' || k === 'title' || k === 'made' || k.startsWith('pin/'))) return null;
      const r = blankCork(id), title = isObj(snap.title) ? regFrom(snap.title.title, isText) : null;
      if (title) r.title = title;
      if (isObj(snap.made) && isStamp(snap.made.at)) r.made = snap.made.at;
      const pins: Record<string, Stamp> = {};
      for (const [k, v] of Object.entries(snap)) if (k.startsWith('pin/') && isMember(k.slice(4)) && isObj(v) && isStamp(v.at)) pins[k.slice(4)] = v.at;
      r.pins = gsetMerge({}, pins);
      return r;
    },
    once: key => key === 'id' || key === 'made',
    owes: r => r.u > 0,
  },
};

export const corks: Model<Cork> = {
  prefix: 'corks.v1.',
  salt: 'corks/public/',
  kind: key => (CORK.test(key) ? corkKind : null),
  roomKey: snap => (isObj(snap.id) && typeof snap.id.id === 'string' && isId(snap.id.id) ? corkKey(snap.id.id) : null),
};

/** A save of a corkboard: made if new, its title, a pin added, a pin starred. Used now either way. */
export function editCork(s: LocalStore<Cork>, id: string, now: number, o: { title?: string; pin?: string; star?: string } = {}): LocalStore<Cork> {
  return putRecord(corks, s, corkKey(id), now, (held, t) => {
    const base = held ?? { ...blankCork(id), made: t };
    const title = o.title === undefined || base.title.val === o.title ? base.title : { val: o.title, t };
    return { ...base, title, u: t, pins: o.pin ? gsetAdd(base.pins, [o.pin], t) : base.pins, starred: o.star ? gsetAdd(base.starred, [o.star], t) : base.starred };
  }).store;
}

/** This account leaves the corkboard: a tombstone of its own, the room left to the others. */
export function leaveCork(s: LocalStore<Cork>, id: string, now: number): LocalStore<Cork> {
  return putRecord(corks, s, corkKey(id), now, (held, t) => ({ ...held!, left: t })).store;
}

export const pinsOf = (s: LocalStore<Cork>, id: string): string[] => Object.keys(s.records[corkKey(id)]?.pins ?? {}).sort();
