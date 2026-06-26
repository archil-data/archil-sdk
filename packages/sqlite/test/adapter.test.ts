import { test } from "vitest";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  ArchilSQLiteError,
  createSQLiteAdapter,
  type SQLiteExec,
  type SQLiteExecOptions,
  type SQLiteExecResult,
} from "../src/adapter.js";

type TestExec = SQLiteExec;
type ExecOptions = SQLiteExecOptions;
type ExecResult = SQLiteExecResult;

type WireValue =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bigint"; value: string }
  | { type: "bytes"; value: string }
  | { type: "array"; value: WireValue[] }
  | { type: "object"; value: Record<string, WireValue> };

type RemotePayload = {
  databasePath: string;
  readOnly: boolean;
  transaction: boolean;
  operations: Array<{
    kind: "read" | "write";
    method: "get" | "all" | "run";
    sql: string;
    params: WireValue[];
  }>;
};

const resultPrefix = "ARCHIL_SQLITE_RESULT:";

function encodeWireValue(value: unknown): WireValue {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) {
    return { type: "bytes", value: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return { type: "array", value: value.map(encodeWireValue) };
  if (typeof value !== "object") {
    throw new TypeError(`unsupported SQLite test value type: ${typeof value}`);
  }
  return {
    type: "object",
    value: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeWireValue(entry)])),
  };
}

function stdoutFor(value: unknown): string {
  const payload = { ok: true, result: encodeWireValue(value) };
  return `${resultPrefix}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}\n`;
}

function failureStdout(error: { message: string; code?: string | number }): string {
  const payload = { ok: false, error };
  return `${resultPrefix}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}\n`;
}

function execResult(value: unknown): ExecResult {
  return {
    exitCode: 0,
    stdout: stdoutFor(value),
    stderr: "",
    timing: { totalMs: 1, queueMs: 0, executeMs: 1 },
  };
}

