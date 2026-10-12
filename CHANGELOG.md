# Changelog

## 0.3.0

Added:

- `Kind.layout` (`RoomLayout`: `docs`, `read`, `once`, `owes`) lays a shared record out over several keys of its room,
  and `Model.roomKey(snapshot, room)` finds the record in such a room for `peek` and `join`.
- `Kind.register` keeps a shared record's room register in the record itself; `isPlace` reads one.
- `Sync.leave(key)` stops sharing a record without deleting it; `Kind.deletes: 'account'` makes deleting a whole
  record this account leaving; `Kind.enter` marks a join as a use. `LEFT`, `leaveRoom`, `placed`, `roomOf`.
- `Sync.attach(room, feed)` and `Sync.fed(room)` read a shared room from an app's live copy; `Sync.hold(on)` defers the
  account room's rounds.
- `chips(m, s, skip)`: a laid out record waits until its keys are in its room too.

Changed:

- `followRoom` takes the model first, as the other store functions do: `followRoom(m, s, from, to, now)`.
- The account room's `shared` doc is written as format 2 while it lists a leave.

Upgrading: a 0.2 device on the same account ignores layouts, leaves and `deletes: 'account'` (see "Older builds on the
same account" in the README). Give a model whose kinds adopt any of them a new `Model.version`.

## 0.2.0

Shared rooms joined by invite, app state in the store's meta, tombstones, caps, the purge and keys an earlier build
wrote.

## 0.1.0

First release.
