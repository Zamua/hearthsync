# Changelog

## 0.4.0

Added:

- `AccountKind` and `SharedKind`, the two halves of `Kind`.

Changed:

- `Kind` is `AccountKind | SharedKind`, so `layout`, `deletes`, `enter` and `register`, which only a shared record
  reads, type-check only beside `room: 'own'` instead of being ignored without it. A kind spread from a value typed
  `Kind` and given one of them must spread from a `SharedKind`, or say `room: 'own'` itself.
- A model's `kind` is never asked about `meta` or `acks` either: a record at either key was kept in local storage under
  the store's own meta or acks.

## 0.3.1

Fixed:

- Two shares of one record at once made two rooms, and the record kept only the later one. A second share now waits on
  the first, and a share whose POST was out while another tab shared the record keeps that tab's room.
- `httpRooms` took a scan answered with something other than a JSON object (a captive portal's page) for an empty
  room, and a PUT or DELETE answered with a body for a landed write. Both are now `RoomError(502)`.

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
- The account room's `shared` doc is written as format 2 while it lists a leave. A share made meanwhile on a 0.2 device
  never reaches it, so the account's 0.3 devices do not learn of that room.

Upgrading: a 0.2 device on the same account ignores layouts, leaves and `deletes: 'account'` (see "Older builds on the
same account" in the README). Give a model whose kinds adopt any of them a new `Model.version`.

## 0.2.0

Shared rooms joined by invite, app state in the store's meta, tombstones, caps, the purge and keys an earlier build
wrote.

## 0.1.0

First release.
