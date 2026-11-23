# The Bluetooth backup

Tartan can back up your own Suunto watch's files over Bluetooth, for interoperability. These are
the technical notes.

The watch exposes GATT service `61353090-8231-49cc-b57a-886370740041` carrying Suunto's
"whiteboard" protocol:

```
on the air:  7E | escape(frame) | 7E                 (7E → 7D 5E, 7D → 7D 5D)
frame:       A5 | type | LE16 len | LE16 requestId | body | LE32 CRC-32
GET body:    resource[3] | client[3] | paramCount | (LE16 typeId | value)…
reply body:  resource[3] | client[3] | LE16 status (200 OK, 100 more, 404…) | value
```

A session opens with the same read-only connect handshake as the watch's own app, then lists folders (JSON)
and reads files in chunks. Tartan only ever sends HELLO, resolve and GET frames, and a test
enforces that. Full notes:
[zappctl docs/PROTOCOL.md](https://github.com/wylandplex/zappctl/blob/main/docs/PROTOCOL.md).

