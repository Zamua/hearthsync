# hearthsync

Local-first sync for browser apps and games, over a simple key-value rooms API. The app reads and writes a store on the
device and never waits on the network; when there is a connection, every record backs up to one room on a server in
the background, and other devices of the same account merge it in. There is no signup and no login: the account is a
short **code**.

- Plain TypeScript, ESM, no runtime dependencies.
- Records merge as state-based CRDTs (commutative, associative, idempotent, canonical), so devices converge whatever
  order their writes land in, and no conflict is ever shown.
- Works offline from the first launch. The first time it is online with something to save, it makes the account room.
- One tab syncs at a time (a Web Lock); every tab reloads what another wrote.

## The account code

An account is one room on the rooms server. The server picks its id, a UUIDv4. The code is that id written for people:

| | |
| --- | --- |
| Alphabet | Crockford base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U) |
| Payload | the UUID's 122 random bits after a 3-bit format number: 25 symbols |
| Checks | 2 Reed-Solomon symbols over GF(32): every single typo and every swap of two symbols is caught, never corrected |
| Shown as | 27 symbols in groups of 4: `07HW B9W9 DD9F 0N6R C3MQ 3YJJ VS3` |
| Parsing | case, spaces and dashes ignored; `O` reads 0, `I` and `L` read 1; an app's QR prefix (`NOTES1:`) is dropped |

Whoever holds the code can read and change the account, so it is shown once ("Here's your code") and kept private.
Others see only a **public id**: 64 bits of a salted hash of the room id, from which the code cannot be recovered
(`nameTag('Robin', pid)` reads `Robin #3F9A`).

Linking a second device means typing or scanning the code. Merging two accounts moves one into the other and leaves a
`forward` in the old room, which devices still on the old code follow.

## How an app plugs in

The app describes its records with a `Model`. Each record lives at its own room key (`note/<id>`, `slot/2`, `prefs`)
and has a `Kind`: how it reads from untrusted JSON, how two copies merge, and the highest stamp it carries. The
library does everything else: storage, the outbox, rounds against the server, acknowledgements, status chips, links,
merges and forwards.

```ts
import { Local, Sync, browserEnv, browserStorage, gsetFrom, gsetMerge, httpRooms, isObj, listen, lww, putRecord, regFrom, webLock } from 'hearthsync';
import type { GSet, Kind, Model, Reg } from 'hearthsync';

// A todo list: one record per list, its title last edit wins, its done items a grow-only set.
interface List { id: string; title: Reg<string>; done: GSet }

const isTitle = (x: unknown): x is string => typeof x === 'string' && x.length <= 200;

const list: Kind<List> = {
  from(raw, key) {
    const id = key.slice('list/'.length);
    if (!isObj(raw) || raw.id !== id) return null;
    return { id, title: regFrom(raw.title, isTitle) ?? { val: '', t: 0 }, done: gsetFrom(raw.done) };
  },
  merge: (a, b) => ({ id: a.id, title: lww(a.title, b.title), done: gsetMerge(a.done, b.done) }),
  stamp: r => Math.max(r.title.t, ...Object.values(r.done)),
};

const model: Model<List> = {
  prefix: 'todo.v2.',        // every localStorage key the store writes
  salt: 'todo/public/',      // public ids; never change it once accounts exist
  qrPrefix: 'TODO',          // QR text `TODO1:<code>`
  kind: key => (/^list\/[0-9a-z-]{1,40}$/.test(key) ? list : null),
};

const local = new Local(browserStorage(), model);
const rooms = httpRooms('https://rooms.example.com', { serverTime: (at, sent, recv) => local.serverTime(at, sent, recv) });
const sync = new Sync(local, rooms, browserEnv(), webLock('todo.sync'));
listen(sync, local);
sync.start();

// An edit: written to storage at once, uploaded about 15 s after edits stop.
local.edit((s, now) => putRecord(model, s, 'list/groceries', now, (held, t) => ({
  id: 'groceries', title: held?.title ?? { val: 'Groceries', t }, done: gsetMerge(held?.done ?? {}, { milk: t }),
})).store);

sync.on('news', ({ keys }) => { /* another device changed these records: re-read local.store.records */ });
sync.on('status', st => { /* st.state, st.problem, st.code, st.items['list/groceries'] ('phone' | 'waiting' | 'saved' | 'failed') */ });
```

