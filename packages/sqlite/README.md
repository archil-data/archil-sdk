# @archildata/sqlite

Run SQLite statements against an Archil disk through serverless execution.

```ts
import { createDatabase, getDatabase } from "@archildata/sqlite";

const db = await createDatabase(disk, "apps/app-1/main.sqlite");

const userName = "archil";

const user = await db.write<{ id: number; name: string }>`
  INSERT INTO users(name) VALUES (${userName})
  RETURNING id, name
`.get();

const users = await db.read`SELECT * FROM users WHERE name = ${userName}`.all();

const update = await db.write`
  UPDATE users SET last_seen_at = ${new Date().toISOString()} WHERE name = ${userName}
`.run();

await db.transaction([
  db.write`INSERT INTO audit_log(user_name, action) VALUES (${userName}, ${"login"})`.run(),
  db.read`SELECT * FROM users WHERE name = ${userName}`.get(),
]);

const existing = await getDatabase(disk, "apps/app-1/main.sqlite");
```

Each database is addressed by its file path on the Archil disk. `createDatabase`
creates the parent directory and initializes the file with a queued writable
root mount. `getDatabase` assumes that the
database file already exists; missing databases surface as query-time errors.

`read` and `write` create query objects. Use `get()` for one row, `all()` for all
rows, and `run()` for SQLite's write result (`changes` and `lastInsertRowid`).
The `read` or `write` tag controls the remote mount mode, so use `write` for
mutating statements, including statements with `RETURNING`.

`transaction([...])` runs query executions from `get()`, `all()`, and `run()` in
a single remote SQLite transaction. If every execution came from `read`, the
database is opened read-only; otherwise it is opened read-write.

The package always uses `disk`'s top-level multi-disk `exec({ disks, command })`
for remote execution, mounting the whole disk at `/mnt/archil/disk`. Writable
query executions request a short mount queue; nested database paths checkout the
database's parent directory so SQLite can safely create journal/WAL sidecars.
