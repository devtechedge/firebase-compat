# Realtime Database: observed wire behaviour

Status: implemented. Conformance: 20/20 cases match the Database Emulator.

## Evidence

| Artifact | SHA-256 (prefix) | REA evidence |
| --- | --- | --- |
| `evidence/raw/emulator-database.har` | `a5d373f76c18cbe6` | `har-database` |
| `evidence/rea/har-database.json.gz` | `68e17f5f30ec4395` | `har-database` |
| `evidence/rea/js-database.json.gz` | `b2c50d41ee3b1d22` | `js-database` |

## Transport

WebSocket at `/.ws?v=5&ns=<namespace>` (long polling `/.lp` is not implemented; the SDK falls back only if WebSocket fails). Frames are JSON, optionally split by a leading frame count.

- Server hello: `{"t":"c","d":{"t":"h","d":{"ts":<ms>,"v":"5","h":"<host>","s":"<session>"}}}`.
- Client requests: `{"t":"d","d":{"r":<id>,"a":"<action>","b":{...}}}`; replies `{"t":"d","d":{"r":<id>,"b":{"s":"ok","d":...}}}`.
- Actions: `s` (stats), `q` (listen), `n` (unlisten), `p` (set), `m` (merge/update), `g` (get), `auth`, `gauth`, `unauth`, `o`/`om`/`oc` (onDisconnect set, merge, cancel).
- Server pushes: `{"t":"d","d":{"a":"d","b":{"p":"<path>","d":<data>,"t":<tag?>}}}` for sets and `"a":"m"` for merges.
- Transactions use `p` with a `h` field: the SHA-1 hash of the current node. A mismatch returns `{"s":"datastale","d":<current>}` and the SDK retries.

## Node hash

The hash is base64 SHA-1 over the node serialisation: leaves as `number:<IEEE754 hex>` / `string:<v>` / `boolean:<v>`, with an optional `priority:` prefix; children sorted by key with `:` separators. Verified against captured values, for example the leaf `1` hashes to `YPVfR2bXt/lcDjiQZ8pOkAd3qkQ=`.

## Queries

`orderByChild`, `orderByKey`, `orderByValue`, `orderByPriority`, `startAt`, `startAfter`, `endAt`, `endBefore`, `equalTo`, `limitToFirst`, `limitToLast`, using the documented RTDB ordering (null, false, true, numbers, strings, objects; keys that look like 32-bit integers sort numerically). Queried listens are tagged (`t`) so the SDK routes updates to the right view.

## Other

- `ServerValue.TIMESTAMP` (`{".sv":"timestamp"}`) and `increment` (`{".sv":{"increment":n}}`).
- REST: `GET/PUT/PATCH/POST/DELETE /<path>.json?ns=...` for tooling and the dashboard.

## Quirks

- The emulator rejects unindexed `get()` on queries without `.indexOn`; we serve them. The conformance case uses `onValue(..., {onlyOnce:true})` to compare like for like.
- Empty objects are removed; setting `{}` deletes the node.

## Unknowns / not implemented

- Security rules for RTDB (all reads and writes allowed), long polling transport, multiple namespaces beyond routing by `ns`.