The UI operations are `sync.peekCode(text)` (what a code holds), `sync.linkCode(text)`, `sync.mergeCode(text)` and
`sync.remakeAccount()` (after the server lost the account room). Each fails with a `SyncError` whose `kind` says why:
`offline`, `code` (with the `CodeError`), `notfound`, `notaccount`, `same`, `noaccount`, `rate`, `full`, `failed`.

### Building blocks for records

`crdt` holds registers (`Reg`, `lww`), maps of registers (`Regs`, `regsMerge`), grow-only sets that remember the order
members were added (`GSet`, `gsetAdd`, `gsetList`), and first-occurrence events with an author (`Win`, `winsMerge`).
`repair` reads each from untrusted JSON, keeping anything well formed (even ids this build does not know) and dropping
the rest. Stamps come from `tick(clock, now)`: never behind the wall clock (corrected by the server's `Date`), always
past every stamp seen, so an edit made after seeing another always wins.

### Playthroughs

A record that must never mix across playthroughs (a game's save slot: a new game is a fresh start, not a merge) gives
its kind a `play(r)` returning `{ run, game }`. Then:

- **Linking** (and following a forward) takes the account's record whole where it holds another playthrough; the
  device's own stays behind in the room it came from.
- **Merging** another code in keeps this account's record where the other holds another playthrough.
- A kind with `otherPlay: 'merge'` lets its own merge decide instead (say, the later run wins), so linking brings
  every record along and none is set aside.
- **A running session is refused once overtaken.** `putRecord(model, store, key, now, f, play)` returns
  `result: 'moved'` and changes nothing when the store now holds another playthrough at that key (linked in, followed
  in, or a new game begun on another device). Without the guard, a session of a higher run would win the merge again
  and bring its playthrough back over the one just joined. `moved(model, store, key, play)` asks the same question.

Starting over writes the record with the next `run` directly (`editRecords`), which replaces it on every device.

### Deleting, caps and the purge

A kind whose records can be deleted gives `life(r)`: when the record was last used and when it was deleted. A deleted
record stays as a tombstone (gone while `deleted > used`), so another device does not bring it back with older edits;
a later use anywhere revives it. Tombstones show no chip and upload after live records. With the model's
`purgeAfter`, tombstones that old are purged: dropped on the device and their keys deleted from the account room; a
device that finds a tombstone gone from the server (its ack was of that very doc) drops it too rather than uploading
it again, and a purged key comes back only if it was used after its tombstone. A kind's `cap` bounds how many records
it keeps, tombstones counted: a new one first purges the oldest tombstone of its kind, and is refused (`'full'`) when
there is none. A room answering `413` for a new key gives up its oldest tombstone and the PUT is tried once more.

### Keys an earlier build wrote

A kind with `home(r)` marks room keys an earlier build wrote (one save for the whole account, before there were
several): a record read there merges in at its own key, the old key is never written, and it is read again only when
it changed since it was last seen, so a record deleted since does not come back from it.

### Per-device state in the meta

An app may keep small state of its own on the device, beside its records and never synced: items seen, the last one
used. `Model.meta` (`AppMeta<A>`) maps it to fields of the store's meta key, so it is written in the same write as the
account and the clock, after any records the edit changed:

```ts
interface Here { seen: GSet; last: string | null }

const model: Model<List, Here> = {
  /* ... */
  meta: {
    read: meta => ({ seen: gsetFrom(meta.seen), last: typeof meta.last === 'string' ? meta.last : null }),
    write: h => ({ seen: h.seen, last: h.last }),
    merge: (mine, theirs) => ({ seen: gsetMerge(mine.seen, theirs.seen), last: theirs.last ?? mine.last }),
  },
};

local.edit(s => ({ ...s, app: { ...s.app, last: 'list/groceries' } }));
```

The state lives on `store.app` (undefined for a model without the hook). `read` gets the meta as storage holds it
(`{}` when there is none) and repairs it; the library's own fields win over any of the app's named the same. When
another tab has written the meta since this one last did, `merge(mine, theirs)` decides what the store holds next;
without it, the other tab's copy wins. Folds see and may set `app`, and a newer build's meta is read but never written
over.

### Migrating what an app kept before sync

A `Fold` reads keys the app wrote before it synced (a single JSON save, say) and merges them into the store, at boot
and again whenever another tab (an older build still open) writes them. The old keys are never removed, so a rollback
keeps its data, and a fold is marked done only once the store it wrote reads back from storage.

## The rooms API it expects

`httpRooms(origin)` talks to `<origin>/api/rooms`. Values are JSON documents; keys may contain `/` and travel as path
segments.

| Request | Answer |
| --- | --- |
| `POST /api/rooms` | `201` with `{ "id": "<uuidv4>" }`: a new, empty room; the server picks the id. `429` with `Retry-After` when rooms are made too fast; `507` when the app's storage is full |
| `GET /api/rooms/<room>` | `200` with every key: `{ "<key>": <value>, ... }`; `404` for no such room |
| `GET /api/rooms/<room>/<key>` | `200` with the value; `404` for no such key or room |
| `PUT /api/rooms/<room>/<key>` | body: the value; `2xx`; `404` for no such room; `413` when the room is at its cap (keys or bytes); `507` when the app's storage is full |
| `DELETE /api/rooms/<room>/<key>` | `2xx`, also for an absent key; `404` for no such room |

A malformed room id or key is `400`. Every answer carries a `Date` header (used to correct the device's clock). A query
string is ignored by the server: the library adds a unique one (`?fresh=...`) to read past an edge cache that may hold
a `404`. Rooms never expire; a `404` from the account room counts as lost only after 10 minutes of them.

How each answer is handled: network errors and `5xx` back off from 2 s, doubling to 5 minutes with jitter; `429` waits
`Retry-After` (the first one capped at 5 minutes, for one early retry); `413` stops adding keys to that room until its
next full scan while existing keys still update; `507` pauses every upload for 30 minutes; `400` drops the room from
sync. Every request gives up after 15 s as no connection.

## Local storage

Under the model's `prefix`: `meta` (account, public id, clock, forwards owed, purged keys still to delete, and the
app's own fields), `acks`
(per room and key, the hash of the doc the server was last seen holding: the outbox is derived from these, there is no
queue), and one key per record (its room key with each `/` as a `.`). A write storage refuses is not remembered as
written, so the next one tries again. Storage written by a newer build (its meta's `v` above the model's
`storeVersion`, 2 by default) is read but never written or folded over.

## Tests

```sh
npm ci
npx tsc --noEmit
npm test
```

The tests run devices against an in-memory rooms server (`hearthsync/testing`: `FakeRooms`, `TestClock`, `device`),
which answers as the contract above does, can fail any request with any status, drop connections, stall requests and
put an edge cache in front that keeps `404`s. Two example models stand in for apps: a notes app (one record per note,
deleted as tombstones, with a fold of what it kept before sync and a room key an earlier build wrote) and a puzzle app
(three save slots, each a playthrough). Alongside the scenario tests (first backup, linking, merging,
forwards and cycles, clobbered writes, offline backlogs, every error status, restarts, two tabs) are property tests:
every merge is checked for the CRDT laws over random inputs, and random histories across three devices (clobbered
writes, scoped reads, new games) must converge with nothing lost and every register the last edit made. The code
format is pinned by known-answer vectors, and SHA-256 against Web Crypto.

`hearthsync/testing` is exported so an app can test its own model the same way.

## License

MIT