function payloadFromCommand(command: string): RemotePayload {
  const match = command.match(/ '([A-Za-z0-9+/=]+)'$/);
  assert.ok(match, `expected base64 payload at end of command: ${command}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as RemotePayload;
}

function wireDisks(disks: ExecOptions["disks"]): ExecOptions["disks"] {
  return JSON.parse(JSON.stringify(disks)) as ExecOptions["disks"];
}

test("getDatabase defers exec until query method and passes mount intent", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult(calls.length === 1 ? [{ id: 7, name: "Ada" }] : { changes: 1, lastInsertRowid: 7 });
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  const readQuery = db.read`SELECT * FROM users WHERE id = ${7}`;
  const writeQuery = db.write`INSERT INTO users(id, name) VALUES (${7}, ${"Ada"})`;
  assert.equal(calls.length, 0);

  const rows = await readQuery.all();
  const write = await writeQuery.run();
  const readPayload = payloadFromCommand(calls[0].command);
  const writePayload = payloadFromCommand(calls[1].command);

  assert.deepEqual(rows, [{ id: 7, name: "Ada" }]);
  assert.deepEqual(write, { changes: 1, lastInsertRowid: 7 });
  assert.equal(readPayload.databasePath, "/mnt/archil/disk/apps/app-1/main.sqlite");
  assert.deepEqual(readPayload.operations[0], {
    kind: "read",
    method: "all",
    sql: "SELECT * FROM users WHERE id = ?",
    params: [{ type: "number", value: 7 }],
  });
  assert.equal(writePayload.databasePath, "/mnt/archil/disk/apps/app-1/main.sqlite");
  assert.deepEqual(writePayload.operations[0], {
    kind: "write",
    method: "run",
    sql: "INSERT INTO users(id, name) VALUES (?, ?)",
    params: [
      { type: "number", value: 7 },
      { type: "string", value: "Ada" },
    ],
  });
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: { disk: "dsk-1", readOnly: true },
  });
  assert.deepEqual(wireDisks(calls[1].disks), {
    disk: {
      disk: "dsk-1",
      readOnly: false,
      checkoutPaths: ["apps/app-1"],
      queueMs: 5000,
    },
  });
});

test("get and write returning use the requested SQLite statement method", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult(calls.length === 1 ? { id: 7, name: "Ada" } : { id: 8, name: "Grace" });
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  const readRow = await db.read`SELECT * FROM users WHERE id = ${7}`.get();
  const inserted = await db.write`INSERT INTO users(name) VALUES (${"Grace"}) RETURNING id, name`.get();

  assert.deepEqual(readRow, { id: 7, name: "Ada" });
  assert.deepEqual(inserted, { id: 8, name: "Grace" });
  assert.equal(payloadFromCommand(calls[0].command).operations[0].method, "get");
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: { disk: "dsk-1", readOnly: true },
  });
  assert.deepEqual(payloadFromCommand(calls[1].command).operations[0], {
    kind: "write",
    method: "get",
    sql: "INSERT INTO users(name) VALUES (?) RETURNING id, name",
    params: [{ type: "string", value: "Grace" }],
  });
  assert.deepEqual(wireDisks(calls[1].disks), {
    disk: {
      disk: "dsk-1",
      readOnly: false,
      checkoutPaths: ["apps/app-1"],
      queueMs: 5000,
    },
  });
});

test("get returns undefined when SQLite finds no row", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult(undefined);
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  const row = await db.read`SELECT * FROM users WHERE id = ${404}`.get();

  assert.equal(row, undefined);
  assert.deepEqual(payloadFromCommand(calls[0].command).operations[0], {
    kind: "read",
    method: "get",
    sql: "SELECT * FROM users WHERE id = ?",
    params: [{ type: "number", value: 404 }],
  });
});

test("transaction batches query executions into one write execution", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult([
      { changes: 1, lastInsertRowid: 1 },
      { id: 1, payload: new Uint8Array([1, 2, 3]) },
    ]);
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  const result = await db.transaction([
    db.write`INSERT INTO files(payload) VALUES (${new Uint8Array([1, 2, 3])})`.run(),
    db.write`UPDATE files SET payload = ${new Uint8Array([1, 2, 3])} WHERE id = ${1} RETURNING id, payload`.get(),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(payloadFromCommand(calls[0].command).operations.map((op) => [op.kind, op.method]), [
    ["write", "run"],
    ["write", "get"],
  ]);
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: {
      disk: "dsk-1",
      readOnly: false,
      checkoutPaths: ["apps/app-1"],
      queueMs: 5000,
    },
  });
  assert.deepEqual(result, [
    { changes: 1, lastInsertRowid: 1 },
    { id: 1, payload: new Uint8Array([1, 2, 3]) },
  ]);
});

test("transaction claims operation promises so awaiting them does not re-run SQL", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult([{ changes: 1, lastInsertRowid: 9 }]);
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");
  const operation = db.write`INSERT INTO users(name) VALUES (${"Ada"})`.run();

  const [transactionResult, operationResult] = await Promise.all([
    db.transaction([operation]),
    operation,
  ]);
  const laterOperationResult = await operation;

  assert.equal(calls.length, 1);
  assert.deepEqual(payloadFromCommand(calls[0].command).operations.map((op) => [op.kind, op.method]), [
    ["write", "run"],
  ]);
  assert.deepEqual(transactionResult, [{ changes: 1, lastInsertRowid: 9 }]);
  assert.deepEqual(operationResult, { changes: 1, lastInsertRowid: 9 });
  assert.deepEqual(laterOperationResult, { changes: 1, lastInsertRowid: 9 });
});

test("read-only transactions keep the readonly execution intent", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult([[{ count: 2 }], { id: 1 }]);
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  const result = await db.transaction([
    db.read`SELECT count(*) AS count FROM users`.all(),
    db.read`SELECT id FROM users ORDER BY id LIMIT ${1}`.get(),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(payloadFromCommand(calls[0].command).operations.map((op) => [op.kind, op.method]), [
    ["read", "all"],
    ["read", "get"],
  ]);
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: { disk: "dsk-1", readOnly: true },
  });
  assert.deepEqual(result, [[{ count: 2 }], { id: 1 }]);
});

test("createDatabase initializes with a queued writable root mount", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult(null);
  };
  const { createDatabase } = createSQLiteAdapter(exec);

  await createDatabase(disk, "/apps/app-1/main.sqlite");

  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^mkdir -p /);
  assert.match(calls[0].command, /apps\/app-1/);
  assert.match(calls[0].command, /main\.sqlite/);
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: { disk: "dsk-1", readOnly: false, queueMs: 5000 },
  });
});

test("root database paths use root mounts", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return execResult({ changes: 1, lastInsertRowid: 1 });
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "main.sqlite");

  await db.write`INSERT INTO logs(message) VALUES (${"root"})`.run();

  assert.equal(calls.length, 1);
  assert.equal(payloadFromCommand(calls[0].command).databasePath, "/mnt/archil/disk/main.sqlite");
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: { disk: "dsk-1", readOnly: false, queueMs: 5000 },
  });
});

test("querying a missing database surfaces the remote invariant error", async () => {
  const calls: ExecOptions[] = [];
  const disk = { id: "dsk-1" };
  const exec: TestExec = async (opts) => {
    calls.push(opts);
    return {
      exitCode: 0,
      stdout: failureStdout({
        message: "SQLite database does not exist at apps/app-1/main.sqlite",
        code: "SQLITE_DATABASE_NOT_FOUND",
      }),
      stderr: "",
      timing: { totalMs: 1, queueMs: 0, executeMs: 1 },
    };
  };
  const { getDatabase } = createSQLiteAdapter(exec);
  const db = await getDatabase(disk, "apps/app-1/main.sqlite");

  await assert.rejects(
    () => db.write`INSERT INTO logs(message) VALUES (${"missing"})`.run().execute(),
    (err: unknown) => {
      assert.ok(err instanceof ArchilSQLiteError);
      assert.equal(err.message, "SQLite database does not exist at apps/app-1/main.sqlite");
      assert.equal(err.code, "SQLITE_DATABASE_NOT_FOUND");
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(wireDisks(calls[0].disks), {
    disk: {
      disk: "dsk-1",
      readOnly: false,
      checkoutPaths: ["apps/app-1"],
      queueMs: 5000,
    },
  });
});
